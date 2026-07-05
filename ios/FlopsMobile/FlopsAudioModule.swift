//
//  FlopsAudioModule.swift
//  FlopsMobile
//
//  TTS 语音播放原生模块（进程级单例播放引擎，独立于任何 RN 页面生命周期）。
//
//  设计要点（见 docs/tts-audio-playback-design.md）：
//   - 用 AVQueuePlayer 顺序连播一条 assistant 消息的多个 mp3 segment（服务端已合成好的 COS URL）。
//   - 自持 AVAudioSession（.playback + spokenAudio），配合 Info.plist 的 UIBackgroundModes=audio，
//     实现切页 / 切 App / 锁屏后继续播放。与 react-native-audio-api（ASR 录音用 playAndRecord）
//     共用同一个 sharedInstance，靠"录音/播放互斥 + 谁最后 setCategory 谁生效"协调。
//   - MPNowPlayingInfoCenter + MPRemoteCommandCenter 提供锁屏 / 控制中心的标题·进度·播放控件。
//   - 监听中断（来电等）与路由变化（拔耳机）自动暂停 / 恢复。
//
//  JS 侧包装见 src/audio/ttsPlayer.ts；事件通过 NativeEventEmitter(NativeModules.FlopsAudio) 回流。
//

import Foundation
import React
import AVFoundation
import MediaPlayer

@objc(FlopsAudio)
class FlopsAudioModule: RCTEventEmitter {

  // MARK: - 状态

  private var player: AVQueuePlayer?
  /// 当前队列的 AVPlayerItem（从 baseIndex 起）；用结束通知里的 item→下标定位当前段。
  private var items: [AVPlayerItem] = []
  /// 当前整条消息的全部 segment URL（真值来源；AVPlayerItem 播完不可复用，切段时按此重建队列）
  private var urls: [String] = []
  /// 当前队列里第 0 个 item 对应的 urls 下标（自然连播时 currentIndex = baseIndex + 队列内偏移）
  private var baseIndex: Int = 0
  private var currentIndex: Int = 0
  /// 一条消息的稳定标识（ChatScreen 的 stableKey），供 JS 判定"在播的是不是这条消息"
  private var currentKey: String = ""

  private var timeObserver: Any?
  private var hasListeners = false
  private var commandsWired = false
  private var lastReportedState = ""

  // MARK: - RCTEventEmitter 约定

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  /// AVFoundation / MPRemoteCommandCenter 都要求主线程；所有导出方法直接跑主队列，省去内部 dispatch。
  override var methodQueue: DispatchQueue {
    return DispatchQueue.main
  }

  override func supportedEvents() -> [String]! {
    return ["onAudioState", "onAudioProgress"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - 导出方法（JS 调用）

  /// 从头播放一条消息的 segment 列表。segments 为完整 mp3 URL（非加密对话）。
  @objc(loadAndPlay:meta:resolver:rejecter:)
  func loadAndPlay(_ segments: [String],
                   meta: [String: Any],
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    let cleaned = segments.compactMap { $0.isEmpty ? nil : $0 }
    guard !cleaned.isEmpty else {
      reject("no_segments", "empty segments", nil)
      return
    }
    self.urls = cleaned
    self.currentKey = (meta["key"] as? String) ?? ""
    self.nowPlayingTitle = (meta["title"] as? String) ?? "Flops 语音"
    self.nowPlayingSubtitle = (meta["subtitle"] as? String) ?? "Flops"

    configureSession(active: true)
    wireRemoteCommandsIfNeeded()
    emitState("loading")
    buildQueue(from: 0)
    resolve(nil)
  }

  @objc(play:rejecter:)
  func play(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard player != nil else { resolve(nil); return }
    configureSession(active: true)
    player?.play()
    resolve(nil)
  }

  @objc(pause:rejecter:)
  func pause(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    player?.pause()
    resolve(nil)
  }

  @objc(stop:rejecter:)
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    teardown()
    emitState("idle")
    configureSession(active: false)
    clearNowPlaying()
    resolve(nil)
  }

  /// 跳到本消息的第 index 段（供 UI / 锁屏切段）。越界则忽略。
  @objc(playIndex:resolver:rejecter:)
  func playIndex(_ index: NSNumber,
                 resolver resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    let i = index.intValue
    guard i >= 0, i < urls.count else { resolve(nil); return }
    configureSession(active: true)
    buildQueue(from: i)
    resolve(nil)
  }

  /// JS 挂载时对齐一次当前快照（可能 app 已在后台播着别的消息）。
  @objc(getState:rejecter:)
  func getState(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve([
      "state": currentStateString(),
      "key": currentKey,
      "index": currentIndex,
      "count": urls.count,
    ])
  }

  // MARK: - 队列构建 / 拆除

  private func buildQueue(from startIndex: Int) {
    teardown(keepSessionAndCommands: true)
    baseIndex = startIndex
    currentIndex = startIndex
    let built = urls[startIndex...].compactMap { urlStr -> AVPlayerItem? in
      guard let u = URL(string: urlStr) else { return nil }
      return AVPlayerItem(url: u)
    }
    guard !built.isEmpty else { emitState("error", error: "bad_url"); return }
    self.items = built

    let queue = AVQueuePlayer(items: built)
    queue.actionAtItemEnd = .advance
    self.player = queue

    // 播放/暂停/缓冲状态 → 回流 JS + 刷新 nowplaying
    queue.addObserver(self, forKeyPath: "timeControlStatus", options: [.new], context: nil)

    // 进度 0.5s 一跳
    let interval = CMTime(seconds: 0.5, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    timeObserver = queue.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
      self?.emitProgress()
      self?.refreshNowPlayingElapsed()
    }

    // 每段播完（含最后一段）：AVQueuePlayer 消费后 items() 会收缩，无法靠 currentItem 定位，
    // 故用结束通知里的 item 反查绝对下标推进 currentIndex；最后一段结束即 ended。
    // object: nil 收所有播放器的结束事件，用 items.firstIndex 过滤掉非本模块的 item。
    NotificationCenter.default.addObserver(
      self, selector: #selector(onItemEnded(_:)),
      name: .AVPlayerItemDidPlayToEndTime, object: nil)

    refreshNowPlaying()
    queue.play()
  }

  private func teardown(keepSessionAndCommands: Bool = false) {
    if let obs = timeObserver { player?.removeTimeObserver(obs); timeObserver = nil }
    if let p = player {
      p.removeObserver(self, forKeyPath: "timeControlStatus")
      p.pause()
    }
    NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
    player = nil
    items = []
    if !keepSessionAndCommands {
      urls = []
      currentKey = ""
      currentIndex = 0
      baseIndex = 0
    }
  }

  // MARK: - KVO / 结束回调

  override func observeValue(forKeyPath keyPath: String?,
                             of object: Any?,
                             change: [NSKeyValueChangeKey: Any]?,
                             context: UnsafeMutableRawPointer?) {
    guard let p = player else { return }
    if keyPath == "timeControlStatus" {
      // 队列播完 currentItem 变 nil、status 转 paused —— 别用 paused 覆盖已发出的 ended。
      if p.currentItem == nil { return }
      emitState(currentStateString())
      refreshNowPlaying()
    }
  }

  @objc private func onItemEnded(_ note: Notification) {
    guard let item = note.object as? AVPlayerItem,
          let local = items.firstIndex(of: item) else { return }  // 过滤非本模块的播放器
    if local >= items.count - 1 {
      // 最后一段自然播完
      emitState("ended")
      clearNowPlaying()
      configureSession(active: false)
    } else {
      currentIndex = baseIndex + local + 1
      refreshNowPlaying()
      emitState(currentStateString())
    }
  }

  // MARK: - 事件回流

  private func currentStateString() -> String {
    guard let p = player else { return "idle" }
    switch p.timeControlStatus {
    case .playing: return "playing"
    case .paused: return "paused"
    case .waitingToPlayAtSpecifiedRate: return "loading"
    @unknown default: return "idle"
    }
  }

  private func emitState(_ state: String, error: String? = nil) {
    lastReportedState = state
    guard hasListeners else { return }
    var body: [String: Any] = [
      "state": state,
      "key": currentKey,
      "index": currentIndex,
      "count": urls.count,
    ]
    if let error = error { body["error"] = error }
    sendEvent(withName: "onAudioState", body: body)
  }

  private func emitProgress() {
    guard hasListeners, let item = player?.currentItem else { return }
    let pos = CMTimeGetSeconds(item.currentTime())
    let dur = CMTimeGetSeconds(item.duration)
    sendEvent(withName: "onAudioProgress", body: [
      "key": currentKey,
      "index": currentIndex,
      "position": pos.isFinite ? pos : 0,
      "duration": dur.isFinite ? dur : 0,
    ])
  }

  // MARK: - AVAudioSession（Phase 1）

  private var interruptionsWired = false

  private func configureSession(active: Bool) {
    let session = AVAudioSession.sharedInstance()
    do {
      if active {
        try session.setCategory(.playback, mode: .spokenAudio, options: [])
        try session.setActive(true)
        wireInterruptionsIfNeeded()
      } else {
        try session.setActive(false, options: [.notifyOthersOnDeactivation])
      }
    } catch {
      NSLog("[FlopsAudio] session error: %@", error.localizedDescription)
    }
  }

  private func wireInterruptionsIfNeeded() {
    guard !interruptionsWired else { return }
    interruptionsWired = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(onInterruption(_:)),
      name: AVAudioSession.interruptionNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(onRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification, object: nil)
  }

  @objc private func onInterruption(_ note: Notification) {
    guard let info = note.userInfo,
          let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    switch type {
    case .began:
      player?.pause()
    case .ended:
      if let optRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt {
        let opts = AVAudioSession.InterruptionOptions(rawValue: optRaw)
        if opts.contains(.shouldResume) {
          configureSession(active: true)
          player?.play()
        }
      }
    @unknown default: break
    }
  }

  @objc private func onRouteChange(_ note: Notification) {
    guard let info = note.userInfo,
          let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
    // 拔耳机 / 断开蓝牙：暂停，避免声音突然外放
    if reason == .oldDeviceUnavailable {
      player?.pause()
    }
  }

  // MARK: - 锁屏 / 控制中心（Phase 1）

  private var nowPlayingTitle = "Flops 语音"
  private var nowPlayingSubtitle = "Flops"

  private func wireRemoteCommandsIfNeeded() {
    guard !commandsWired else { return }
    commandsWired = true
    let cc = MPRemoteCommandCenter.shared()
    cc.playCommand.addTarget { [weak self] _ in
      self?.configureSession(active: true); self?.player?.play(); return .success
    }
    cc.pauseCommand.addTarget { [weak self] _ in
      self?.player?.pause(); return .success
    }
    cc.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self = self, let p = self.player else { return .commandFailed }
      if p.timeControlStatus == .playing { p.pause() } else { self.configureSession(active: true); p.play() }
      return .success
    }
    cc.nextTrackCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      let n = self.currentIndex + 1
      guard n < self.urls.count else { return .noSuchContent }
      self.buildQueue(from: n); return .success
    }
    cc.previousTrackCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      let n = self.currentIndex - 1
      guard n >= 0 else { return .noSuchContent }
      self.buildQueue(from: n); return .success
    }
  }

  private func refreshNowPlaying() {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: nowPlayingTitle,
      MPMediaItemPropertyArtist: nowPlayingSubtitle,
      MPNowPlayingInfoPropertyPlaybackQueueCount: urls.count,
      MPNowPlayingInfoPropertyPlaybackQueueIndex: currentIndex,
    ]
    if let item = player?.currentItem {
      let dur = CMTimeGetSeconds(item.duration)
      let pos = CMTimeGetSeconds(item.currentTime())
      if dur.isFinite { info[MPMediaItemPropertyPlaybackDuration] = dur }
      if pos.isFinite { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = pos }
    }
    info[MPNowPlayingInfoPropertyPlaybackRate] = (player?.timeControlStatus == .playing) ? 1.0 : 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func refreshNowPlayingElapsed() {
    guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo,
          let item = player?.currentItem else { return }
    let pos = CMTimeGetSeconds(item.currentTime())
    if pos.isFinite { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = pos }
    info[MPNowPlayingInfoPropertyPlaybackRate] = (player?.timeControlStatus == .playing) ? 1.0 : 0.0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func clearNowPlaying() {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }
}
