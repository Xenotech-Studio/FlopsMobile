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
import AVKit
import MediaPlayer
import UIKit

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

  /// 与其它 App 的混音方式（由 JS 从 layout-preferences 的 tts_mixing_mode 下发）：
  /// "duck" → .duckOthers（降低他人音量，默认）；"mix" → .mixWithOthers（直接叠加）。
  /// duck 只在「真正出声」时生效（configureSession(active:audible:)）：回放在播、或实时流的
  /// speak_start→尾音播完窗口内；其余时间（如 WS 空闲保活）一律 mix，不压他人。
  private var audioMixingMode: String = "duck"

  // MARK: - 实时流式 TTS 状态（/api/ws/audio → PCM）
  private var wsTask: URLSessionWebSocketTask?
  private var wsSession: URLSession?
  private var wsUrlString: String = ""
  private var realtimeMode: String = "single"  // "broadcast" | "single"
  private var shouldStreamConnect = false
  private var reconnectAttempt = 0
  private let engine = AVAudioEngine()
  private let playerNode = AVAudioPlayerNode()
  private var engineWired = false
  private var engineStarted = false
  /// 后端固定 24kHz s16le mono；引擎侧统一转 Float32（引擎原生偏好）。
  private let streamFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
  private var streamRunId = ""
  private var byteCarry: UInt8?
  /// WS 保活心跳定时器：连上后每 20s sendPing 一次（探活 + 制造上行流量，避免 URLSession
  /// 默认 60s 请求超时把"只收不发"的空闲连接判死）。与 Android 侧 OkHttp pingInterval(20s) 对齐。
  private var wsKeepAliveTimer: DispatchSourceTimer?

  // MARK: - RCTEventEmitter 约定

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  /// AVFoundation / MPRemoteCommandCenter 都要求主线程；所有导出方法直接跑主队列，省去内部 dispatch。
  override var methodQueue: DispatchQueue {
    return DispatchQueue.main
  }

  override func supportedEvents() -> [String]! {
    return ["onAudioState", "onAudioProgress", "onRealtimeState", "onAudioSaved"]
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
    // 与实时朗读互斥：开始回放前冲掉实时流已排队的 PCM，避免叠音
    if engineStarted { flushRealtimePlayback() }
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
    releaseAfterReplay()
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

  /// 设置与其它 App 的混音方式："duck"（降低他人音量，默认）| "mix"（直接叠加）。
  /// 只写内部变量；下次 configureSession(active:) 生效。若当前正在放（回放或实时流），
  /// 立即重设 category 让新选项即时生效。fire-and-forget，无回调。
  @objc(setAudioMixingMode:)
  func setAudioMixingMode(_ mode: String) {
    audioMixingMode = (mode == "mix") ? "mix" : "duck"
    if player?.timeControlStatus == .playing || engineStarted {
      configureSession(active: true,
                       audible: player?.timeControlStatus == .playing || realtimeSpeaking)
    }
  }

  /// 录音期间保持屏幕常亮（听写可能一说几分钟，别让自动锁屏打断）。isIdleTimerDisabled
  /// 仅前台生效，app 切后台系统自动恢复正常锁屏，不会后台烧屏；幂等。
  /// voiceDictationMobile 在录音 start 开、stop/cancel/teardown 关。methodQueue 已是主线程。
  @objc(setKeepScreenOn:resolver:rejecter:)
  func setKeepScreenOn(_ on: Bool,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    UIApplication.shared.isIdleTimerDisabled = on
    resolve(nil)
  }

  // MARK: - 播报模式 Live Activity（灵动岛 / 锁屏）
  //
  // 播报模式全局单例，JS 侧 setBroadcastMode(true/false) 的收敛处调这两个方法（见
  // src/audio/ttsRealtime.ts）。ActivityKit 需 iOS 16.1+，用 #available 兜底，低版本 no-op。
  // fire-and-forget（无 resolver），与 setAudioMixingMode 同一风格。UI 见 WidgetExtension 侧
  // FlopsBroadcastLiveActivity；管理在 FlopsActivityManager。

  /// 开启播报 Live Activity（进入播报模式）。
  @objc(startLiveActivity)
  func startLiveActivity() {
    if #available(iOS 16.1, *) { FlopsActivityManager.start() }
  }

  /// 结束播报 Live Activity（退出播报模式）。
  @objc(endLiveActivity)
  func endLiveActivity() {
    if #available(iOS 16.1, *) { FlopsActivityManager.end() }
  }

  /// 把会话统计（正在进行 / 已完成待处理）同步给播报 Live Activity（灵动岛 expanded / 锁屏横幅）。
  /// JS 侧 reportBroadcastStats 调（数据来自 inbox SSE 的 runningMap / unreadMap）。合并式 update，
  /// 不动 isActive；无活动时 no-op。fire-and-forget。
  /// 同 updateBroadcastActivity：派发到主线程，因为 FlopsActivityManager.update 标了 @MainActor。
  @objc(updateLiveActivityStats:pending:)
  func updateLiveActivityStats(_ activeCount: NSNumber, pending pendingCount: NSNumber) {
    DispatchQueue.main.async {
      if #available(iOS 16.1, *) {
        FlopsActivityManager.update(activeCount: activeCount.intValue,
                                    pendingCount: pendingCount.intValue)
      }
    }
  }

  /// 把"是否正在朗读"同步给 Live Activity（灵动岛紧凑态波形 / 锁屏副标题）。无活动时 no-op，
  /// 故非播报模式（未 start 过活动）的实时流也可安全调用。合并式 update，不动会话统计。
  /// WS 事件可能来自任意线程——派发到主线程，因为 FlopsActivityManager.update 标了 @MainActor。
  private func updateBroadcastActivity(active: Bool) {
    DispatchQueue.main.async {
      if #available(iOS 16.1, *) {
        FlopsActivityManager.update(isActive: active)
      }
    }
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
      releaseAfterReplay()
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
  /// 本模块是否激活过 session（未激活时跳过 setActive(false)，别去动 ASR 等别人激活的 session）。
  private var sessionActive = false

  /// audible=true：真要出声（回放播放 / 实时朗读窗口），按用户偏好 duck 或 mix；
  /// audible=false：仅保活（WS 连着但没在朗读），一律 mix，不压低其它 App。
  private func configureSession(active: Bool, audible: Bool = true) {
    let session = AVAudioSession.sharedInstance()
    do {
      if active {
        // 与其它 App 共存：duck（降他人音量）| mix（直接叠加）。绝不裸 .playback 独占暂停。
        let options: AVAudioSession.CategoryOptions =
          (audioMixingMode == "mix" || !audible) ? [.mixWithOthers] : [.duckOthers]
        try session.setCategory(.playback, mode: .spokenAudio, options: options)
        try session.setActive(true)
        sessionActive = true
        wireInterruptionsIfNeeded()
      } else {
        guard sessionActive else { return }
        try session.setActive(false, options: [.notifyOthersOnDeactivation])
        sessionActive = false
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
      if engineStarted { engine.pause() }
    case .ended:
      if let optRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt {
        let opts = AVAudioSession.InterruptionOptions(rawValue: optRaw)
        if opts.contains(.shouldResume) {
          configureSession(active: true, audible: realtimeSpeaking || player != nil)
          player?.play()
          if engineStarted { try? engine.start(); playerNode.play() }
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

  // ==================================================================
  // MARK: - 实时流式 TTS（/api/ws/audio → PCM，边生边朗读）
  //   见 docs/tts-realtime-streaming-design.md。WS 与 PCM 播放全在原生，
  //   JS 只传已拼好鉴权的 wsUrl + 开关。与回放 AVQueuePlayer 共用同一
  //   AVAudioSession（.playback + audio 后台模式）→ 后台/锁屏也朗读。
  //   session 分两态：空闲保活（mix，引擎渲染静音维持后台存活、不压他人音量）
  //   与朗读窗口（speak_start→尾音播完，按偏好 duck）；切换见「朗读窗口」一节。
  // ==================================================================

  /// 连接（或按新 URL 重连）实时音频 WS。wsUrl 已含鉴权（JS 侧拼好）。
  /// mode="broadcast" → 连的是 /api/ws/audio/global，连上要发 register 声明身份；
  /// mode="single"    → 连的是 /api/ws/audio?conversation_id=X&client=mobile，纯下行、无需 register。
  /// 两种模式 Mobile 都**播放收到的全部 PCM**（该收什么由后端优先级裁决决定，客户端不再过滤）。
  @objc(startRealtime:mode:resolver:rejecter:)
  func startRealtime(_ wsUrl: String,
                     mode: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard !wsUrl.isEmpty, let url = URL(string: wsUrl) else {
      reject("bad_ws_url", "invalid ws url", nil); return
    }
    // 已连同一 URL+模式：幂等忽略
    if shouldStreamConnect, wsUrl == wsUrlString, mode == realtimeMode, wsTask != nil {
      resolve(nil); return
    }
    wsUrlString = wsUrl
    realtimeMode = mode
    shouldStreamConnect = true
    reconnectAttempt = 0
    // 连上 WS ≠ 在朗读：以 mixWithOthers 的「保活态」激活（引擎渲染静音维持后台存活、WS 不断），
    // 不压低其它 App。duckOthers 从 setActive(true) 那一刻就开始压音、与是否真出声无关，
    // 所以绝不能在这里就用 duck——它推迟到 speak_start / 首帧 PCM 的出声窗口（enterSpeakingSessionIfNeeded）。
    configureSession(active: true, audible: false)
    startEngineIfNeeded()
    openWebSocket(url)
    resolve(nil)
  }

  @objc(stopRealtime:rejecter:)
  func stopRealtime(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    shouldStreamConnect = false
    closeWebSocket()
    stopEngine()
    emitRealtime("closed")
    releaseSessionIfIdle() // 回放也没在才释放 session
    resolve(nil)
  }

  // MARK: WebSocket

  private func openWebSocket(_ url: URL) {
    closeWebSocket()
    // URLSessionConfiguration.default 的 timeoutIntervalForRequest 默认 60s，会把"只收不发"的
    // 空闲连接（播报模式切后台待命时正是如此）在 60s 上判超时并 RST——表现为电脑端黄色喇叭图标
    // 约 60s 熄灭。放宽到 24h（与 nginx /api/ws/ 的 proxy_read_timeout 对齐），让空闲接收不被误杀；
    // 真掉线由下面的 sendPing 心跳与服务端 20s 心跳兜底探活。
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 86400
    let s = URLSession(configuration: config)
    wsSession = s
    let task = s.webSocketTask(with: url)
    wsTask = task
    emitRealtime("connecting")
    task.resume()
    // 全局播报端点：连上先声明身份（send 会排队直到握手完成）。单对话端点无需 register。
    if realtimeMode == "broadcast" {
      let register = "{\"type\":\"register\",\"client\":\"mobile\",\"mode\":\"broadcast\"}"
      task.send(.string(register)) { _ in }
    }
    receiveLoop(task)
    startKeepAlivePing(task)
  }

  private func closeWebSocket() {
    stopKeepAlivePing()
    wsTask?.cancel(with: .goingAway, reason: nil)
    wsTask = nil
    wsSession?.invalidateAndCancel()
    wsSession = nil
  }

  /// WS 保活心跳：连上后每 20s 发一个 WS ping。作用有二——
  ///  1) 制造上行流量、刷新 URLSession 请求超时，避免空闲连接被 60s 判死（与 Android OkHttp
  ///     pingInterval(20s) 对齐）；
  ///  2) sendPing 回调带错即证明 socket 已死，立刻 cancel 让 receiveLoop 的失败分支统一收网重连
  ///     （比干等 receive 报错更快）。定时器跑主队列，随 closeWebSocket 取消。
  private func startKeepAlivePing(_ task: URLSessionWebSocketTask) {
    stopKeepAlivePing()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 20, repeating: 20)
    timer.setEventHandler { [weak self] in
      guard let self = self, task === self.wsTask else { return }
      task.sendPing { [weak self] error in
        guard let self = self, error != nil else { return }
        DispatchQueue.main.async {
          guard task === self.wsTask else { return } // 已被别的路径收网则忽略
          task.cancel(with: .abnormalClosure, reason: nil) // → receiveLoop 失败 → handleWsClosed 重连
        }
      }
    }
    timer.resume()
    wsKeepAliveTimer = timer
  }

  private func stopKeepAlivePing() {
    wsKeepAliveTimer?.cancel()
    wsKeepAliveTimer = nil
  }

  /// URLSession 回调在后台线程；把触及引擎/事件的处理统一切回主线程（顺序由 main 串行保证）。
  private func receiveLoop(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure:
        DispatchQueue.main.async { self.handleWsClosed(task) }
      case .success(let message):
        DispatchQueue.main.async {
          guard task === self.wsTask else { return } // 旧 task 的回调丢弃
          self.reconnectAttempt = 0
          switch message {
          case .data(let d): self.handlePcm(d)
          case .string(let str): self.handleJson(str)
          @unknown default: break
          }
        }
        self.receiveLoop(task) // 继续收（回调线程链式）
      }
    }
  }

  private func handleWsClosed(_ task: URLSessionWebSocketTask) {
    guard task === wsTask || wsTask == nil else { return }
    wsTask = nil
    guard shouldStreamConnect else { emitRealtime("closed"); return }
    reconnectAttempt += 1
    if reconnectAttempt > 5 {
      // 重连放弃：别让引擎挂着 ducked session 不放
      stopEngine()
      releaseSessionIfIdle()
      emitRealtime("error", error: "ws_reconnect_failed")
      return
    }
    let delays = [1.0, 2.0, 5.0, 5.0, 5.0]
    let delay = delays[min(reconnectAttempt - 1, delays.count - 1)]
    emitRealtime("connecting")
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self = self, self.shouldStreamConnect,
            let url = URL(string: self.wsUrlString) else { return }
      self.openWebSocket(url)
    }
  }

  // MARK: 帧处理

  private func handleJson(_ str: String) {
    guard let data = str.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = obj["type"] as? String else { return }
    switch type {
    case "ready":
      configureSession(active: true, audible: false) // 保活态（mix），不压他人
      startEngineIfNeeded()
      emitRealtime("ready")
    case "speak_start":
      let rid = obj["run_id"] as? String ?? ""
      let cid = obj["conversation_id"] as? String ?? ""
      if !streamRunId.isEmpty, rid != streamRunId {
        flushRealtimePlayback() // 改口：冲掉上一 run 未播的 PCM
      }
      streamRunId = rid
      tailGeneration += 1 // 新 run 开始：作废挂起的「尾音播完→降回保活态」
      player?.pause() // 与回放互斥
      enterSpeakingSessionIfNeeded()
      updateBroadcastActivity(active: true) // 灵动岛/锁屏反映"正在朗读"（无活动时 no-op）
      emitRealtime("speaking", runId: rid, convId: cid)
    case "speak_end":
      // 不清队列：已排队的尾音自然播完；播完后退出朗读窗口（解除 duck、降回 mix 保活）
      scheduleSessionReleaseAfterTail()
      updateBroadcastActivity(active: false) // 回落"监听中"
      emitRealtime("ended", runId: obj["run_id"] as? String,
                   convId: obj["conversation_id"] as? String)
    case "audio_saved":
      guard hasListeners else { return }
      var body: [String: Any] = ["runId": obj["run_id"] as? String ?? ""]
      body["conversationId"] = obj["conversation_id"] as? String ?? ""
      if let audio = obj["audio"] { body["audio"] = audio }
      sendEvent(withName: "onAudioSaved", body: body)
    default:
      break
    }
  }

  private func handlePcm(_ incoming: Data) {
    tailGeneration += 1 // 还有 PCM 进来 = 还在朗读，作废挂起的「尾音播完→降回保活态」
    enterSpeakingSessionIfNeeded()
    var bytes = incoming
    if let carry = byteCarry { bytes = Data([carry]) + bytes; byteCarry = nil }
    if bytes.count % 2 == 1 { byteCarry = bytes.last; bytes = bytes.dropLast() }
    let sampleCount = bytes.count / 2
    guard sampleCount > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: streamFormat,
                                        frameCapacity: AVAudioFrameCount(sampleCount)) else { return }
    buffer.frameLength = AVAudioFrameCount(sampleCount)
    let dst = buffer.floatChannelData![0]
    // 手动按字节读 s16le，避开 Data 非 2 字节对齐时 bindMemory(Int16) 的对齐风险
    bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let base = raw.bindMemory(to: UInt8.self).baseAddress!
      for i in 0..<sampleCount {
        let lo = UInt16(base[i * 2])
        let hi = UInt16(base[i * 2 + 1])
        dst[i] = Float(Int16(bitPattern: lo | (hi << 8))) / 32768.0
      }
    }
    if !playerNode.isPlaying { playerNode.play() }
    playerNode.scheduleBuffer(buffer, completionHandler: nil)
  }

  // MARK: AVAudioEngine

  private func startEngineIfNeeded() {
    if !engineWired {
      engine.attach(playerNode)
      engine.connect(playerNode, to: engine.mainMixerNode, format: streamFormat)
      engineWired = true
    }
    if !engineStarted {
      // 注意：不在此激活 session——duck/mix 取决于调用方意图，调用方须先 configureSession
      engine.prepare()
      do { try engine.start(); engineStarted = true }
      catch { NSLog("[FlopsAudio] engine start error: %@", error.localizedDescription); return }
    }
    if !playerNode.isPlaying { playerNode.play() }
  }

  private func stopEngine() {
    stopEngineForCycle()
    streamRunId = ""
    realtimeSpeaking = false
  }

  /// 只停引擎、不清 run 状态：session 升降级循环（mix↔duck 切换要跨一次 setActive 假期）中途用。
  private func stopEngineForCycle() {
    tailGeneration += 1 // 作废挂起的尾音哨兵（node.stop 会触发其 completionHandler）
    if playerNode.isPlaying { playerNode.stop() }
    if engineStarted { engine.stop(); engineStarted = false }
    byteCarry = nil
  }

  /// 冲掉已排队未播的 PCM（改口 / 开始回放时用），保持 node 可继续接收新 buffer。
  private func flushRealtimePlayback() {
    tailGeneration += 1 // node.stop 会触发挂起哨兵的 completionHandler，先作废
    playerNode.stop() // 清空 scheduleBuffer 队列
    byteCarry = nil
    if engineStarted { playerNode.play() }
  }

  // MARK: 朗读窗口（speak_start → 尾音播完）——只在窗口内 duck
  //
  // duck 的生效与解除都绑定在 setActive 的那一刻：已激活的 session 上仅换 category 选项，
  // 既压不下去也恢复不了他人音量。所以 mix(保活)↔duck(出声) 的切换要做一次
  // 「停引擎 → setActive(false) → 换选项 → setActive(true) → 重启引擎」的循环（毫秒级）。

  /// 实时流处于「正在朗读」窗口内。窗口外 session 一律 mix 保活，不压他人。
  private var realtimeSpeaking = false

  /// 挂起的「尾音哨兵」回调的代数：speak_start / 新 PCM / 停引擎 / flush 都会推进，
  /// 使旧哨兵的 completionHandler 变成 no-op（node.stop 也会触发 handler，必须靠代数甄别）。
  private var tailGeneration = 0

  /// speak_start / 首帧 PCM：进入朗读窗口。偏好 duck 且 session 已按 mix 保活激活时，
  /// 需经一次降/升级循环换成 duck 选项——发生在首帧 PCM 排队之前，无可闻断裂。
  private func enterSpeakingSessionIfNeeded() {
    if !realtimeSpeaking {
      realtimeSpeaking = true
      if audioMixingMode == "duck", sessionActive {
        stopEngineForCycle()
        configureSession(active: false)
      }
      configureSession(active: true)
    }
    startEngineIfNeeded()
  }

  /// speak_end 后不能立刻退出窗口——已排队的尾音还没出声。排一个 10ms 静音哨兵 buffer，
  /// 用 .dataPlayedBack 等它前面的 PCM 全部播完再退出。期间来了新 run / 新 PCM，
  /// tailGeneration 已被推进，回调作废。
  private func scheduleSessionReleaseAfterTail() {
    guard engineStarted else { exitSpeakingSession(); return }
    let gen = tailGeneration
    let frames = AVAudioFrameCount(240) // 24kHz × 10ms
    guard let sentinel = AVAudioPCMBuffer(pcmFormat: streamFormat, frameCapacity: frames) else { return }
    sentinel.frameLength = frames
    if let ch = sentinel.floatChannelData {
      memset(ch[0], 0, Int(frames) * MemoryLayout<Float>.size)
    }
    if !playerNode.isPlaying { playerNode.play() }
    playerNode.scheduleBuffer(sentinel, at: nil, options: [],
                              completionCallbackType: .dataPlayedBack) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self = self, gen == self.tailGeneration else { return }
        self.exitSpeakingSession()
      }
    }
  }

  /// 尾音播完，退出朗读窗口。偏好 mix 本来没压别人，引擎继续跑即可；
  /// 偏好 duck 需降级循环把他人音量放回来。回放正在出声则 session 归回放管，不动。
  private func exitSpeakingSession() {
    guard realtimeSpeaking else { return }
    realtimeSpeaking = false
    guard audioMixingMode == "duck" else { return }
    if let p = player, p.timeControlStatus != .paused { return }
    downgradeSessionToIdle()
  }

  /// 降级循环：停引擎 → setActive(false)（恢复他人音量）→ 立刻以 mix 保活态重新激活并
  /// 重启引擎（渲染静音维持后台存活，WS 不断）。WS 已不需要时则彻底停干净。
  private func downgradeSessionToIdle() {
    guard shouldStreamConnect else {
      stopEngine()
      releaseSessionIfIdle()
      return
    }
    stopEngineForCycle()
    configureSession(active: false)
    configureSession(active: true, audible: false)
    startEngineIfNeeded()
  }

  /// 实时引擎与回放都没在出声时才真正 setActive(false)；有一方在用则保持激活。
  /// player 存在但已暂停/播完（timeControlStatus == .paused）不算占用——play() 会重新激活。
  private func releaseSessionIfIdle() {
    guard !engineStarted else { return }
    if let p = player, p.timeControlStatus != .paused { return }
    configureSession(active: false)
  }

  /// 回放结束/停止后的 session 收尾：WS 还该保持连接且没在朗读 → 降回 mix 保活
  /// （顺带解除回放留下的 duck）；正在实时朗读 → session 归实时流管；否则彻底释放。
  private func releaseAfterReplay() {
    if shouldStreamConnect {
      if !realtimeSpeaking { downgradeSessionToIdle() }
      return
    }
    releaseSessionIfIdle()
  }

  private func emitRealtime(_ state: String, runId: String? = nil,
                            convId: String? = nil, error: String? = nil) {
    guard hasListeners else { return }
    var body: [String: Any] = ["state": state]
    if let runId = runId { body["runId"] = runId }
    if let convId = convId { body["conversationId"] = convId }
    if let error = error { body["error"] = error }
    sendEvent(withName: "onRealtimeState", body: body)
  }
}
