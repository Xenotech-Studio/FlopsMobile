/**
 * 漂浮主操作按钮（FAB · Floating Action Button）。视觉上比 HeaderCircleButton 大一圈
 * （52pt 圆 + FAB 专用阴影），常驻在屏右下角承担主操作（新建任务 / 新建对话 等）。
 *
 * Liquid Glass / 原生反馈 / Android Reanimated worklet 都复用 AnimatedCircleButton 的
 * 三轨实现，跟其它 native button 一致。callsite 只需指定 ionicon + sfSymbol + onPress
 * + 可选 color，剩下视觉 / 尺寸 / shadow 都统一。
 *
 * 跟 HeaderCircleButton 的区别只在样式（更大 + 不同 shadow），所以单独拎一个 wrapper 而
 * 不是给 HeaderCircleButton 加 size 变体——FAB 在语义上跟 header 圆按钮也是不同的角色。
 */
import React, { useMemo } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { shadowFabThemed } from '../theme/shadows';
import { AnimatedCircleButton } from './AnimatedCircleButton';

export const FAB_SIZE = 52;

type Props = {
  ionicon: string;
  sfSymbol: string;
  iconSize?: number;
  /** 圆按钮直径，默认 52pt（FAB_SIZE）。callsite 想跟旁边元素视觉对齐时可覆盖。 */
  size?: number;
  /** 默认 colors.primary（FAB 一般用主色突出主操作） */
  color?: string;
  onPress?: () => void;
  disabled?: boolean;
  /** style override，merge 在默认 fab style 之后。给 callsite 微调位置用——比如跟 iOS 26
   *  UITabBar 一起出现时 transform translateY 来补偿 glass material 的内部 padding。 */
  style?: StyleProp<ViewStyle>;
};

export function Fab({
  ionicon,
  sfSymbol,
  iconSize = 26,
  size = FAB_SIZE,
  color,
  onPress,
  disabled,
  style,
}: Props) {
  const { colors } = useAppTheme();
  const iconColor = color ?? colors.primary;
  const styles = useMemo(() => createStyles(colors, size), [colors, size]);
  return (
    <AnimatedCircleButton
      style={style ? [styles.fab, style] : styles.fab}
      onPress={onPress}
      disabled={disabled}
      iosSfSymbol={{ name: sfSymbol, size: 16, color: iconColor }}
    >
      <Ionicons name={ionicon} size={iconSize} color={iconColor} />
    </AnimatedCircleButton>
  );
}

function createStyles(c: AppColors, size: number) {
  return StyleSheet.create({
    fab: {
      width: size,
      height: size,
      borderRadius: size / 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      ...shadowFabThemed(c),
    },
  });
}
