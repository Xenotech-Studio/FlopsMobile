import React, { useMemo } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useAppTheme } from '../context/ThemeContext';

type BlurHeaderBackgroundProps = {
  style?: ViewStyle;
  /** 顶部纯色区域高度（安全区 + 上间距），渐变只在其下方（按钮+标题区域） */
  topSolidHeight?: number;
  /**
   * 渐变与顶部实色的 RGB 基准（6 位 hex）。
   * 默认 `colors.background`（如聊天页纯黑）；会话列表可传 `colors.conversationListBackground` 与列表底对齐。
   */
  gradientBaseHex?: string;
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgbaFromBase(hex: string, a: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(0,0,0,${a})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
}

/**
 * 顶栏背景：顶部纯色；下方为自上而下到透明的渐变（上慢下快）。
 */
export function BlurHeaderBackground({
  style,
  topSolidHeight = 0,
  gradientBaseHex,
}: BlurHeaderBackgroundProps) {
  const { colors } = useAppTheme();
  const base = gradientBaseHex ?? colors.background;

  const { solidTop, gradientColors } = useMemo(() => {
    return {
      solidTop: rgbaFromBase(base, 0.98),
      gradientColors: [
        rgbaFromBase(base, 0.98),
        rgbaFromBase(base, 0.92),
        rgbaFromBase(base, 0.6),
        rgbaFromBase(base, 0.2),
        rgbaFromBase(base, 0.05),
      ] as const,
    };
  }, [base]);

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
