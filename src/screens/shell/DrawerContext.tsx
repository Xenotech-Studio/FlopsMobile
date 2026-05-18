/**
 * DrawerContext —— 顶层页（TodayScreen / ProjectScreen / DocsScreen）共享的抽屉控制句柄。
 *
 * 抽屉的展开/收起本身由 DrawerShell 的 reanimated shared value 驱动；JS 这一侧只需要：
 *  - `open()` —— 顶层页左上角汉堡按钮调用
 *  - `setActive(active)` —— DrawerContent 点条目时调用，DrawerShell 接住后 unmount/remount 主页
 *  - `active` —— 当前 active 顶层页，让 DrawerContent 给条目加高亮
 *  - `presentProfileSheet()` —— 抽屉底栏头像按钮调用，从底部弹起 ProfileSheet
 */
import { createContext, useContext } from 'react';
import type { DrawerActive } from '../../navigation/types';

export type DrawerHandle = {
  open: () => void;
  close: () => void;
  active: DrawerActive;
  setActive: (a: DrawerActive) => void;
  presentProfileSheet: () => void;
};

const DrawerContext = createContext<DrawerHandle | null>(null);

export const DrawerProvider = DrawerContext.Provider;

export function useDrawer(): DrawerHandle {
  const v = useContext(DrawerContext);
  if (!v) throw new Error('useDrawer must be used inside <DrawerProvider>');
  return v;
}
