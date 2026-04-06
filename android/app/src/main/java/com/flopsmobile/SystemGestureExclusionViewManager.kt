package com.flopsmobile

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

@ReactModule(name = SystemGestureExclusionViewManager.NAME)
class SystemGestureExclusionViewManager : ReactViewManager() {

  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup {
    return SystemGestureExclusionView(context)
  }

  companion object {
    const val NAME = "FlopsSystemGestureExclusionView"
  }
}
