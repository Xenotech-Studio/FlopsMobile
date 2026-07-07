package com.flopsmobile

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.HandlerThread
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
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
 * 实时流式 TTS 原生模块（Android 端，与 iOS FlopsAudioModule.swift 的实时子系统对称）。
 *
 * 职责：
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
    private const val SAMPLE_RATE = 24000
    private val RECONNECT_DELAYS_MS = longArrayOf(1000, 2000, 5000, 5000, 5000)

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

  init {
    instance = this
  }

  override fun invalidate() {
    super.invalidate()
    if (instance === this) instance = null
    ctrl.post { teardownRealtime(emitClosed = false) }
    ctrlThread.quitSafely()
    audioExecutor.shutdown()
  }

  // ================= 导出方法 =================

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

  // NativeEventEmitter 约定：JS 端 addListener/removeListeners 会调到这两个空实现，避免告警。
  @ReactMethod fun addListener(eventName: String) { /* no-op */ }
  @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

  /** 锁屏 / 通知的"停止"按钮：停流并发 closed 给 JS（服务自己 stopSelf，不在这里停服务）。 */
  fun stopFromService() {
    ctrl.post { teardownRealtime(emitClosed = true) }
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
        emitRealtime("speaking", runId = rid, convId = cid)
      }
      "speak_end" -> {
        // 不清队列：已排队的尾音自然播完
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
  }

  private fun stopAudioTrack() {
    val track = audioTrack
    audioTrack = null
    byteCarry = null
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
    ctrl.removeCallbacksAndMessages(null) // 取消挂起的重连
    closeWebSocket()
    currentRunId = ""
    reconnectAttempt = 0
    audioExecutor.execute { stopAudioTrack() }
    if (emitClosed) emitRealtime("closed")
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
