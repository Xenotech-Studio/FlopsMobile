/**
 * 顶栏 / 顶角漂浮圆按钮的统一封装：标准 HEADER_CIRCLE_BTN_SIZE + bg + shadow，外加
 * iOS 26 Liquid Glass + SF Symbol 原生 icon 一条龙。
 *
 * 设计意图：取代各 screen 自己手写一遍 `styles.circleBtn` + Ionicons + AnimatedCircleButton
 * 三件套 + iosSfSymbol mapping。callsite 只需指定两个 icon 名（Ionicons + SF Symbol）
 * 和 onPress，剩下视觉 / 尺寸 / 动效 / 主题颜色全统一。
 *
 * 适用范围：屏幕**漂浮顶角**按钮（汉堡 / 返回 / +/筛选 / 日历 / ⋯ 等）。**不**适用于
 * 传统 header 行（chevron + title + spacer 那种 row layout，比如 settings / 用量页）——
 * 那种保持原扁平 icon 设计。
 *
 * Liquid Glass 行为见 AnimatedCircleButton 内部分支：
 *   - iOS 26+：UIButton + glassButtonConfiguration + UIImage 系统 SF Symbol（icon 进入
 *     UIButton native content，跟系统 interactive glass scale 完全锁定）
 *   - iOS < 26：legacy 圆按钮 + 手写 spring scale
 *   - Android：Reanimated worklet
 */
import React, { useMemo } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { shadowCircleButtonThemed } from '../theme/shadows';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import {
  AnimatedCircleButton,
  type AnimatedCircleButtonMenuAction,
} from './AnimatedCircleButton';

type Props = {
  /** Ionicons 名字（iOS < 26 / Android 渲染走这条） */
  ionicon: string;
  /** SF Symbol 名字（iOS 26+ glass 路径走这条；callsite 需保证 iOS 17+ 支持的 symbol） */
  sfSymbol: string;
  /** Ionicons 渲染 size。默认 22（HEADER_CIRCLE_BTN_SIZE 内目视舒适尺寸） */
  iconSize?: number;
  /** SF Symbol 渲染 point size。默认 16（系统 nav button 一贯尺寸） */
  sfSymbolSize?: number;
  /** Icon 颜色，默认 colors.textSecondary（hex 字符串，SF Symbol 用同一值） */
  color?: string;
  onPress?: () => void;
  disabled?: boolean;
  /** 加宽 touch area；iOS native 路径不消费 hitSlop（touch 区 = view bounds） */
  hitSlop?:
    | number
    | { top?: number; bottom?: number; left?: number; right?: number };
  /** iOS 26+ glass 路径上"按下直接弹原生 UIMenu"模式。非空时 onPress 不发，改发 onMenuAction */
  menuActions?: ReadonlyArray<AnimatedCircleButtonMenuAction>;
  onMenuAction?: (actionId: string) => void;
  /** 仅在需要叠加 disabled opacity / 额外定位时覆盖；一般不传 */
  styleOverride?: StyleProp<ViewStyle>;
};

export function HeaderCircleButton({
  ionicon,
  sfSymbol,
  iconSize = 22,
  sfSymbolSize = 16,
  color,
  onPress,
  disabled,
  hitSlop,
  menuActions,
  onMenuAction,
  styleOverride,
}: Props) {
  const { colors } = useAppTheme();
  const iconColor = color ?? colors.textSecondary;
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <AnimatedCircleButton
      style={styleOverride ? [styles.btn, styleOverride] : styles.btn}
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      menuActions={menuActions}
      onMenuAction={onMenuAction}
      iosSfSymbol={{ name: sfSymbol, size: sfSymbolSize, color: iconColor }}
    >
      <Ionicons name={ionicon} size={iconSize} color={iconColor} />
    </AnimatedCircleButton>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    btn: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
  });
}
