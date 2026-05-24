/**
 * 顶层页统一的「左上角汉堡按钮」：薄薄一层调 HeaderCircleButton（视觉 / 主题 / 原生 SF
 * Symbol / 弹簧动画都在那里统一）+ 注入 drawer.open()。
 *
 * 三个顶层页（TodayScreen / ProjectScreen / DocsScreen）共用本组件保持视觉一致。
 */
import React from 'react';
import { HeaderCircleButton } from '../../components/HeaderCircleButton';
import { useDrawer } from './DrawerContext';

export function HamburgerButton() {
  const { open } = useDrawer();
  return (
    <HeaderCircleButton
      ionicon="menu-outline"
      sfSymbol="line.3.horizontal"
      iconSize={26}
      onPress={open}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
    />
  );
}
