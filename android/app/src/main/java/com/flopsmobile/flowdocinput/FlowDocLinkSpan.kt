/**
 * FlowDocLinkSpan
 *
 * 行内链接 mark。对齐 iOS 的 NSLinkAttributeName 处理：前景换链接色 #1d75d4 + 单下划线，
 * 非编辑（viewer）态可点（系统打开 URL）。span 携带 url 供 round-trip 还原 link mark。
 *
 * 可点性依赖宿主 TextView 设了 LinkMovementMethod —— FlowDocInputView 在非编辑态才挂，
 * 编辑态不挂（LinkMovementMethod 会干扰光标 / 选区）。
 */
package com.flopsmobile.flowdocinput

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.text.TextPaint
import android.text.style.ClickableSpan
import android.view.View

class FlowDocLinkSpan(val url: String) : ClickableSpan() {

  override fun updateDrawState(ds: TextPaint) {
    ds.color = LINK_COLOR
    ds.isUnderlineText = true
  }

  override fun onClick(widget: View) {
    if (url.isBlank()) return
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      widget.context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
      /* 没有能处理该 URL 的应用，忽略 */
    } catch (_: Throwable) {
      /* URL 非法等，忽略 */
    }
  }

  companion object {
    /** 行内链接显示色（对齐 web / iOS #1d75d4）。 */
    val LINK_COLOR: Int = Color.parseColor("#1d75d4")
  }
}
