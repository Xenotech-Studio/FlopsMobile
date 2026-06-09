/**
 * EquationSpan
 *
 * ReplacementSpan 子类，承载一个行内 LaTeX 公式（web 的 inline void {type:'equation', tex}）。
 * 对齐 iOS 的 EquationAttachment：用 AndroidMath 的 MTMathView 把 tex 渲染成 Bitmap，
 * 以一个 Object Replacement Character (U+FFFC) 占位，cursor 跨越 / 退格删除走原生原子语义。
 *
 * 基线对齐：MTMathView 量出的总高 = displayList.(ascent+descent)，但 displayList 是 private，
 * 用反射取 descent（MTDisplay.descent 是 public open 属性），把"公式数学基线"对齐到文字 baseline，
 * 跟 iOS 用 displayList.descent 同思路。取不到则退回 18% 经验值。
 */
package com.flopsmobile.flowdocinput

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.style.ReplacementSpan
import android.view.View
import com.agog.mathdisplay.MTMathView
import com.agog.mathdisplay.render.MTMathListDisplay

class EquationSpan(
  val tex: String,
  private val context: Context,
) : ReplacementSpan() {

  /** 字号（px）；由 view 注入 = EditText.textSize。AndroidMath fontSize 单位就是 device px。 */
  var fontSize: Float = 48f
    set(value) {
      if (field != value) { field = value; bitmap = null }
    }

  /** 公式颜色（由 view 注入 = 文字颜色）。 */
  var textColor: Int = Color.BLACK
    set(value) {
      if (field != value) { field = value; bitmap = null }
    }

  private var bitmap: Bitmap? = null
  private var ascentPx: Float = 0f // 图顶到数学基线的距离（基线以上高度）
  private var descentPx: Float = 0f // 数学基线到图底的距离（基线以下高度）

  private fun ensureBitmap() {
    if (bitmap != null) return
    val rendered = runCatching { renderMath(tex) }.getOrNull()
    val r = rendered ?: renderFallback(if (tex.isEmpty()) "∅" else tex)
    bitmap = r.first
    ascentPx = r.second
    descentPx = r.third
  }

  /** 用 MTMathView 渲染 tex → Bitmap；返回 (bitmap, ascentPx, descentPx)。解析失败/空尺寸返回 null 走兜底。 */
  private fun renderMath(tex: String): Triple<Bitmap, Float, Float>? {
    if (tex.isEmpty()) return null
    val mv = MTMathView(context)
    mv.latex = tex
    mv.fontSize = fontSize
    mv.textColor = textColor
    // 行内模式（对齐 web displayMode:false）
    mv.labelMode = MTMathView.MTMathViewMode.KMTMathViewModeText
    mv.setPadding(0, 0, 0, 0)

    val spec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    mv.measure(spec, spec)
    val w = mv.measuredWidth
    val h = mv.measuredHeight
    // 解析失败时 _mathList 为 null → onMeasure 量出 0 宽高 → 走兜底
    if (w < 1 || h < 1) return null
    mv.layout(0, 0, w, h)

    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    mv.draw(Canvas(bmp))

    // 反射取 private displayList.descent（MTDisplay.descent 是 public）；取不到退回 18%。
    val descent = runCatching {
      val f = MTMathView::class.java.getDeclaredField("displayList")
      f.isAccessible = true
      (f.get(mv) as? MTMathListDisplay)?.descent ?: (h * 0.18f)
    }.getOrDefault(h * 0.18f)
    val ascent = (h - descent).coerceAtLeast(0f)
    return Triple(bmp, ascent, descent)
  }

  /** 兜底：把 tex 源码以斜体灰字画成一张图（渲染失败时占位，不丢内容），仿 iOS fallbackImage。 */
  private fun renderFallback(text: String): Triple<Bitmap, Float, Float> {
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = fontSize
      color = textColor
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.ITALIC)
    }
    val fm = p.fontMetrics
    val padX = 2f
    val w = (p.measureText(text) + padX * 2).toInt().coerceAtLeast(1)
    val h = (fm.descent - fm.ascent).toInt().coerceAtLeast(1)
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    c.drawText(text, padX, -fm.ascent, p)
    // baseline 在图内 = -fm.ascent；descent = fm.descent
    return Triple(bmp, -fm.ascent, fm.descent)
  }

  override fun getSize(
    paint: Paint,
    text: CharSequence?,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int {
    ensureBitmap()
    val bmp = bitmap ?: return 0
    if (fm != null) {
      // 让行高至少能容下公式：ascent 在 baseline 之上（负），descent 在之下（正）
      val a = -ascentPx.toInt()
      val d = descentPx.toInt()
      fm.ascent = minOf(fm.ascent, a)
      fm.descent = maxOf(fm.descent, d)
      fm.top = minOf(fm.top, a)
      fm.bottom = maxOf(fm.bottom, d)
    }
    return bmp.width
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
    ensureBitmap()
    val bmp = bitmap ?: return
    // baseline = y；图顶放到 y - ascentPx，使图内数学基线落在文字 baseline 上
    canvas.drawBitmap(bmp, x, y - ascentPx, null)
  }
}
