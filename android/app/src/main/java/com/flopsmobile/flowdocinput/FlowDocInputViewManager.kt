/**
 * FlowDocInputViewManager
 *
 * Fabric ViewManager。继承 SimpleViewManager + 实现 codegen 接口 FlowDocInputViewManagerInterface
 * （来自 jsSrcsDir 下的 spec，build 时 generate）；把 prop / command 转给 FlowDocInputView。
 */
package com.flopsmobile.flowdocinput

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.FlowDocInputViewManagerDelegate
import com.facebook.react.viewmanagers.FlowDocInputViewManagerInterface

@ReactModule(name = FlowDocInputViewManager.REACT_CLASS)
class FlowDocInputViewManager : SimpleViewManager<FlowDocInputView>(),
  FlowDocInputViewManagerInterface<FlowDocInputView> {

  private val delegate = FlowDocInputViewManagerDelegate(this)

  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(context: ThemedReactContext): FlowDocInputView =
    FlowDocInputView(context)

  override fun getDelegate(): ViewManagerDelegate<FlowDocInputView> = delegate

  // MARK: - Props

  // 注意：所有 setter 都用 override，因为 codegen 生成的 FlowDocInputViewManagerInterface
  // 已经声明了对应方法签名（@Nullable Integer 等）

  @ReactProp(name = "initialContent")
  override fun setInitialContent(view: FlowDocInputView, value: String?) {
    view.setInitialContentJson(value ?: "[]")
  }

  @ReactProp(name = "textColor", customType = "Color")
  override fun setTextColor(view: FlowDocInputView, value: Int?) {
    if (value != null) view.setTextColorInt(value)
  }

  @ReactProp(name = "pillBackgroundColor", customType = "Color")
  override fun setPillBackgroundColor(view: FlowDocInputView, value: Int?) {
    if (value != null) view.pillBackgroundColor = value
  }

  @ReactProp(name = "pillTextColor", customType = "Color")
  override fun setPillTextColor(view: FlowDocInputView, value: Int?) {
    if (value != null) view.pillTextColorInt = value
  }

  @ReactProp(name = "fontSize", defaultDouble = 16.0)
  override fun setFontSize(view: FlowDocInputView, value: Double) {
    view.setFontSizeSp(value.toFloat())
  }

  @ReactProp(name = "fontFamily")
  override fun setFontFamily(view: FlowDocInputView, value: String?) {
    view.setFontFamilyName(value)
  }

  @ReactProp(name = "lineHeight", defaultDouble = 0.0)
  override fun setLineHeight(view: FlowDocInputView, value: Double) {
    view.setCustomLineHeight(value.toFloat())
  }

  @ReactProp(name = "placeholder")
  override fun setPlaceholder(view: FlowDocInputView, value: String?) {
    view.setPlaceholderText(value)
  }

  @ReactProp(name = "placeholderColor", customType = "Color")
  override fun setPlaceholderColor(view: FlowDocInputView, value: Int?) {
    if (value != null) view.setPlaceholderColorInt(value)
  }

  @ReactProp(name = "editable", defaultBoolean = true)
  override fun setEditable(view: FlowDocInputView, value: Boolean) {
    view.setEditableInput(value)
  }

  // MARK: - Commands (codegen interface methods)

  override fun insertPill(
    view: FlowDocInputView,
    refKey: String,
    mention: String,
    title: String,
    isPointer: Boolean,
  ) {
    view.insertPill(refKey, mention, title, isPointer)
  }

  override fun removePill(view: FlowDocInputView, refKey: String) {
    view.removePill(refKey)
  }

  override fun setContent(view: FlowDocInputView, contentJson: String) {
    view.setContentJson(contentJson)
  }

  override fun applyMark(view: FlowDocInputView, mark: String, value: String) {
    view.applyMark(mark, value)
  }

  override fun removeMark(view: FlowDocInputView, mark: String) {
    view.removeMark(mark)
  }

  override fun focus(view: FlowDocInputView) {
    view.focusInput()
  }

  override fun blur(view: FlowDocInputView) {
    view.blurInput()
  }

  companion object {
    const val REACT_CLASS = "FlowDocInputView"
  }
}
