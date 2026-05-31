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

  /**
   * 同步版：让 JS 在首帧 render 时就拿到圆角，避免"先窄后宽"闪烁（异步版要等 Promise 下一 tick）。
   * 主屏 render 时 activity 窗口已布局好、rootWindowInsets 可用，读取可靠；异常兜底 0。
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getScreenCornerRadiusSync(): Double {
    return try {
      readCornerRadiusDp()
    } catch (t: Throwable) {
      0.0
    }
  }

  /**
   * 同步读底部导航栏 inset（dp）—— 供首帧 render 直接取，避免 safe-area-context 首帧上报 0、
   * 底部避让"先贴底后上移"的闪。返回 -1 表示读不到（窗口未就绪等），JS 侧据此退回 safe-area 值。
   * 注意 0 是合法值（全面屏手势模式 = 无导航条）。
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getBottomInsetSync(): Double {
    return try {
      readBottomInsetDp()
    } catch (t: Throwable) {
      -1.0
    }
  }

  private fun readBottomInsetDp(): Double {
    val activity = getCurrentActivity() ?: return -1.0
    val insets = activity.window.decorView.rootWindowInsets ?: return -1.0
    val px = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      insets.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom
    } else {
      @Suppress("DEPRECATION")
      insets.systemWindowInsetBottom
    }
    val density = reactApplicationContext.resources.displayMetrics.density
    return px / density.toDouble()
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
