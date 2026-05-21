/**
 * 顶栏圆按钮（汉堡 / 返回 / + / 筛选 / 日历 / ⋯ 等）通用的按下反馈：
 * - onPressIn: spring 放大到 1.12（friction 14：紧凑无 overshoot，按下"鼓"到位就停）
 * - onPressOut: spring 缩回到 1（friction 5.5：刚好一次 overshoot 就静下来
 *   —— 视觉是「缩 → 略小于 1 → 再回到 1」一个回合，不再多余振荡）
 *
 * 实现：Pressable 接 onPressIn/Out 驱动 Animated.Value，子节点 wrap 在 Animated.View
 * 里。Pressable 本身不消费 onPress 之外的事件，跟 native gesture 不冲突。
 */
import React, { useRef } from 'react';
import { Animated, Pressable } from 'react-native';
import type { PressableProps, ViewStyle, GestureResponderEvent } from 'react-native';

type Props = Omit<PressableProps, 'children'> & {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  /** 按下放大到多少（默认 1.12） */
  pressScale?: number;
};

export function AnimatedCircleButton({
  children,
  style,
  pressScale = 1.12,
  onPressIn,
  onPressOut,
  ...rest
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = (e: GestureResponderEvent) => {
    Animated.spring(scale, {
      toValue: pressScale,
      useNativeDriver: true,
      friction: 14,
      tension: 220,
    }).start();
    onPressIn?.(e);
  };

  const handlePressOut = (e: GestureResponderEvent) => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      friction: 5.5,
      tension: 200,
    }).start();
    onPressOut?.(e);
  };

  return (
    <Pressable {...rest} onPressIn={handlePressIn} onPressOut={handlePressOut}>
      <Animated.View style={[style as ViewStyle, { transform: [{ scale }] }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}
