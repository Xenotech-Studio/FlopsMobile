/**
 * HistoryLoadingOverlay
 *
 * 拉历史对话时盖在 ChatScreen 上的 loading 遮罩。visible 切 false 时不直接卸载，
 * 而是先 fade 到 0、动画结束再卸载 — 跟纯 conditional 渲染相比体验更连贯。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export type HistoryLoadingOverlayProps = {
  visible: boolean;
  /** 把 overlay 往下延伸的像素数（用来盖住溢出到 safe-area 的 composer chips） */
  bottomOverflow: number;
  /** 外层基础 style（背景色 / zIndex 等都从这里来） */
  overlayStyle: StyleProp<ViewStyle>;
  spinnerColor: string;
  /** Fade out 时长（ms），默认 220ms — 比 default 300 短一些，避免遮罩"赖着不走"的感觉 */
  fadeDurationMs?: number;
  /** overlay 距离容器顶部的偏移（避免遮挡 header），默认 0 */
  topOffset?: number;
};

export function HistoryLoadingOverlay({
  visible,
  bottomOverflow,
  overlayStyle,
  spinnerColor,
  fadeDurationMs = 220,
  topOffset = 0,
}: HistoryLoadingOverlayProps) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      /* visible=true：直接显示，不做 fade-in（loading 出现该是即时的，不然观感是卡顿） */
      setMounted(true);
      opacity.setValue(1);
      return;
    }
    /* visible=false：先动画到 0，结束后再卸载 */
    Animated.timing(opacity, {
      toValue: 0,
      duration: fadeDurationMs,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, opacity, fadeDurationMs]);

  if (!mounted) return null;

  return (
    <Animated.View
      style={[overlayStyle, { top: topOffset, bottom: -bottomOverflow, opacity }]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <ActivityIndicator size="large" color={spinnerColor} />
    </Animated.View>
  );
}
