package com.flopsmobile

import android.os.Build
import android.view.RoundedCorner
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 暴露屏幕物理圆角半径给 JS（用于让卡片式页面的圆角与设备屏幕物理圆角对齐，参考 Claude app 的抽屉打开效果）。
 *
 * API 31+ (Android 12)：通过 [android.view.WindowInsets.getRoundedCorner] 读取实际半径，取四个角中最大的。
 * API 30 及以下：没有公开 API，返回 0（JS 侧用兜底值）。
 */
class ScreenInfoModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ScreenInfo"

  @ReactMethod
  fun getScreenCornerRadius(promise: Promise) {
    try {
      promise.resolve(readCornerRadiusDp())
    } catch (t: Throwable) {
      // 任何反射 / WindowInsets 异常都不该 crash 启动屏，兜底 0 让 JS 走默认值
      promise.resolve(0.0)
    }
  }

  private fun readCornerRadiusDp(): Double {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 0.0
    val activity = getCurrentActivity() ?: return 0.0
    val insets = activity.window.decorView.rootWindowInsets ?: return 0.0
    val positions = listOf(
      RoundedCorner.POSITION_TOP_LEFT,
      RoundedCorner.POSITION_TOP_RIGHT,
      RoundedCorner.POSITION_BOTTOM_LEFT,
      RoundedCorner.POSITION_BOTTOM_RIGHT,
    )
    val maxRadiusPx = positions
      .mapNotNull { pos -> insets.getRoundedCorner(pos) }
      .maxOfOrNull { corner -> corner.radius } ?: 0
    if (maxRadiusPx == 0) return 0.0
    val density = reactApplicationContext.resources.displayMetrics.density
    return maxRadiusPx / density.toDouble()
  }
}
