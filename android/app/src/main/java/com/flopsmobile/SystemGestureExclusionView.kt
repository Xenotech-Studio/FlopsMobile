package com.flopsmobile

import android.graphics.Rect
import android.os.Build
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup

/**
 * 左缘手势条：在视图坐标系内设置 [systemGestureExclusionRects]，降低系统边缘返回抢手势的概率。
 * 若仍触发返回，由 JS 侧 [BackHandler] 转为打开 Profile（见 ConversationListScreen）。
 */
class SystemGestureExclusionView(context: ThemedReactContext) : ReactViewGroup(context) {

  private fun applyExclusionRects() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val w = width
    val h = height
    if (w <= 0 || h <= 0) {
      systemGestureExclusionRects = emptyList()
      return
    }
    systemGestureExclusionRects = listOf(Rect(0, 0, w, h))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    post { applyExclusionRects() }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    applyExclusionRects()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    post { applyExclusionRects() }
  }
}
