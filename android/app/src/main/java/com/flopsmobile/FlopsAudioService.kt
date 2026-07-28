package com.flopsmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder

/**
 * TTS 实时播报的前台服务：本身不持有音频（AudioTrack 在 FlopsAudioModule），只负责
 *  - 前台服务（type mediaPlayback）→ 让进程在后台 / 锁屏时保活并允许继续出声；
 *  - MediaSession（active）+ MediaStyle 通知 → 锁屏 / 通知栏显示"语音播报中"并提供停止。
 *
 * 音频焦点不在这里管：Service 存活 ≠ 在朗读（WS 空闲保活期不该压别人）。焦点由
 * FlopsAudioModule 按「朗读窗口」（speak_start→尾音播完）级别申请/释放，见其 mixingMode。
 *
 * 停止入口：通知的停止按钮 / MediaSession.onStop → 回调 FlopsAudioModule.stopFromService() 停流，
 * 再 stopSelf。JS 主动 stopRealtime 时由模块直接 stop(context) 拉掉本服务。
 */
class FlopsAudioService : Service() {

  private var mediaSession: MediaSession? = null

  companion object {
    private const val CHANNEL_ID = "flops_tts_broadcast"
    private const val NOTIF_ID = 4711
    const val ACTION_STOP = "com.flopsmobile.action.TTS_STOP"

    fun start(context: Context) {
      val intent = Intent(context, FlopsAudioService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (e: Exception) {
        // Android 12+：后台启动前台服务被限制（ForegroundServiceStartNotAllowedException）。
        // 播报开关基本在前台点，触到这里就跳过后台保活（音频仍会在前台播），不 crash。
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, FlopsAudioService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
    setupMediaSession()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      FlopsAudioModule.instance?.stopFromService()
      stopSelfCompat()
      return START_NOT_STICKY
    }
    startForegroundCompat()
    // 音频真值在 FlopsAudioModule（随进程存活）。进程被杀后不该只把服务拉起来空转，故 NOT_STICKY。
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    mediaSession?.apply {
      isActive = false
      release()
    }
    mediaSession = null
    super.onDestroy()
  }

  // ---- 前台通知 ----

  private fun startForegroundCompat() {
    val notif = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun stopSelfCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID, "语音播报", NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "实时语音播报进行中的常驻通知"
      setShowBadge(false)
    }
    mgr.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val stopIntent = PendingIntent.getService(
      this, 1,
      Intent(this, FlopsAudioService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    // 点通知回 App
    val contentIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 2, it, PendingIntent.FLAG_IMMUTABLE)
    }

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    builder
      .setContentTitle("语音播报中")
      .setContentText("Flops 正在朗读")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .addAction(
        Notification.Action.Builder(
          android.graphics.drawable.Icon.createWithResource(
            this, android.R.drawable.ic_menu_close_clear_cancel,
          ),
          "停止", stopIntent,
        ).build(),
      )

    mediaSession?.let { session ->
      builder.setStyle(
        Notification.MediaStyle()
          .setMediaSession(session.sessionToken)
          .setShowActionsInCompactView(0),
      )
    }
    return builder.build()
  }

  // ---- MediaSession（锁屏 / 媒体识别） ----

  private fun setupMediaSession() {
    val session = MediaSession(this, "FlopsAudio")
    session.setCallback(object : MediaSession.Callback() {
      override fun onStop() {
        FlopsAudioModule.instance?.stopFromService()
        stopSelfCompat()
      }
      override fun onPause() {
        FlopsAudioModule.instance?.stopFromService()
        stopSelfCompat()
      }
    })
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(PlaybackState.ACTION_STOP or PlaybackState.ACTION_PAUSE)
        .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
        .build(),
    )
    session.isActive = true
    mediaSession = session
  }

}
