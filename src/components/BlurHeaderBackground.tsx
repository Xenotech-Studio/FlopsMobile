import React, { useMemo } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useAppTheme } from '../context/ThemeContext';

type BlurHeaderBackgroundProps = {
  style?: ViewStyle;
  /** 顶部纯色区域高度（安全区 + 上间距），渐变只在其下方（按钮+标题区域） */
  topSolidHeight?: number;
};

/**
 * 顶栏背景：顶部纯色；下方为自上而下白到透明的渐变（上慢下快）。
 */
export function BlurHeaderBackground({ style, topSolidHeight = 0 }: BlurHeaderBackgroundProps) {
  const { isDark } = useAppTheme();

  const { solidTop, gradientColors } = useMemo(() => {
    if (isDark) {
      return {
        solidTop: 'rgba(0,0,0,0.98)' as const,
        gradientColors: [
          'rgba(0,0,0,0.98)',
          'rgba(0,0,0,0.92)',
          'rgba(0,0,0,0.6)',
          'rgba(0,0,0,0.2)',
          'rgba(0,0,0,0.05)',
        ] as const,
      };
    }
    return {
      solidTop: 'rgba(255,255,255,0.98)' as const,
      gradientColors: [
        'rgba(255,255,255,0.98)',
        'rgba(255,255,255,0.92)',
        'rgba(255,255,255,0.6)',
        'rgba(255,255,255,0.2)',
        'rgba(255,255,255,0.05)',
      ] as const,
    };
  }, [isDark]);

  const gradientStyle = [styles.gradient, topSolidHeight > 0 && { top: topSolidHeight }];
  return (
    <View style={[styles.fill, style]} pointerEvents="none">
      {topSolidHeight > 0 ? (
        <View style={[styles.solidTop, { height: topSolidHeight, backgroundColor: solidTop }]} />
      ) : null}
      <LinearGradient
        colors={[...gradientColors]}
        locations={[0, 0.6, 0.75, 0.95, 1]}
        style={gradientStyle}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
  },
  solidTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  gradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
