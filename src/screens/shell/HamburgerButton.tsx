/**
 * 顶层页统一的「左上角汉堡按钮」：薄薄一层调 HeaderCircleButton（视觉 / 主题 / 原生 SF
 * Symbol / 弹簧动画都在那里统一）+ 注入 drawer.open()。
 *
 * 三个顶层页（TodayScreen / ProjectScreen / DocsScreen）共用本组件保持视觉一致。
 */
import React from 'react';
import { HeaderCircleButton } from '../../components/HeaderCircleButton';
import { useResponsive } from '../../hooks/useResponsive';
import { useDrawer } from './DrawerContext';

export function HamburgerButton() {
  const { toggle } = useDrawer();
  const { sidebarShell } = useResponsive();
  /** compact 用它开覆盖式抽屉(三横线)；iPad sidebarShell 用它收起/展开 push 侧栏(侧栏图标)。 */
  return (
    <HeaderCircleButton
      ionicon="menu-outline"
      sfSymbol={sidebarShell ? 'sidebar.left' : 'line.3.horizontal'}
      iconSize={sidebarShell ? 24 : 26}
      onPress={toggle}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
    />
  );
}
