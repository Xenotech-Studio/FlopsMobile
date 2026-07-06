/**
 * FlowDocInputView (Android)
 *
 * EditText 子类，对齐 iOS FlowDocInputView 的语义：
 * - 文本 + 原子 ref-pill（用 RefPillSpan + U+FFFC 占位）
 * - 退格 / 光标跨越走系统原生原子语义（span 覆盖 1 个字符宽度，删 char = 删 pill）
 * - 通过 onSelectionChanged / TextWatcher 上报状态变化
 *
 * Fabric 事件用 EventDispatcher 派发；prop / command 由 FlowDocInputViewManager 转入。
 */
package com.flopsmobile.flowdocinput

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Editable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.InputType
import android.text.method.ArrowKeyMovementMethod
import android.text.method.LinkMovementMethod
import android.text.style.BackgroundColorSpan
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.View
import androidx.appcompat.widget.AppCompatEditText
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import org.json.JSONArray
import org.json.JSONObject

private const val OBJ_REPL_CHAR = '￼'

/* 行内 code 视觉常量（对齐 web .slate-editor code / iOS）：红字 #eb5757 + 暖灰底 rgba(135,131,120,0.15)。
   字体等宽 + 0.9em 由 FlowDocCodeSpan 承载。红字是真实 ForegroundColorSpan，round-trip 时用同色判别
   跟"用户 color mark"区分（见 marksFromSpannableRange）。 */
private val CODE_TEXT_COLOR = Color.parseColor("#eb5757")
private val CODE_BG_COLOR = Color.argb((0.15f * 255).toInt(), 135, 131, 120)
private const val CODE_TEXT_HEX = "#EB5757" // "#%06X".format 产出大写，用于反查时识别"code 红字"

/** 语音听写 pending 文字的标记 span：继承 ForegroundColorSpan 拿到灰色渲染，同时作为可识别的
 *  类型用于定位 pending 段。带此 span 的文字 = 临时听写文字，不参与 currentContentJson 序列化。 */
private class DictationPendingSpan(color: Int) : ForegroundColorSpan(color)

class FlowDocInputView(context: Context) : AppCompatEditText(context) {

  private var initialContentApplied = false
  private var suppressTextWatcher = false
  var enterCreatesBlock: Boolean = true
  /** 当前语音听写 pending 段的标记 span（挂在 editableText 尾部）。null = 无 pending。 */
  private var dictationPendingSpan: DictationPendingSpan? = null

  var pillBackgroundColor: Int = Color.parseColor("#EBEBEB")
    set(value) {
      field = value
      refreshAllPillSpans()
    }
  var pillTextColorInt: Int = Color.parseColor("#595959")
    set(value) {
      field = value
      refreshAllPillSpans()
    }
  /** Pill 视觉截短上限（dp）；view 把 dp 转 px 注入到每条 RefPillSpan。<=0 关视觉截短。 */
  private var pillMaxLabelTextWidthDp: Float = 140f
  fun setPillMaxLabelTextWidthDp(dp: Float) {
    pillMaxLabelTextWidthDp = dp
    refreshAllPillSpans()
  }
  private fun pillMaxLabelTextWidthPx(): Float =
    pillMaxLabelTextWidthDp * resources.displayMetrics.density

  /* textContainerInset 四边（dp）。等效 iOS UITextView.textContainerInset：让 EditText
     view 撑满外层 wrapper，视觉留白靠 EditText 自身 padding。这样 EditText 的 tap recognizer
     覆盖整片 hit area，外层任何区域 tap 都会走 EditText 自己的 cursor placement / selection
     语义。 */
  private var insetTopDp: Float = 0f
  private var insetLeftDp: Float = 0f
  private var insetBottomDp: Float = 0f
  private var insetRightDp: Float = 0f
  private fun applyTextContainerInsetPadding() {
    val d = resources.displayMetrics.density
    setPadding(
      (insetLeftDp * d).toInt(),
      (insetTopDp * d).toInt(),
      (insetRightDp * d).toInt(),
      (insetBottomDp * d).toInt(),
    )
  }
  fun setTextContainerInsetTopDp(dp: Float) {
    insetTopDp = dp; applyTextContainerInsetPadding()
  }
  fun setTextContainerInsetLeftDp(dp: Float) {
    insetLeftDp = dp; applyTextContainerInsetPadding()
  }
  fun setTextContainerInsetBottomDp(dp: Float) {
    insetBottomDp = dp; applyTextContainerInsetPadding()
  }
  fun setTextContainerInsetRightDp(dp: Float) {
    insetRightDp = dp; applyTextContainerInsetPadding()
  }

  init {
    background = null
    setPadding(0, 0, 0, 0)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    /* setPadding(0,0,0,0) 把 EditText 默认垂直留白也清了，加上默认 Gravity.TOP，
       单行文本会贴在 view 顶部；autoHeight 模式下 view 高度 ≈ COMPOSER_PILL_SIZE 比
       1 行文本高，视觉上文本偏上。CENTER_VERTICAL 让单行落到几何中心；多行 autoHeight
       view 高度 = 内容高度，gravity 在此情况下视觉上无差异。
       includeFontPadding=false 顺便去掉字体 ascender/descender 多算的留白，让居中更准。 */
    gravity = Gravity.CENTER_VERTICAL or Gravity.START
    includeFontPadding = false

    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable?) {
        if (suppressTextWatcher) return
        /* enterCreatesBlock=true 时，把刚出现的 '\n' 撤掉 + 发 split 事件给 JS。
           soft keyboard 的 Enter 走的是 commitText("\n") 路径，OnKeyListener 兜不住，
           只能 TextWatcher 检测。*/
        if (enterCreatesBlock && s != null) {
          val nlIndex = s.toString().indexOf('\n')
          if (nlIndex >= 0) {
            val combined = s.toString().substring(0, nlIndex) + s.toString().substring(nlIndex + 1)
            suppressTextWatcher = true
            s.replace(0, s.length, combined)
            setSelection(minOf(nlIndex, combined.length))
            suppressTextWatcher = false
            emitSplitRequest(nlIndex)
            return
          }
        }
        emitContentChange()
        /* typed 触发的内部 invalidate 已经 update textLayout，post 一次直接读
           layout.height emit 给 JS（autoHeight 路径 + tall 模式多行展开高度跟随）。
           不要走 forced measure(UNSPECIFIED) —— EXACTLY ↔ UNSPECIFIED 的 spec 切换会让
           EditText 内部用不同 paint metric 重建 textLayout，单行 typed 后文字 baseline
           上挪 + 视觉缩小（曾经踩过这个坑）。 */
        post { maybeEmitContentSize() }
      }
    })

    setOnFocusChangeListener { _, hasFocus ->
      if (hasFocus) emitFocusEvent("onFocusNative") else emitFocusEvent("onBlurNative")
    }
  }

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    emitSelectionEvent(selStart, selEnd)
  }

  private var lastReportedContentHeight = 0
  private var lastReportedContentWidth = 0

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    maybeEmitContentSize()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    if (changed) maybeEmitContentSize()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    /* JS 端 autoHeight：先 setHeight=旧 contentHeight，再 setText 长出多行。
       此时 parent 的 heightMeasureSpec 还是旧值，onSizeChanged / onLayout(changed)
       都不会 fire，只有 onMeasure 一定走。这里 post 一次 emit，让 layout 拿到的
       真实内容高度有机会上报回 JS，再触发新的 layout pass。 */
    post { maybeEmitContentSize() }
  }

  /* 行内 code 圆角底（对齐 iOS 自定义 NSLayoutManager 画的圆角背景）。暖灰底 + 圆角 4dp +
     横向外扩 3dp 模拟 web code padding 的呼吸感（不移动文字，区别于 iOS 用 kern 推开）。
     在 super.onDraw 之前画，落在文字下方。 */
  private val codeBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = CODE_BG_COLOR }

  override fun onDraw(canvas: Canvas) {
    drawCodeBackgrounds(canvas)
    super.onDraw(canvas)
  }

  private fun drawCodeBackgrounds(canvas: Canvas) {
    val spanned = text as? Spanned ?: return
    val spans = spanned.getSpans(0, spanned.length, FlowDocCodeSpan::class.java)
    if (spans.isEmpty()) return
    val lyt = layout ?: return
    val density = resources.displayMetrics.density
    val radius = 4f * density
    val padH = 3f * density
    val padV = 1f * density

    /* 盒子高度按 code 字体自身（0.9em 等宽）的 ascent/descent 算，恒定 —— 不用 getLineAscent/Descent，
       那是整行的上下沿（由行内最高内容决定），code 单独成行时矮、跟正文同行时被撑高 → 高矮不定。
       baseline 各行共享，所以用 code 度量 + 每行 baseline 就能稳稳裹住 code 字形（对齐 iOS 按 code 字体画）。 */
    val codeFm = Paint().apply {
      textSize = this@FlowDocInputView.textSize * 0.9f
      typeface = Typeface.MONOSPACE
    }.fontMetrics
    val codeAscent = codeFm.ascent // 负
    val codeDescent = codeFm.descent

    /* 复刻 TextView 画 Layout 时的画布平移：水平 compoundPaddingLeft、垂直 compoundPaddingTop +
       垂直 gravity 偏移（本 view 用 CENTER_VERTICAL；autoHeight 时 view 高=内容高 → voffset≈0，
       单行偏矮时才非 0）。再减 scrollX/scrollY（viewer 不滚，保险）。算法照搬 TextView.getVerticalOffset。 */
    var voffset = 0
    val gravityV = gravity and Gravity.VERTICAL_GRAVITY_MASK
    if (gravityV != Gravity.TOP) {
      val boxHt = height - compoundPaddingTop - compoundPaddingBottom
      val textHt = lyt.height
      if (textHt < boxHt) {
        voffset = if (gravityV == Gravity.BOTTOM) boxHt - textHt else (boxHt - textHt) / 2
      }
    }

    canvas.save()
    canvas.translate(
      (compoundPaddingLeft - scrollX).toFloat(),
      (compoundPaddingTop + voffset - scrollY).toFloat(),
    )
    for (s in spans) {
      val st = spanned.getSpanStart(s)
      val en = spanned.getSpanEnd(s)
      if (st < 0 || en <= st) continue
      val lineStart = lyt.getLineForOffset(st)
      val lineEnd = lyt.getLineForOffset(en)
      for (line in lineStart..lineEnd) {
        /* 每行的左右边界：
           - code 起始行用 getPrimaryHorizontal(st)，否则续行从整行左沿 getLineLeft 起；
           - code 结束行用 getPrimaryHorizontal(en)，否则本行 code 延伸到整行右沿 getLineRight。
           不能对换行边界的 offset 用 getPrimaryHorizontal —— 那个 offset 会被算到下一行行首（≈左边），右界变错。 */
        val xL = if (line == lineStart) lyt.getPrimaryHorizontal(st) else lyt.getLineLeft(line)
        val xR = if (line == lineEnd) lyt.getPrimaryHorizontal(en) else lyt.getLineRight(line)
        val l = minOf(xL, xR)
        val r = maxOf(xL, xR)
        if (r <= l) continue // 空行 / 该行无可见 code
        // 上下沿 = 该行 baseline + code 字体 ascent/descent（恒定高度，不随同行其它内容变）
        val baseline = lyt.getLineBaseline(line)
        val top = baseline + codeAscent - padV
        val bottom = baseline + codeDescent + padV
        canvas.drawRoundRect(l - padH, top, r + padH, bottom, radius, radius, codeBgPaint)
      }
    }
    canvas.restore()
  }

  private fun maybeEmitContentSize() {
    /* 用 TextView 内部 layout.height（内容真实所需高度）而不是 measuredHeight
       （受 parent 的 EXACTLY measure spec 约束、始终等于 JS 给的旧 contentHeight）。
       对齐 iOS sizeThatFits 的"无 height 约束 measure"语义。 */
    val w = measuredWidth
    if (w <= 0) return
    val tlayout = layout ?: return
    val h = tlayout.height + paddingTop + paddingBottom
    if (h <= 0) return
    if (w == lastReportedContentWidth && h == lastReportedContentHeight) return
    lastReportedContentWidth = w
    lastReportedContentHeight = h
    val payload = Arguments.createMap().apply {
      putDouble("width", w.toDouble() / resources.displayMetrics.density)
      putDouble("height", h.toDouble() / resources.displayMetrics.density)
    }
    dispatchEvent("topContentSizeChange", payload)
  }

  // MARK: - Property setters called by ViewManager

  fun setFontSizeSp(size: Float) {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
    refreshAllPillSpans()
  }

  /** 字体族（如 "Menlo" → "monospace"）。空 = 系统默认 */
  fun setFontFamilyName(family: String?) {
    val tf = when {
      family.isNullOrBlank() -> Typeface.DEFAULT
      family.equals("Menlo", ignoreCase = true) ||
        family.equals("Courier", ignoreCase = true) ||
        family.equals("monospace", ignoreCase = true) -> Typeface.MONOSPACE
      family.equals("serif", ignoreCase = true) -> Typeface.SERIF
      family.equals("sans-serif", ignoreCase = true) -> Typeface.SANS_SERIF
      else -> {
        runCatching { Typeface.create(family, Typeface.NORMAL) }.getOrNull() ?: Typeface.DEFAULT
      }
    }
    typeface = tf
  }

  fun setCustomLineHeight(lineHeight: Float) {
    if (lineHeight > 0) {
      /* 用 setLineSpacing(extra,1) 而不是 setLineHeight()：对齐 iOS 改用 lineSpacing 的理由——
         setLineHeight 把多余行距按 ascent/descent 比例摊到文字上下，首行文字被往下推，跟
         RN 侧画的列表 bullet（贴行顶）baseline 错位；lineSpacing 只在行间补空、文字保持自然顶位，
         既有 web line-height 行距观感又不破坏 baseline。
         JS 端 prop 单位是 dp，先 dp→px；extra = 目标行高 - 字体自然行高。 */
      val targetPx = lineHeight * resources.displayMetrics.density
      val fm = paint.fontMetrics
      val naturalPx = fm.descent - fm.ascent
      val extra = (targetPx - naturalPx).coerceAtLeast(0f)
      setLineSpacing(extra, 1.0f)
    } else {
      setLineSpacing(0f, 1.0f)
    }
  }

  fun setTextColorInt(color: Int) {
    setTextColor(color)
  }

  fun setPlaceholderText(value: String?) {
    hint = value
  }

  fun setPlaceholderColorInt(color: Int) {
    setHintTextColor(color)
  }

  fun setEditableInput(value: Boolean) {
    isFocusable = value
    isFocusableInTouchMode = value
    isEnabled = value
    /* 链接可点（对齐 iOS：仅非编辑态）。LinkMovementMethod 会接管 tap → 触发 ClickableSpan，
       但也会干扰编辑态的光标/选区，所以编辑态恢复 EditText 默认的 ArrowKeyMovementMethod。 */
    movementMethod = if (value) ArrowKeyMovementMethod.getInstance() else LinkMovementMethod.getInstance()
  }

  // MARK: - Commands

  fun setInitialContentJson(json: String) {
    if (initialContentApplied) return
    initialContentApplied = true
    applyContentJson(json, moveCursorToEnd = false, emit = false)
  }

  /** Fabric 把 view 回收进池时调（见 FlowDocInputViewManager.prepareToRecycleView）。
   *  复用前必须把 initialContentApplied 归零，否则下次 setInitialContent 被 guard 跳过、新内容
   *  显示不出来。同时直接清空文本——否则复用到一个 initialContent 仍等于默认 "[]" 的节点（典型：
   *  空 chat composer）时 prop diffing 不会重下发 initialContent，上一个节点（如文档首块）残留的
   *  文本就泄漏进输入框。清空时压住 textWatcher，避免误触 onChangeContent。 */
  fun resetForRecycle() {
    initialContentApplied = false
    dictationPendingSpan = null
    suppressTextWatcher = true
    setText("")
    suppressTextWatcher = false
  }

  fun setContentJson(json: String) {
    applyContentJson(json, moveCursorToEnd = true, emit = true)
  }

  fun insertPill(refKey: String, mention: String, title: String, isPointer: Boolean) {
    // 去重：同 refKey 已存在则不插
    val text = text ?: SpannableStringBuilder()
    val existing = text.getSpans(0, text.length, RefPillSpan::class.java)
    if (existing.any { it.refKey == refKey }) return

    val span = RefPillSpan(refKey, mention, title, isPointer).also {
      it.pillBackgroundColor = pillBackgroundColor
      it.pillTextColor = pillTextColorInt
      it.pillFontSize = textSize * 0.875f // 小一档（iOS 同款比例）
      it.maxLabelTextWidthPx = pillMaxLabelTextWidthPx()
    }

    val pillPiece = SpannableStringBuilder().apply {
      append(OBJ_REPL_CHAR)
      setSpan(span, 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      append(' ')
    }

    val cursor = selectionStart.coerceAtLeast(0)
    val end = selectionEnd.coerceAtLeast(cursor)
    suppressTextWatcher = true
    text.replace(cursor, end, pillPiece)
    setSelection(cursor + pillPiece.length)
    suppressTextWatcher = false
    emitContentChange()
  }

  fun removePill(refKey: String) {
    val t = text ?: return
    val spans = t.getSpans(0, t.length, RefPillSpan::class.java)
    val target = spans.firstOrNull { it.refKey == refKey } ?: return
    val start = t.getSpanStart(target)
    val end = t.getSpanEnd(target)
    suppressTextWatcher = true
    t.delete(start, end)
    suppressTextWatcher = false
    emitContentChange()
  }

  /** 对当前选区加 mark。mark = bold / italic / code / color；color 用 value 传 hex */
  fun applyMark(mark: String, value: String) {
    val t = text ?: return
    val start = selectionStart
    val end = selectionEnd
    if (start < 0 || end <= start) return
    when (mark) {
      "bold" -> applyStyleSpan(t, start, end, Typeface.BOLD)
      "italic" -> applyStyleSpan(t, start, end, Typeface.ITALIC)
      "code" -> {
        // 移除原有可能的 bold/italic，code 走独立 typeface（等宽 0.9em）+ 红字；圆角底由 onDraw 画
        removeSpansInRange(t, start, end, StyleSpan::class.java)
        t.setSpan(FlowDocCodeSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        // 无显式 color mark 时用红字；已有 ForegroundColorSpan 则保留用户色（对齐 iOS）
        if (t.getSpans(start, end, ForegroundColorSpan::class.java).isEmpty()) {
          t.setSpan(ForegroundColorSpan(CODE_TEXT_COLOR), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        invalidate() // 触发 onDraw 重画圆角底
      }
      "color" -> {
        try {
          val color = Color.parseColor(value)
          removeSpansInRange(t, start, end, ForegroundColorSpan::class.java)
          t.setSpan(ForegroundColorSpan(color), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        } catch (_: Throwable) {
          /* 颜色非法忽略 */
        }
      }
    }
    emitContentChange()
  }

  fun removeMark(mark: String) {
    val t = text ?: return
    val start = selectionStart
    val end = selectionEnd
    if (start < 0 || end <= start) return
    when (mark) {
      "bold" -> removeStyleSpanFlag(t, start, end, Typeface.BOLD)
      "italic" -> removeStyleSpanFlag(t, start, end, Typeface.ITALIC)
      "code" -> {
        removeSpansInRange(t, start, end, FlowDocCodeSpan::class.java)
        removeSpansInRange(t, start, end, BackgroundColorSpan::class.java)
        // 去掉 code 自带的红字（仅当前景正是 code 红，避免误删用户 color mark）
        for (s in t.getSpans(start, end, ForegroundColorSpan::class.java)) {
          if ("#%06X".format(0xFFFFFF and s.foregroundColor) == CODE_TEXT_HEX) t.removeSpan(s)
        }
      }
      "color" -> removeSpansInRange(t, start, end, ForegroundColorSpan::class.java)
    }
    emitContentChange()
  }

  // MARK: - Voice dictation pending text

  /** pending 文字灰色：正文色叠 50% alpha（对齐 Web 版 asrPending opacity 0.5、iOS 同款）。 */
  private fun dictationPendingColor(): Int =
    (currentTextColor and 0x00FFFFFF) or (0x80 shl 24)

  /** 在尾部渲染/整体替换一段灰色 pending 文字。不 emitContentChange（pending 不算已提交内容）。 */
  fun setDictationPending(pendingText: String) {
    val t = editableText ?: return
    val span = dictationPendingSpan
    // pending 段恒在尾部：已有则整体替换其区间，否则从当前末尾新开一段
    val from = if (span != null) t.getSpanStart(span).coerceAtLeast(0) else t.length
    val to = if (span != null) t.getSpanEnd(span).coerceAtLeast(from) else t.length

    suppressTextWatcher = true
    if (span != null) t.removeSpan(span)
    t.replace(from, to, pendingText)
    val newSpan = DictationPendingSpan(dictationPendingColor())
    if (pendingText.isNotEmpty()) {
      t.setSpan(newSpan, from, from + pendingText.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      dictationPendingSpan = newSpan
      setSelection(from + pendingText.length)
    } else {
      // 空 pending：不挂 span，但仍处于 pending 态（下次调用从末尾重开）
      dictationPendingSpan = null
      setSelection(from.coerceAtMost(t.length))
    }
    suppressTextWatcher = false
    requestLayout()
  }

  /** 提交 pending：抹掉灰色标记 span，文字转正常色成为正式内容，触发一次内容变化。 */
  fun commitDictation() {
    val t = editableText
    val span = dictationPendingSpan
    if (t == null || span == null) {
      dictationPendingSpan = null
      return
    }
    val end = t.getSpanEnd(span).coerceAtLeast(0)
    suppressTextWatcher = true
    t.removeSpan(span) // 去掉灰色 ForegroundColorSpan → 恢复默认正文色
    dictationPendingSpan = null
    setSelection(end.coerceAtMost(t.length))
    suppressTextWatcher = false
    emitContentChange()
  }

  /** 取消 pending：删除灰色文字，不进入内容。 */
  fun cancelDictation() {
    val t = editableText
    val span = dictationPendingSpan
    if (t == null || span == null) {
      dictationPendingSpan = null
      return
    }
    val from = t.getSpanStart(span).coerceAtLeast(0)
    val to = t.getSpanEnd(span).coerceAtLeast(from)
    suppressTextWatcher = true
    t.removeSpan(span)
    if (to > from) t.delete(from, to)
    dictationPendingSpan = null
    setSelection(from.coerceAtMost(t.length))
    suppressTextWatcher = false
    requestLayout()
  }

  /** 给 [start,end) 加一个 BOLD / ITALIC StyleSpan；先合并区间内已有 StyleSpan 防止叠加 */
  private fun applyStyleSpan(t: Editable, start: Int, end: Int, addFlag: Int) {
    val existing = t.getSpans(start, end, StyleSpan::class.java)
    var unionFlags = addFlag
    for (s in existing) {
      val ss = t.getSpanStart(s)
      val se = t.getSpanEnd(s)
      // 仅整段覆盖的才合并；部分覆盖留给逐字符细化
      if (ss <= start && se >= end) {
        unionFlags = unionFlags or s.style
        t.removeSpan(s)
      }
    }
    t.setSpan(StyleSpan(unionFlags), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  /** 从 [start,end) 内的 StyleSpan 上移除某个 flag（bold / italic）；若清空则去掉 span */
  private fun removeStyleSpanFlag(t: Editable, start: Int, end: Int, flag: Int) {
    val spans = t.getSpans(start, end, StyleSpan::class.java)
    for (s in spans) {
      val ss = t.getSpanStart(s)
      val se = t.getSpanEnd(s)
      val newFlags = s.style and flag.inv()
      t.removeSpan(s)
      if (newFlags != 0) {
        t.setSpan(StyleSpan(newFlags), ss, se, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    }
  }

  private fun <T : Any> removeSpansInRange(t: Editable, start: Int, end: Int, clazz: Class<T>) {
    val spans = t.getSpans(start, end, clazz)
    for (s in spans) t.removeSpan(s)
  }

  fun focusInput() {
    requestFocus()
    /* Android 上 requestFocus() 只让 view 获得 focus state，不自动弹 IME。EditText 在
     * native user-initiated tap 时系统会自动 showSoftInput；但 imperative focus（比如
     * RN 上层 ref.current.focus()）需要这里显式 showSoftInput 才弹键盘。跟 blurInput()
     * 显式 hideSoftInputFromWindow 对称。 */
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(this, 0)
  }

  fun focusInputAtOffset(offset: Int) {
    requestFocus()
    if (offset < 0) return
    val len = text?.length ?: 0
    val pos = offset.coerceIn(0, len)
    setSelection(pos)
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(this, 0)
  }

  fun blurInput() {
    /* Android 上 clearFocus() 只让 view 失去焦点，软键盘是独立的 IME service 不会跟着收。
     * 必须显式 hideSoftInputFromWindow 把 IME 收掉。先收键盘再 clearFocus，避免 IME
     * 在 focus 转移到别处时被系统重新拉起。 */
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(windowToken, 0)
    clearFocus()
  }

  // MARK: - Helpers

  private fun applyContentJson(json: String, moveCursorToEnd: Boolean, emit: Boolean) {
    val arr: JSONArray = try {
      JSONArray(json)
    } catch (_: Throwable) {
      return
    }
    val builder = SpannableStringBuilder()
    for (i in 0 until arr.length()) {
      val item = arr.optJSONObject(i) ?: continue
      val type = item.optString("type")
      when (type) {
        "text" -> {
          val t = item.optString("text", "")
          if (t.isNotEmpty()) {
            val startPos = builder.length
            builder.append(t)
            applyMarksToBuilder(builder, item.optJSONObject("marks"), startPos, startPos + t.length)
          }
        }
        "pill" -> {
          val refKey = item.optString("refKey", "")
          if (refKey.isEmpty()) continue
          val mention = item.optString("mention", "")
          val title = item.optString("title", "")
          val isPointer = item.optBoolean("isPointer", false)
          val span = RefPillSpan(refKey, mention, title, isPointer).also {
            it.pillBackgroundColor = pillBackgroundColor
            it.pillTextColor = pillTextColorInt
            it.pillFontSize = textSize * 0.875f
            it.maxLabelTextWidthPx = pillMaxLabelTextWidthPx()
          }
          val startPos = builder.length
          builder.append(OBJ_REPL_CHAR)
          builder.setSpan(span, startPos, startPos + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        "equation" -> {
          // 行内 LaTeX 公式（对齐 iOS EquationAttachment）：用 U+FFFC 占位 + EquationSpan 渲染
          val tex = item.optString("tex", "")
          val span = EquationSpan(tex, context).also {
            it.fontSize = textSize
            it.textColor = currentTextColor
          }
          val startPos = builder.length
          builder.append(OBJ_REPL_CHAR)
          builder.setSpan(span, startPos, startPos + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
      }
    }

    suppressTextWatcher = true
    setText(builder)
    // 全量替换文本作废任何尾部 pending（setText 已清掉其 span）
    dictationPendingSpan = null
    if (moveCursorToEnd) {
      setSelection(builder.length)
    }
    suppressTextWatcher = false
    if (emit) emitContentChange()
  }

  /** 把 marks JSON 字典翻译成 Span 加到 builder 的 [start,end) 区间。
   *  - bold / italic / bold+italic → StyleSpan
   *  - code → TypefaceSpan("monospace") + BackgroundColorSpan
   *  - color → ForegroundColorSpan */
  private fun applyMarksToBuilder(
    builder: SpannableStringBuilder,
    marks: JSONObject?,
    start: Int,
    end: Int,
  ) {
    if (marks == null || start >= end) return
    val bold = marks.optBoolean("bold", false)
    val italic = marks.optBoolean("italic", false)
    val code = marks.optBoolean("code", false)
    val colorStr = if (marks.has("color")) marks.optString("color", "") else ""
    val linkStr = if (marks.has("link")) marks.optString("link", "") else ""

    // 字形：code 走等宽 0.9em（独占，不叠 bold/italic，对齐 iOS code 用 Menlo 不加粗斜）；否则 bold/italic。
    // 暖灰底+圆角由 onDraw 按 FlowDocCodeSpan 范围画（见 drawCodeBackgrounds），不再用方角 BackgroundColorSpan。
    if (code) {
      builder.setSpan(FlowDocCodeSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (bold && italic) {
      builder.setSpan(StyleSpan(Typeface.BOLD_ITALIC), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (bold) {
      builder.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (italic) {
      builder.setSpan(StyleSpan(Typeface.ITALIC), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    /* 前景色优先级（对齐 iOS attributesForMarks）：link 链接色 > 用户 color mark > code 红字 > 默认。
       link 的链接色 + 下划线由 FlowDocLinkSpan.updateDrawState 承载，不再叠 ForegroundColorSpan。 */
    val userColor: Int? =
      if (colorStr.isNotEmpty()) runCatching { Color.parseColor(colorStr) }.getOrNull() else null
    if (linkStr.isNotEmpty()) {
      builder.setSpan(FlowDocLinkSpan(linkStr), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (userColor != null) {
      builder.setSpan(ForegroundColorSpan(userColor), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (code) {
      builder.setSpan(ForegroundColorSpan(CODE_TEXT_COLOR), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
  }

  /** 反向：扫描 [start,end) 内 Spannable 上挂的 CharacterStyle，构造 marks JSON；纯文本返回 null */
  private fun marksFromSpannableRange(text: Spanned, start: Int, end: Int): JSONObject? {
    if (start >= end) return null
    var bold = false
    var italic = false
    var code = false
    var colorHex: String? = null
    var link: String? = null
    val spans = text.getSpans(start, end, CharacterStyle::class.java)
    for (s in spans) {
      val ss = text.getSpanStart(s)
      val se = text.getSpanEnd(s)
      if (se <= start || ss >= end) continue
      when (s) {
        is StyleSpan -> when (s.style) {
          Typeface.BOLD -> bold = true
          Typeface.ITALIC -> italic = true
          Typeface.BOLD_ITALIC -> { bold = true; italic = true }
        }
        is FlowDocCodeSpan -> code = true
        is FlowDocLinkSpan -> link = s.url
        is ForegroundColorSpan -> colorHex = "#%06X".format(0xFFFFFF and s.foregroundColor)
        is BackgroundColorSpan -> { /* code 暖灰底，跟 FlowDocCodeSpan 配套，不当 mark */ }
      }
    }
    /* code 红字 / link 链接色是我们加的样式而非用户 color mark（对齐 iOS）→ 不当 color 上报 */
    if (link != null) colorHex = null
    else if (code && colorHex == CODE_TEXT_HEX) colorHex = null
    if (!bold && !italic && !code && colorHex == null && link == null) return null
    return JSONObject().apply {
      if (bold) put("bold", true)
      if (italic) put("italic", true)
      if (code) put("code", true)
      if (colorHex != null) put("color", colorHex)
      if (link != null) put("link", link)
    }
  }

  private fun refreshAllPillSpans() {
    val t = text ?: return
    val spans = t.getSpans(0, t.length, RefPillSpan::class.java)
    for (s in spans) {
      s.pillBackgroundColor = pillBackgroundColor
      s.pillTextColor = pillTextColorInt
      s.pillFontSize = textSize * 0.875f
      s.maxLabelTextWidthPx = pillMaxLabelTextWidthPx()
    }
    invalidate()
  }

  // MARK: - Serialization

  fun currentContentJson(): String {
    val t = text ?: return "[]"
    val arr = JSONArray()

    /* 灰色语音 pending 文字恒在尾部，不算已提交内容：序列化只覆盖 [0, serializeEnd)。 */
    val serializeEnd = dictationPendingSpan?.let { t.getSpanStart(it).coerceIn(0, t.length) } ?: t.length

    /* 收集原子对象（pill + equation），按位置排序后与中间文字交错。
       两类都以 1 个 U+FFFC 占位，跟 iOS 的 attachment 序列化同思路。 */
    val atoms = ArrayList<Triple<Int, Int, JSONObject>>()
    for (p in t.getSpans(0, t.length, RefPillSpan::class.java)) {
      atoms.add(Triple(t.getSpanStart(p), t.getSpanEnd(p), JSONObject().apply {
        put("type", "pill")
        put("refKey", p.refKey)
        put("mention", p.mention)
        put("title", p.title)
        put("isPointer", p.isPointer)
      }))
    }
    for (e in t.getSpans(0, t.length, EquationSpan::class.java)) {
      atoms.add(Triple(t.getSpanStart(e), t.getSpanEnd(e), JSONObject().apply {
        put("type", "equation")
        put("tex", e.tex)
      }))
    }
    atoms.sortBy { it.first }

    var cursor = 0
    for ((start, end, json) in atoms) {
      if (start >= serializeEnd) break // 落在 pending 尾部（正常不会有原子，防御性跳过）
      if (start > cursor) {
        // 把 [cursor, start) 这段文字按 mark 边界拆成多个 text part
        appendTextPartsByMarks(arr, t, cursor, start)
      }
      arr.put(json)
      cursor = end
    }
    if (cursor < serializeEnd) {
      appendTextPartsByMarks(arr, t, cursor, serializeEnd)
    }
    return arr.toString()
  }

  /** 把 [start,end) 内文字按 marks 变化拆成多个 text part 塞进 arr */
  private fun appendTextPartsByMarks(arr: JSONArray, t: Spanned, start: Int, end: Int) {
    if (start >= end) return
    // 收集所有 mark-style span 的边界点
    val boundaries = sortedSetOf(start, end)
    val markSpans = t.getSpans(start, end, CharacterStyle::class.java)
    for (s in markSpans) {
      val ss = t.getSpanStart(s)
      val se = t.getSpanEnd(s)
      if (ss > start && ss < end) boundaries.add(ss)
      if (se > start && se < end) boundaries.add(se)
    }
    val pts = boundaries.toList()
    for (i in 0 until pts.size - 1) {
      val from = pts[i]
      val to = pts[i + 1]
      if (from >= to) continue
      val chunk = t.subSequence(from, to).toString()
      if (chunk.isEmpty()) continue
      val part = JSONObject()
        .put("type", "text")
        .put("text", chunk)
      val marks = marksFromSpannableRange(t, from, to)
      if (marks != null) part.put("marks", marks)
      arr.put(part)
    }
  }

  fun currentPillCount(): Int {
    val t = text ?: return 0
    return t.getSpans(0, t.length, RefPillSpan::class.java).size
  }

  // MARK: - Event dispatch (Fabric direct)

  private fun emitContentChange() {
    val payload: WritableMap = Arguments.createMap().apply {
      putString("contentJson", currentContentJson())
      putInt("pillCount", currentPillCount())
    }
    dispatchEvent("topChangeContent", payload)
    /* 程序式改 text（insertPill / setContentJson / applyMark 等）后强制重布局 + 重测，
       让 onLayout → maybeEmitContentSize 跑一遍。否则 JS 端 autoHeight 还是改前高度，
       pill 折行后第二行 / 光标会被截断。EditText 改 text 一般会自动 requestLayout，
       这里再保险一下。*/
    requestLayout()
  }

  private fun emitSplitRequest(offset: Int) {
    val payload: WritableMap = Arguments.createMap().apply {
      putString("contentJson", currentContentJson())
      putInt("offset", offset)
    }
    dispatchEvent("topSplitRequest", payload)
  }

  private fun emitMergeBackwardRequest() {
    val payload: WritableMap = Arguments.createMap().apply {
      putString("contentJson", currentContentJson())
    }
    dispatchEvent("topMergeBackwardRequest", payload)
  }

  /* 块首退格无法在 TextWatcher 或 onKeyDown 里靠谱拦到（soft keyboard 走 InputConnection
     的 deleteSurroundingText，不一定走 KEYCODE_DEL）。包一层 InputConnection wrapper，
     在 selection={0,0} 且要删时改成发 mergeBackward 事件 + 返 false 让默认逻辑不删。 */
  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val base = super.onCreateInputConnection(outAttrs) ?: return null
    return object : InputConnectionWrapper(base, true) {
      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (beforeLength > 0 && selectionStart == 0 && selectionEnd == 0) {
          emitMergeBackwardRequest()
          return false
        }
        return super.deleteSurroundingText(beforeLength, afterLength)
      }
      override fun sendKeyEvent(event: KeyEvent?): Boolean {
        if (event != null
          && event.action == KeyEvent.ACTION_DOWN
          && event.keyCode == KeyEvent.KEYCODE_DEL
          && selectionStart == 0
          && selectionEnd == 0) {
          emitMergeBackwardRequest()
          return false
        }
        return super.sendKeyEvent(event)
      }
    }
  }

  private fun emitSelectionEvent(start: Int, end: Int) {
    val payload: WritableMap = Arguments.createMap().apply {
      putInt("start", start)
      putInt("end", end)
    }
    dispatchEvent("topChangeSelection", payload)
  }

  private fun emitFocusEvent(eventName: String) {
    val payload: WritableMap = Arguments.createMap()
    // "onFocusNative" / "onBlurNative" → "topFocusNative" / "topBlurNative"
    val topName = "top" + eventName.removePrefix("on")
    dispatchEvent(topName, payload)
  }

  private fun dispatchEvent(name: String, data: WritableMap) {
    /* AppCompatEditText 的 super 构造期会触发一次 onSelectionChanged(0, 0)。此时 view 还没被
       React reconciler 分配 react tag（id == View.NO_ID），surfaceId 也拿不到。这条 dispatch
       会被 Fabric 当成 LEGACY 事件 → 走 InteropEventEmitter → 再回到 FabricEventDispatcher，
       直接死循环 StackOverflow。等 view 真正挂上 react tree 后才允许 emit。 */
    if (id == View.NO_ID) return
    val reactContext = context as? ReactContext ?: return
    val surfaceId = UIManagerHelper.getSurfaceId(this)
    if (surfaceId == -1) return
    val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
    dispatcher.dispatchEvent(FlowDocInputEvent(surfaceId, id, name, data))
  }
}

/** 通用 Fabric direct-event 包装。Event<T : Event<T>> 是递归泛型，匿名 object 撑不住，必须命名类。 */
private class FlowDocInputEvent(
  surfaceId: Int,
  viewTag: Int,
  private val name: String,
  private val payload: WritableMap,
) : Event<FlowDocInputEvent>(surfaceId, viewTag) {
  override fun getEventName(): String = name
  override fun getEventData(): WritableMap = payload
}
