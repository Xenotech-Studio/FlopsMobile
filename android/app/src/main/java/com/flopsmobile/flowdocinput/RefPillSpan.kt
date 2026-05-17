/**
 * RefPillSpan
 *
 * ReplacementSpan 子类，承载一个 ref-pill 的语义数据 + 视觉渲染。
 * 在 Spannable 里以一个 Object Replacement Character (U+FFFC) 占位；
 * 由于 span 覆盖一个字符宽度，cursor 跨越 / 退格删除走 Android 文本系统的原生原子语义。
 */
package com.flopsmobile.flowdocinput

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.style.ReplacementSpan

class RefPillSpan(
  val refKey: String,
  val mention: String,
  val title: String,
  val isPointer: Boolean,
) : ReplacementSpan() {

  /** 视觉样式（由 view 注入），改完会通过 view.invalidate() 强制重绘 */
  var pillBackgroundColor: Int = Color.parseColor("#EBEBEB")
  var pillTextColor: Int = Color.parseColor("#595959")
  /** 字号（px）；通常 = view fontSize - 2 */
  var pillFontSize: Float = 14f

  private val paddingH: Float = 8f
  private val paddingV: Float = 2f
  private val cornerRadius: Float = 999f

  private val pillFont: Typeface = Typeface.DEFAULT

  /** 显示文本：mention 去掉首字符 "@"；fallback title */
  private fun displayLabel(): String {
    val m = mention
    val stripped = if (m.startsWith("@")) m.substring(1) else m
    return if (stripped.isNotEmpty()) stripped else title
  }

  private fun composedText(): String = "📄  ${displayLabel()}"

  override fun getSize(
    paint: Paint,
    text: CharSequence?,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int {
    val p = Paint(paint).apply {
      typeface = pillFont
      textSize = pillFontSize
    }
    val textWidth = p.measureText(composedText())
    val pillFm = p.fontMetricsInt
    val pillHeight = (pillFm.descent - pillFm.ascent) + paddingV.toInt() * 2

    if (fm != null) {
      // 让行高至少能容下 pill；ascent / descent 用 pill 自己的 metric 顶起来
      val pillAscent = pillFm.ascent - paddingV.toInt()
      val pillDescent = pillFm.descent + paddingV.toInt()
      fm.ascent = minOf(fm.ascent, pillAscent)
      fm.descent = maxOf(fm.descent, pillDescent)
      fm.top = minOf(fm.top, pillAscent)
      fm.bottom = maxOf(fm.bottom, pillDescent)
    }

    return (textWidth + paddingH * 2).toInt()
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence?,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    val p = Paint(paint).apply {
      typeface = pillFont
      textSize = pillFontSize
    }
    val display = composedText()
    val textWidth = p.measureText(display)
    val pillFm = p.fontMetricsInt
    val textHeight = pillFm.descent - pillFm.ascent
    val totalWidth = textWidth + paddingH * 2
    val totalHeight = textHeight + paddingV * 2

    // 把 pill 垂直居中到 baseline；baseline = y
    val pillBaseline = y.toFloat()
    val pillTop = pillBaseline + pillFm.ascent - paddingV
    val rect = RectF(x, pillTop, x + totalWidth, pillTop + totalHeight)

    val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = pillBackgroundColor }
    canvas.drawRoundRect(rect, totalHeight / 2f, totalHeight / 2f, bg)

    p.color = pillTextColor
    canvas.drawText(display, x + paddingH, pillBaseline, p)
  }
}
