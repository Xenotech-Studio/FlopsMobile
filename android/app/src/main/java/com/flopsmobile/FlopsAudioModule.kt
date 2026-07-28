package com.flopsmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import androidx.media3.common.AudioAttributes as Media3AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * TTS 原生模块（Android 端，与 iOS FlopsAudioModule.swift 对称）：实时流式朗读 + 消息回放。
 *
 * 消息回放子系统（对齐 iOS 的 AVQueuePlayer 子系统）：
 *  - ExoPlayer 顺序连播一条 assistant 消息的多个 mp3 segment（https 流式 / file:// 已解密明文）。
 *  - loadAndPlay / play / pause / stop / playIndex / getState；事件 onAudioState / onAudioProgress
 *    回流 JS（ttsPlayer.ts 订阅），position/duration 单位秒（与 iOS 一致）。
 *  - ExoPlayer 全部访问在 main 线程（media3 单线程约束）。
 *
 * 实时子系统职责：
 *  - OkHttp WebSocket 连 /api/ws/audio（single）或 /api/ws/audio/global（broadcast）。wsUrl 已含鉴权。
 *  - 解析控制帧（ready / speak_start / speak_end / audio_saved）+ 裸 s16le 24k mono PCM 二进制帧。
 *  - AudioTrack(MODE_STREAM, PCM_16BIT) 直接排 PCM 播放（Android 原生就吃 s16le，无需转 Float）。
 *  - run_id 变化 = 改口 → pause/flush/play 冲掉旧排队。
 *  - 断线有界退避重连（1/2/5/5/5s）。
 *  - 启动 FlopsAudioService（前台服务 + MediaSession）→ 后台 / 锁屏继续朗读。
 *  - 事件 onRealtimeState / onAudioSaved 经 RCTDeviceEventEmitter 回流（ttsRealtime.ts 订阅）。
 *
 * 线程模型：控制（WS / 帧 / 重连 / 事件）全在 ctrlHandler（独立 HandlerThread）串行；AudioTrack
 * 的 create/write/flush/stop 全在 audioExecutor（单线程）串行 —— 两者各自单线程，跨线程只用
 * @Volatile 字段读一致性，无需锁。
 */
class FlopsAudioModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "FlopsAudio"

  companion object {
    private const val TAG = "FlopsAudio"
    private const val SAMPLE_RATE = 24000
    private val RECONNECT_DELAYS_MS = longArrayOf(1000, 2000, 5000, 5000, 5000)
    /** SCO 链路建立通常几百 ms～2s；超时按失败结清，JS 回落内置麦。 */
    private const val SCO_CONNECT_TIMEOUT_MS = 3000L

    /** 供 FlopsAudioService（锁屏/通知的停止按钮）回调本模块停流。进程内单例，随模块生命周期。 */
    @Volatile
    var instance: FlopsAudioModule? = null
      private set
  }

  // 控制线程：所有 WS / 帧 / 重连 / 状态发射
  private val ctrlThread = HandlerThread("FlopsAudioCtrl").apply { start() }
  private val ctrl = Handler(ctrlThread.looper)
  // 音频线程：AudioTrack 的建/写/冲/停都在这，byteCarry 只此线程访问
  private val audioExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "FlopsAudioPCM") }

  private val http: OkHttpClient by lazy {
    OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
  }

  // ---- 控制线程私有状态 ----
  @Volatile private var webSocket: WebSocket? = null
  private var wsUrl: String = ""
  private var mode: String = "single"
  @Volatile private var shouldConnect = false
  private var reconnectAttempt = 0
  private var currentRunId = ""

  // ---- 音频线程私有状态 ----
  private var audioTrack: AudioTrack? = null
  private var byteCarry: ByteArray? = null
  /** 本 track 生命周期内已写入的帧数（flush/新建会连播放头一起归零）；估算 speak_end 后尾音剩余时长用。 */
  private var framesWritten = 0L

  // ---- 音频焦点（ctrl 线程状态；只在「朗读窗口」speak_start→尾音播完 内持有，见 setAudioMixingMode） ----
  /** 与其它 App 的混音方式（对齐 iOS）："duck" → 朗读窗口内持 TRANSIENT_MAY_DUCK 焦点压低他人；"mix" → 不申请焦点直接叠加。 */
  @Volatile private var mixingMode = "duck"
  private var focusHeld = false
  /** 实时流处于 speak_start→speak_end 窗口内（尾音播放期不算，靠延时释放兜住）。 */
  private var inSpeakWindow = false
  /** 回放播放器正在出声（FlopsAudioModule 回放子系统经 ctrl.post 同步进来）。 */
  private var replayAudible = false
  /** 挂起的「尾音播完→释放焦点」代数：新 speak_start / 回放开播 / teardown 推进使旧释放作废。 */
  private var focusGeneration = 0
  private var audioFocusRequest: AudioFocusRequest? = null

  // ---- 录音焦点（ctrl 线程状态）：麦克风开→关窗口内持 GAIN_TRANSIENT 独占，直接暂停其他 app 播放
  //      （系统 duck 各家 app 行为不一致，压低量不可靠；不用 GAIN——永久性 LOSS 会让对方释放后不自动续播）。
  //      与朗读焦点各持一份请求、互不干扰——录音与朗读窗口理论上可重叠，状态机分开最稳。 ----
  private var recordFocusHeld = false
  private var recordFocusRequest: AudioFocusRequest? = null

  // ---- 麦克风输入源（ctrl 线程状态）：听写选耳机麦时启用蓝牙 SCO 路由（库的 setInputDevice
  //      在 Android 是 noop、Oboe 录音流跟随系统默认路由，只能系统级切）。等 SCO connected
  //      广播的进行中请求最多一个；新请求 / 模块销毁会把旧请求按失败结清，promise 不悬挂。 ----
  private var scoReceiver: BroadcastReceiver? = null
  private var scoTimeoutRunnable: Runnable? = null
  private var scoSettle: ((Boolean) -> Unit)? = null

  // ---- 回放（main 线程私有状态；ExoPlayer 要求单线程访问，统一走 main） ----
  private val main = Handler(Looper.getMainLooper())
  private var replayPlayer: ExoPlayer? = null
  private var replayUrls: List<String> = emptyList()
  /** 一条消息的稳定标识（ChatScreen 的 stableKey），供 JS 判定"在播的是不是这条消息"。 */
  private var replayKey = ""

  init {
    instance = this
  }

  override fun invalidate() {
    super.invalidate()
    if (instance === this) instance = null
    ctrl.post {
      teardownRealtime(emitClosed = false)
      abandonRecordDuckFocus()
      // 进行中的 SCO 等待结清 + 关 SCO，别让路由留在通话音质
      scoSettle?.invoke(false)
      stopSco(reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
    }
    main.post { releaseReplayPlayer() }
    ctrlThread.quitSafely()
    audioExecutor.shutdown()
  }

  // ================= 导出方法：消息回放（对齐 iOS loadAndPlay/play/pause/stop/playIndex/getState） =================

  /** 从头播放一条消息的 segment 列表（https mp3 / file:// 已解密明文）。meta: {key, title?, subtitle?}。 */
  @ReactMethod
  fun loadAndPlay(segments: ReadableArray, meta: ReadableMap, promise: Promise) {
    val urls = ArrayList<String>(segments.size())
    for (i in 0 until segments.size()) {
      val s = segments.getString(i)
      if (!s.isNullOrEmpty()) urls.add(s)
    }
    if (urls.isEmpty()) {
      promise.reject("no_segments", "empty segments")
      return
    }
    val key = meta.getString("key") ?: ""
    // 与实时朗读互斥：开始回放前冲掉实时流已排队的 PCM，避免叠音（对齐 iOS）
    audioExecutor.execute { flushAudio() }
    main.post {
      replayUrls = urls
      replayKey = key
      emitReplayState("loading")
      val player = ensureReplayPlayer()
      player.setMediaItems(urls.map { MediaItem.fromUri(it) })
      player.prepare()
      player.play()
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun play(promise: Promise) {
    main.post { replayPlayer?.play() }
    promise.resolve(null)
  }

  @ReactMethod
  fun pause(promise: Promise) {
    main.post { replayPlayer?.pause() }
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    main.post {
      releaseReplayPlayer()
      emitReplayState("idle")
    }
    promise.resolve(null)
  }

  /** 跳到本消息的第 index 段。越界则忽略。 */
  @ReactMethod
  fun playIndex(index: Int, promise: Promise) {
    main.post {
      val p = replayPlayer ?: return@post
      if (index < 0 || index >= replayUrls.size) return@post
      p.seekTo(index, 0L)
      p.play()
    }
    promise.resolve(null)
  }

  /** JS 挂载时对齐一次当前快照（可能 app 已在后台播着别的消息）。 */
  @ReactMethod
  fun getState(promise: Promise) {
    main.post {
      val body: WritableMap = Arguments.createMap().apply {
        putString("state", currentReplayStateString())
        putString("key", replayKey)
        putInt("index", replayPlayer?.currentMediaItemIndex ?: 0)
        putInt("count", replayUrls.size)
      }
      promise.resolve(body)
    }
  }

  // ================= 导出方法：实时流 =================

  @ReactMethod
  fun startRealtime(wsUrl: String, mode: String, promise: Promise) {
    if (wsUrl.isEmpty()) {
      promise.reject("bad_ws_url", "empty ws url")
      return
    }
    ctrl.post {
      // 已连同一 URL + 模式：幂等忽略
      if (shouldConnect && wsUrl == this.wsUrl && mode == this.mode && webSocket != null) {
        return@post
      }
      this.wsUrl = wsUrl
      this.mode = mode
      shouldConnect = true
      reconnectAttempt = 0
      audioExecutor.execute { ensureAudioTrack() }
      FlopsAudioService.start(reactApplicationContext)
      openWebSocket()
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun stopRealtime(promise: Promise) {
    ctrl.post {
      teardownRealtime(emitClosed = true)
      FlopsAudioService.stop(reactApplicationContext)
    }
    promise.resolve(null)
  }

  /** 设置与其它 App 的混音方式："duck"（朗读窗口内压低他人音量，默认）| "mix"（直接叠加）。
   *  对齐 iOS setAudioMixingMode；朗读中切换即时生效（mix→duck 立即申请焦点，duck→mix 立即释放）。 */
  @ReactMethod
  fun setAudioMixingMode(mode: String, promise: Promise) {
    ctrl.post {
      mixingMode = if (mode == "mix") "mix" else "duck"
      if (mixingMode == "mix") {
        abandonSpeakFocus()
      } else if (inSpeakWindow || replayAudible) {
        requestSpeakFocusIfNeeded()
      }
    }
    promise.resolve(true)
  }

  /** 录音焦点：外放时开麦持 GAIN_TRANSIENT 暂停其他 app 播放（防回音）；戴耳机（有线/USB/蓝牙）
   *  时持 MAY_DUCK 只压低音量不暂停——耳机无回音问题，可边听边说，背景音稍低便于听清自己。
   *  关麦释放焦点、对方恢复。幂等（重复 on/off 无害）；voiceDictationMobile.ts 在
   *  _startRecorder/_stopCapture 调。 */
  @ReactMethod
  fun setRecordingDuck(active: Boolean, promise: Promise) {
    ctrl.post { if (active) requestRecordDuckFocus() else abandonRecordDuckFocus() }
    promise.resolve(true)
  }

  /** 听写麦克风输入源："headset" → 启动蓝牙 SCO（拿耳机麦，输出同时降为通话音质）并等
   *  connected 广播，成功 resolve(true)、超时/无蓝牙 resolve(false)（JS 提示后用内置麦继续）；
   *  "builtin" → 关 SCO 回默认路由（未开时幂等无害）。录音结束必须再调 "builtin" 恢复
   *  A2DP 高音质，否则音乐一直是通话音质（voiceDictationMobile._stopCapture 负责）。 */
  @ReactMethod
  fun setMicSource(source: String, promise: Promise) {
    ctrl.post {
      val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      // 上一个未完成的 headset 请求作废（按失败结清，避免 JS 侧 await 悬挂）
      scoSettle?.invoke(false)
      if (source != "headset") {
        stopSco(am)
        promise.resolve(true)
        return@post
      }
      if (am.isBluetoothScoOn) {
        promise.resolve(true)
        return@post
      }
      var settled = false
      val settle = fun(ok: Boolean) {
        if (settled) return
        settled = true
        scoSettle = null
        scoTimeoutRunnable?.let { ctrl.removeCallbacks(it) }
        scoTimeoutRunnable = null
        scoReceiver?.let { r ->
          try { reactApplicationContext.unregisterReceiver(r) } catch (_: Exception) {}
        }
        scoReceiver = null
        if (!ok) stopSco(am) // 半途的连接尝试取消掉，别留半开状态
        Log.i(TAG, "mic source headset ${if (ok) "ok (SCO connected)" else "failed, fallback builtin"}")
        promise.resolve(ok)
      }
      scoSettle = settle
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          val state = intent?.getIntExtra(
            AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR)
          ctrl.post {
            when (state) {
              AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                @Suppress("DEPRECATION")
                am.isBluetoothScoOn = true
                settle(true)
              }
              AudioManager.SCO_AUDIO_STATE_ERROR -> settle(false)
              // DISCONNECTED 在建立初期也会广播一次，忽略，等 CONNECTED 或超时
            }
          }
        }
      }
      scoReceiver = receiver
      val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        reactApplicationContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        reactApplicationContext.registerReceiver(receiver, filter)
      }
      val timeout = Runnable { settle(false) }
      scoTimeoutRunnable = timeout
      ctrl.postDelayed(timeout, SCO_CONNECT_TIMEOUT_MS)
      try {
        @Suppress("DEPRECATION")
        am.startBluetoothSco()
      } catch (e: Exception) {
        Log.w(TAG, "startBluetoothSco failed: ${e.message}")
        settle(false)
      }
    }
  }

  /** SCO 全关（stop + flag 复位）；未开时调用无害。 */
  private fun stopSco(am: AudioManager) {
    try {
      @Suppress("DEPRECATION")
      am.stopBluetoothSco()
      @Suppress("DEPRECATION")
      am.isBluetoothScoOn = false
    } catch (e: Exception) {
      Log.w(TAG, "stopBluetoothSco failed: ${e.message}")
    }
  }

  /** 录音期间保持屏幕常亮（与 iOS isIdleTimerDisabled 对称）。FLAG_KEEP_SCREEN_ON 只在
   *  窗口前台可见时生效，切后台自动失效不烧屏；幂等（重复 add/clear 无害）。
   *  voiceDictationMobile 在录音 start 开、stop/cancel/teardown 关。 */
  @ReactMethod
  fun setKeepScreenOn(on: Boolean, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      if (on) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
      promise.resolve(true)
    }
  }

  // NativeEventEmitter 约定：JS 端 addListener/removeListeners 会调到这两个空实现，避免告警。
  @ReactMethod fun addListener(eventName: String) { /* no-op */ }
  @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

  /** 锁屏 / 通知的"停止"按钮：停流并发 closed 给 JS（服务自己 stopSelf，不在这里停服务）。 */
  fun stopFromService() {
    ctrl.post { teardownRealtime(emitClosed = true) }
  }

  // ================= 消息回放（main 线程） =================

  private fun ensureReplayPlayer(): ExoPlayer {
    replayPlayer?.let { return it }
    val player = ExoPlayer.Builder(reactApplicationContext)
      .setAudioAttributes(
        Media3AudioAttributes.Builder()
          .setUsage(C.USAGE_MEDIA)
          .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
          .build(),
        // 焦点自管（syncReplayAudible → duck/mix 按用户偏好）；ExoPlayer 内建焦点只会 GAIN 独占暂停他人
        /* handleAudioFocus = */ false,
      )
      .build()
    player.addListener(replayListener)
    replayPlayer = player
    return player
  }

  /** 停止并释放回放播放器（stop / invalidate 用）；清 key/urls，焦点同步释放。 */
  private fun releaseReplayPlayer() {
    main.removeCallbacks(replayProgressTick)
    val p = replayPlayer
    replayPlayer = null
    if (p != null) {
      p.removeListener(replayListener)
      p.stop()
      p.release()
    }
    replayKey = ""
    replayUrls = emptyList()
    syncReplayAudible(false)
  }

  private val replayListener = object : Player.Listener {
    override fun onPlaybackStateChanged(state: Int) {
      when (state) {
        Player.STATE_BUFFERING -> emitReplayState("loading")
        Player.STATE_READY ->
          emitReplayState(if (replayPlayer?.isPlaying == true) "playing" else "paused")
        Player.STATE_ENDED -> {
          emitReplayState("ended")
          syncReplayAudible(false)
        }
        Player.STATE_IDLE -> Unit // stop() / error 各自发状态，这里不重复
      }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      syncReplayAudible(isPlaying)
      val p = replayPlayer ?: return
      if (isPlaying) {
        emitReplayState("playing")
        main.removeCallbacks(replayProgressTick)
        main.post(replayProgressTick)
      } else {
        main.removeCallbacks(replayProgressTick)
        // ended/idle 由 onPlaybackStateChanged 发；这里只报暂停 / 缓冲
        when (p.playbackState) {
          Player.STATE_READY -> emitReplayState("paused")
          Player.STATE_BUFFERING -> emitReplayState("loading")
          else -> Unit
        }
      }
    }

    /** 段间自然切换 / seekTo 换段：带新 index 重发一次状态（对齐 iOS onItemEnded 的推进播报）。 */
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      if (replayPlayer != null) emitReplayState(currentReplayStateString())
    }

    override fun onPlayerError(error: PlaybackException) {
      emitReplayState("error", error = error.errorCodeName)
      syncReplayAudible(false)
    }
  }

  /** 进度 0.5s 一跳（对齐 iOS addPeriodicTimeObserver）；单位秒。仅播放中自续。 */
  private val replayProgressTick = object : Runnable {
    override fun run() {
      val p = replayPlayer ?: return
      if (!p.isPlaying) return
      val durMs = p.duration
      val body: WritableMap = Arguments.createMap().apply {
        putString("key", replayKey)
        putInt("index", p.currentMediaItemIndex)
        putDouble("position", p.currentPosition.coerceAtLeast(0L) / 1000.0)
        putDouble("duration", if (durMs == C.TIME_UNSET) 0.0 else durMs / 1000.0)
      }
      emit("onAudioProgress", body)
      main.postDelayed(this, 500)
    }
  }

  private fun currentReplayStateString(): String {
    val p = replayPlayer ?: return "idle"
    return when (p.playbackState) {
      Player.STATE_BUFFERING -> "loading"
      Player.STATE_READY -> if (p.playWhenReady) "playing" else "paused"
      Player.STATE_ENDED -> "ended"
      else -> "idle"
    }
  }

  /** main 线程调；状态字段（key/index/count）与 iOS onAudioState 同构。 */
  private fun emitReplayState(state: String, error: String? = null) {
    val body: WritableMap = Arguments.createMap().apply {
      putString("state", state)
      putString("key", replayKey)
      putInt("index", replayPlayer?.currentMediaItemIndex ?: 0)
      putInt("count", replayUrls.size)
      if (error != null) putString("error", error)
    }
    emit("onAudioState", body)
  }

  /** 回放是否在出声 → 同步给 ctrl 线程的焦点管理（duck 偏好时申请/释放 TRANSIENT_MAY_DUCK）。 */
  private fun syncReplayAudible(audible: Boolean) {
    ctrl.post {
      if (replayAudible == audible) return@post
      replayAudible = audible
      if (audible) {
        focusGeneration += 1 // 作废挂起的「尾音播完→释放焦点」——焦点接着由回放持有
        requestSpeakFocusIfNeeded()
      } else if (!inSpeakWindow) {
        abandonSpeakFocus()
      }
    }
  }

  // ================= WebSocket（ctrl 线程） =================

  private fun openWebSocket() {
    closeWebSocket()
    val request = Request.Builder().url(wsUrl).build()
    emitRealtime("connecting")
    webSocket = http.newWebSocket(request, listener)
  }

  private fun closeWebSocket() {
    webSocket?.cancel()
    webSocket = null
  }

  private val listener = object : WebSocketListener() {
    override fun onOpen(ws: WebSocket, response: Response) {
      ctrl.post {
        if (ws !== webSocket) return@post // 旧 socket 的回调丢弃
        reconnectAttempt = 0
        // 全局播报端点：连上先声明身份（single 端点纯下行、无需 register）。
        if (mode == "broadcast") {
          ws.send("{\"type\":\"register\",\"client\":\"mobile\",\"mode\":\"broadcast\"}")
        }
      }
    }

    override fun onMessage(ws: WebSocket, text: String) {
      ctrl.post { if (ws === webSocket) handleJson(text) }
    }

    override fun onMessage(ws: WebSocket, bytes: ByteString) {
      // PCM：直接送音频线程，不占 ctrl。stale 判断读 @Volatile webSocket。
      if (ws !== webSocket) return
      val arr = bytes.toByteArray()
      audioExecutor.execute { writePcm(arr) }
    }

    override fun onClosing(ws: WebSocket, code: Int, reason: String) {
      ctrl.post { if (ws === webSocket) handleWsClosed() }
    }

    override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
      ctrl.post { if (ws === webSocket || webSocket == null) handleWsClosed() }
    }
  }

  private fun handleWsClosed() {
    webSocket = null
    // 断在朗读中途：不会再有 speak_end 了，尾音播完即释放焦点（重连后新 speak_start 会重新申请）
    if (inSpeakWindow) {
      inSpeakWindow = false
      scheduleFocusReleaseAfterTail()
    }
    if (!shouldConnect) {
      emitRealtime("closed")
      return
    }
    reconnectAttempt += 1
    if (reconnectAttempt > RECONNECT_DELAYS_MS.size) {
      emitRealtime("error", error = "ws_reconnect_failed")
      return
    }
    val delay = RECONNECT_DELAYS_MS[reconnectAttempt - 1]
    emitRealtime("connecting")
    ctrl.postDelayed({ if (shouldConnect) openWebSocket() }, delay)
  }

  // ================= 帧处理（ctrl 线程） =================

  private fun handleJson(text: String) {
    val obj = try { JSONObject(text) } catch (e: Exception) { return }
    when (obj.optString("type")) {
      "ready" -> {
        audioExecutor.execute { ensureAudioTrack() }
        emitRealtime("ready")
      }
      "speak_start" -> {
        val rid = obj.optString("run_id")
        val cid = obj.optString("conversation_id")
        // 改口 / 抢占：run_id 变了冲掉上一 run 未播的 PCM，避免叠音
        if (currentRunId.isNotEmpty() && rid.isNotEmpty() && rid != currentRunId) {
          audioExecutor.execute { flushAudio() }
        }
        currentRunId = rid
        main.post { replayPlayer?.pause() } // 与回放互斥（对齐 iOS）
        // 进入朗读窗口：作废挂起的「尾音播完→释放焦点」，duck 偏好则申请焦点压低他人
        focusGeneration += 1
        inSpeakWindow = true
        requestSpeakFocusIfNeeded()
        emitRealtime("speaking", runId = rid, convId = cid)
      }
      "speak_end" -> {
        // 不清队列：已排队的尾音自然播完；尾音出声完毕再释放焦点（恢复他人音量）
        inSpeakWindow = false
        scheduleFocusReleaseAfterTail()
        emitRealtime("ended", runId = obj.optString("run_id"), convId = obj.optString("conversation_id"))
      }
      "audio_saved" -> emitAudioSaved(obj)
      // channel_status / 其它：Mobile 是最高优先级渠道，收到什么就播什么，不做压制过滤（对齐 iOS）。
      else -> Unit
    }
  }

  // ================= AudioTrack（audio 线程） =================

  private fun ensureAudioTrack() {
    if (audioTrack != null) return
    val minBuf = AudioTrack.getMinBufferSize(
      SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
    )
    // ~0.5s 缓冲防欠载（2 bytes/sample × 24000 × 0.5）
    val bufSize = maxOf(minBuf, SAMPLE_RATE)
    val track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(SAMPLE_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build(),
      )
      .setBufferSizeInBytes(bufSize)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
    track.play()
    audioTrack = track
    byteCarry = null
    framesWritten = 0L
  }

  /** 收 PCM：接上上次奇数字节尾巴，凑偶数写入；剩 1 字节留到下次。
   *  track 为 null（已 teardown）时直接丢，绝不在这里重建——否则拆除后的迟到 PCM 会把 track 复活。 */
  private fun writePcm(incoming: ByteArray) {
    val track = audioTrack ?: return
    val carry = byteCarry
    val merged: ByteArray
    if (carry != null && carry.isNotEmpty()) {
      merged = ByteArray(carry.size + incoming.size)
      System.arraycopy(carry, 0, merged, 0, carry.size)
      System.arraycopy(incoming, 0, merged, carry.size, incoming.size)
    } else {
      merged = incoming
    }
    val usable = merged.size - (merged.size % 2)
    byteCarry = if (usable < merged.size) merged.copyOfRange(usable, merged.size) else null
    if (usable <= 0) return
    try {
      track.write(merged, 0, usable, AudioTrack.WRITE_BLOCKING)
      framesWritten += (usable / 2).toLong()
    } catch (e: IllegalStateException) {
      // track 已被 stop/release（stopRealtime 与本次 write 竞态）：忽略
    }
  }

  /** 冲掉已排队未播的 PCM（改口用），保持 track 可继续接新数据。 */
  private fun flushAudio() {
    val track = audioTrack ?: return
    try {
      track.pause()
      track.flush()
      track.play()
    } catch (e: IllegalStateException) { /* ignore */ }
    byteCarry = null
    framesWritten = 0L // flush 连播放头一起归零
  }

  private fun stopAudioTrack() {
    val track = audioTrack
    audioTrack = null
    byteCarry = null
    framesWritten = 0L
    if (track != null) {
      try { track.pause(); track.flush() } catch (e: IllegalStateException) { /* ignore */ }
      try { track.stop() } catch (e: IllegalStateException) { /* ignore */ }
      track.release()
    }
  }

  // ================= 拆除 =================

  /** 在 ctrl 线程调：停 WS + 停音频 + 回 idle。emitClosed=true 时发一次 closed。 */
  private fun teardownRealtime(emitClosed: Boolean) {
    shouldConnect = false
    ctrl.removeCallbacksAndMessages(null) // 取消挂起的重连 + 挂起的焦点释放
    closeWebSocket()
    currentRunId = ""
    reconnectAttempt = 0
    audioExecutor.execute { stopAudioTrack() }
    // 音频立停，焦点立即释放（回放仍在出声则保留）
    focusGeneration += 1
    inSpeakWindow = false
    if (!replayAudible) abandonSpeakFocus()
    if (emitClosed) emitRealtime("closed")
  }

  // ================= 音频焦点（ctrl 线程） =================
  //
  // 只在「出声窗口」内持有 TRANSIENT_MAY_DUCK 焦点（duck 偏好时）：实时朗读 speak_start→尾音播完，
  // 或回放播放中。窗口外一律不持焦点 —— 与其它 App 的音乐互不干扰（对齐 iOS 的
  // enterSpeakingSessionIfNeeded / exitSpeakingSession）。

  private fun requestSpeakFocusIfNeeded() {
    if (mixingMode != "duck" || focusHeld) return
    val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val req = audioFocusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener { /* 不因他人抢占而停播：Mobile 是最高优先级渠道（对齐 iOS） */ }
        .build()
        .also { audioFocusRequest = it }
      am.requestAudioFocus(req)
    } else {
      @Suppress("DEPRECATION")
      am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    }
    focusHeld = true
    Log.i(TAG, "speak duck focus requested")
  }

  private fun abandonSpeakFocus() {
    if (!focusHeld) return
    focusHeld = false
    val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      am.abandonAudioFocus(null)
    }
    Log.i(TAG, "speak duck focus released")
  }

  /** speak_end / 断线后不能立刻释放焦点——AudioTrack 里已排队的尾音还没出声，立刻放会让他人
   *  音量在尾音期间弹回来再被压下去。按「已写入帧数 − 播放头位置」估算剩余时长，延时释放；
   *  期间新 speak_start / 回放开播会推进 focusGeneration 作废本次释放。 */
  private fun scheduleFocusReleaseAfterTail() {
    if (!focusHeld) return
    val gen = focusGeneration
    audioExecutor.execute {
      val track = audioTrack
      val remainMs = if (track != null) {
        val head = try { track.playbackHeadPosition.toLong() } catch (e: IllegalStateException) { framesWritten }
        (framesWritten - head).coerceAtLeast(0L) * 1000L / SAMPLE_RATE + 100L // +100ms 余量
      } else {
        0L
      }
      ctrl.postDelayed({
        if (gen == focusGeneration && !inSpeakWindow && !replayAudible) abandonSpeakFocus()
      }, remainMs)
    }
  }

  // ================= 录音 duck 焦点（ctrl 线程） =================

  private fun requestRecordDuckFocus() {
    if (recordFocusHeld) return
    val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    // 外放：GAIN_TRANSIENT 暂停其他 app（防回音）；戴耳机：MAY_DUCK 只压低音量不暂停
    //（耳机无回音问题，用户要边听边说，背景音稍低便于听清自己说话）。
    val headset = hasHeadsetOutput(am)
    val focusGain = if (headset) {
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
    } else {
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
    }
    val result: Int
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // 焦点类型随耳机在/离逐次变化，不能复用缓存请求；abandon 要求同一对象，构建后存下
      val req = AudioFocusRequest.Builder(focusGain)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener { /* 录音不因他人抢占而停 */ }
        .build()
        .also { recordFocusRequest = it }
      result = am.requestAudioFocus(req)
    } else {
      @Suppress("DEPRECATION")
      result = am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, focusGain)
    }
    // FAILED 不置 held：后面的释放调用会自然跳过
    recordFocusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    Log.i(TAG, "record focus request (${if (headset) "MAY_DUCK/headset" else "TRANSIENT/speaker"}) -> ${focusResultName(result)}")
  }

  private fun abandonRecordDuckFocus() {
    if (!recordFocusHeld) return
    recordFocusHeld = false
    val am = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      recordFocusRequest?.let { am.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      am.abandonAudioFocus(null)
    }
    Log.i(TAG, "record focus released")
  }

  /** 是否有耳机类输出设备（有线/USB/蓝牙 A2DP/SCO/LE）。TYPE_USB_HEADSET、TYPE_BLE_HEADSET
   *  是编译期内联常量，低版本设备只是报不出该类型，无需 SDK 分支。 */
  private fun hasHeadsetOutput(am: AudioManager): Boolean =
    am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
      when (it.type) {
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        -> true
        else -> false
      }
    }

  private fun focusResultName(result: Int): String = when (result) {
    AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> "GRANTED"
    AudioManager.AUDIOFOCUS_REQUEST_FAILED -> "FAILED"
    AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> "DELAYED"
    else -> "UNKNOWN($result)"
  }

  // ================= 事件回流 =================

  private fun emitRealtime(state: String, runId: String? = null, convId: String? = null, error: String? = null) {
    val body: WritableMap = Arguments.createMap().apply {
      putString("state", state)
      if (runId != null) putString("runId", runId)
      if (convId != null) putString("conversationId", convId)
      if (error != null) putString("error", error)
    }
    emit("onRealtimeState", body)
  }

  private fun emitAudioSaved(obj: JSONObject) {
    val body: WritableMap = Arguments.createMap().apply {
      putString("runId", obj.optString("run_id"))
      putString("conversationId", obj.optString("conversation_id"))
      // audio 是嵌套对象；这里透传原始 JSON 字符串，JS 侧按需 parse（MVP）。
      if (obj.has("audio")) putString("audioJson", obj.optJSONObject("audio")?.toString() ?: "")
    }
    emit("onAudioSaved", body)
  }

  private fun emit(name: String, body: WritableMap) {
    val ctx = reactApplicationContext
    if (!ctx.hasActiveReactInstance()) return
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, body)
  }
}
