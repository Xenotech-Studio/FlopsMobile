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
import android.graphics.Color
import android.graphics.Typeface
import android.text.Editable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.InputType
import android.text.style.BackgroundColorSpan
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
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

class FlowDocInputView(context: Context) : AppCompatEditText(context) {

  private var initialContentApplied = false
  private var suppressTextWatcher = false
  var enterCreatesBlock: Boolean = true

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

  private fun maybeEmitContentSize() {
    /* EditText 的 measure 拿出来的 height 反映当前内容 wrap 之后所需高度。
       size 没变就不 emit，避免抖动。 */
    val w = measuredWidth
    val h = measuredHeight
    if (w <= 0 || h <= 0) return
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
      setLineHeight(lineHeight.toInt())
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
  }

  // MARK: - Commands

  fun setInitialContentJson(json: String) {
    if (initialContentApplied) return
    initialContentApplied = true
    applyContentJson(json, moveCursorToEnd = false, emit = false)
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
        // 移除原有可能的 bold/italic，code 走独立 typeface
        removeSpansInRange(t, start, end, StyleSpan::class.java)
        t.setSpan(TypefaceSpan("monospace"), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        t.setSpan(BackgroundColorSpan(Color.parseColor("#EEEEEE")), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
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
        removeSpansInRange(t, start, end, TypefaceSpan::class.java)
        removeSpansInRange(t, start, end, BackgroundColorSpan::class.java)
      }
      "color" -> removeSpansInRange(t, start, end, ForegroundColorSpan::class.java)
    }
    emitContentChange()
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
  }

  fun focusInputAtOffset(offset: Int) {
    requestFocus()
    if (offset < 0) return
    val len = text?.length ?: 0
    val pos = offset.coerceIn(0, len)
    setSelection(pos)
  }

  fun blurInput() {
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
      }
    }

    suppressTextWatcher = true
    setText(builder)
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

    if (code) {
      builder.setSpan(TypefaceSpan("monospace"), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      builder.setSpan(BackgroundColorSpan(Color.parseColor("#EEEEEE")), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (bold && italic) {
      builder.setSpan(StyleSpan(Typeface.BOLD_ITALIC), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (bold) {
      builder.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (italic) {
      builder.setSpan(StyleSpan(Typeface.ITALIC), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (colorStr.isNotEmpty()) {
      try {
        builder.setSpan(ForegroundColorSpan(Color.parseColor(colorStr)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      } catch (_: Throwable) {
        /* 颜色字符串非法，忽略 */
      }
    }
  }

  /** 反向：扫描 [start,end) 内 Spannable 上挂的 CharacterStyle，构造 marks JSON；纯文本返回 null */
  private fun marksFromSpannableRange(text: Spanned, start: Int, end: Int): JSONObject? {
    if (start >= end) return null
    var bold = false
    var italic = false
    var code = false
    var colorHex: String? = null
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
        is TypefaceSpan -> if (s.family?.contains("mono", ignoreCase = true) == true) code = true
        is ForegroundColorSpan -> colorHex = "#%06X".format(0xFFFFFF and s.foregroundColor)
        is BackgroundColorSpan -> { /* 当前仅 code 在用，跟 TypefaceSpan 配套 */ }
      }
    }
    if (!bold && !italic && !code && colorHex == null) return null
    return JSONObject().apply {
      if (bold) put("bold", true)
      if (italic) put("italic", true)
      if (code) put("code", true)
      if (colorHex != null) put("color", colorHex)
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
    val pills = t.getSpans(0, t.length, RefPillSpan::class.java)
      .map { Triple(t.getSpanStart(it), t.getSpanEnd(it), it) }
      .sortedBy { it.first }

    var cursor = 0
    for ((start, end, pill) in pills) {
      if (start > cursor) {
        // 把 [cursor, start) 这段文字按 mark 边界拆成多个 text part
        appendTextPartsByMarks(arr, t, cursor, start)
      }
      arr.put(JSONObject().apply {
        put("type", "pill")
        put("refKey", pill.refKey)
        put("mention", pill.mention)
        put("title", pill.title)
        put("isPointer", pill.isPointer)
      })
      cursor = end
    }
    if (cursor < t.length) {
      appendTextPartsByMarks(arr, t, cursor, t.length)
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
