/**
 * FlowDocCodeSpan
 *
 * 行内 code mark 的"字形"部分：等宽字体 + 0.9em（对齐 web / iOS 的 Menlo 0.9em）。
 * 颜色（红字 #eb5757）和背景（暖灰底）由独立的 Foreground/BackgroundColorSpan 承载，
 * 这样：
 *  - round-trip 时用本 span 是否存在判定 code（不靠 monospace 字符串猜）；
 *  - 红字是真实 ForegroundColorSpan，跟"用户 color mark"用同色判别区分（见 marksFromSpannableRange）。
 *
 * 必须是 MetricAffectingSpan：改了 textSize / typeface 会影响测量，纯 CharacterStyle 不会重排。
 */
package com.flopsmobile.flowdocinput

import android.graphics.Typeface
import android.text.TextPaint
import android.text.style.MetricAffectingSpan

class FlowDocCodeSpan : MetricAffectingSpan() {
  override fun updateDrawState(tp: TextPaint) = apply(tp)
  override fun updateMeasureState(tp: TextPaint) = apply(tp)

  private fun apply(tp: TextPaint) {
    tp.textSize = tp.textSize * 0.9f
    val style = tp.typeface?.style ?: Typeface.NORMAL
    tp.typeface = Typeface.create(Typeface.MONOSPACE, style)
  }
}
