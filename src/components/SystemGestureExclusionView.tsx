import React from 'react';
import { Platform, requireNativeComponent, View, type ViewProps } from 'react-native';

/** 须与 android … SystemGestureExclusionViewManager.NAME 一致 */
const ANDROID_VIEW_NAME = 'FlopsSystemGestureExclusionView';

const NativeView =
  Platform.OS === 'android' ? requireNativeComponent<ViewProps>(ANDROID_VIEW_NAME) : null;

/**
 * Android：在视图区域内排除系统边缘返回手势（API 29+），便于左缘右滑交给 RNGH / 应用处理。
 * iOS：退化为普通 View。
 */
export function SystemGestureExclusionView(props: ViewProps) {
  if (Platform.OS === 'android' && NativeView) {
    return <NativeView {...props} />;
  }
  return <View {...props} />;
}
