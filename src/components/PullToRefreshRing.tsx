import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

const SIZE = 28;
const STROKE = 3;
const R = (SIZE - STROKE) / 2;
const CX = SIZE / 2;
const CY = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  /** 下拉距离（pt），与 threshold 算出 0..1 进度 */
  pullDistance: SharedValue<number>;
  /** 是否正在刷新（SharedValue，供 worklet） */
  refreshing: SharedValue<boolean>;
  /** 触发刷新的距离（pt），用于进度满格 */
  threshold: number;
  /** 是否正在刷新（React 状态，用于 spin 动画） */
  refreshingState: boolean;
  color?: string;
};

export function PullToRefreshRing({
  pullDistance,
  refreshing,
  threshold,
  refreshingState,
  color = '#0f172a',
}: Props) {
  const spin = useSharedValue(0);

  useEffect(() => {
    if (refreshingState) {
      spin.value = 0;
      spin.value = withRepeat(
        withTiming(360, { duration: 800, easing: Easing.linear }),
        -1,
        false
      );
    } else {
      cancelAnimation(spin);
      spin.value = 0;
    }
  }, [refreshingState, spin]);

  const spinAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  const opacityAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    const progress = refreshing.value
      ? 1
      : Math.min(1, Math.max(0, pullDistance.value / threshold));
    return { opacity: progress };
  });

  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const progress = refreshing.value
      ? 0.25
      : Math.min(1, Math.max(0, pullDistance.value / threshold));
    return {
      strokeDashoffset: CIRCUMFERENCE * (1 - progress),
    };
  });

  return (
    <View style={styles.wrap}>
      <Animated.View style={[styles.svgWrap, opacityAnimatedStyle]}>
        <Animated.View style={[styles.svgWrap, refreshingState && spinAnimatedStyle]}>
          <Svg width={SIZE} height={SIZE}>
            <Circle
              cx={CX}
              cy={CY}
              r={R}
              stroke={color}
              strokeWidth={STROKE}
              fill="none"
              opacity={0.2}
              transform={`rotate(-90 ${CX} ${CY})`}
            />
            <AnimatedCircle
              cx={CX}
              cy={CY}
              r={R}
              stroke={color}
              strokeWidth={STROKE}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              transform={`rotate(-90 ${CX} ${CY})`}
              animatedProps={animatedProps}
            />
          </Svg>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  svgWrap: { width: SIZE, height: SIZE },
});
