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
  /** 切换抽屉/侧栏开合。compact 覆盖式抽屉与 iPad push 侧栏通用——汉堡按钮调它。 */
  toggle: () => void;
  active: DrawerActive;
  setActive: (a: DrawerActive) => void;
  presentProfileSheet: () => void;
  /** 临时让位左缘开抽屉手势(compact / iOS 左缘 strip)。文档抽屉式预览挂载时调 true:
   *  让屏幕左缘归「拖预览露目录」而不是开全局菜单(回全局菜单 = 先关预览回到目录,再用目录页汉堡/左缘)。
   *  iPad / Android 无 iOS 左缘 strip,此 setter 为可选 no-op。 */
  setOpenGestureSuppressed?: (suppressed: boolean) => void;
};

const DrawerContext = createContext<DrawerHandle | null>(null);

export const DrawerProvider = DrawerContext.Provider;

export function useDrawer(): DrawerHandle {
  const v = useContext(DrawerContext);
  if (!v) throw new Error('useDrawer must be used inside <DrawerProvider>');
  return v;
}
