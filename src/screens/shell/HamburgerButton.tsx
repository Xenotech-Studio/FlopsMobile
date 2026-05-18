/**
 * 顶层页统一的「左上角汉堡按钮」：圆形浮按钮 + 三横线 icon，点击 = 打开抽屉。
 * 三个顶层页（TodayScreen / ProjectScreen / DocsScreen）都用此组件，保持视觉/语义一致。
 */
import React, { useMemo } from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { shadowCircleButtonThemed } from '../../theme/shadows';
import { HEADER_CIRCLE_BTN_SIZE } from '../../theme/layout';
import { useDrawer } from './DrawerContext';

export function HamburgerButton() {
  const { open } = useDrawer();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <TouchableOpacity
      style={styles.btn}
      onPress={open}
      activeOpacity={0.7}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
    >
      <Ionicons name="menu-outline" size={26} color={colors.textSecondary} />
    </TouchableOpacity>
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
