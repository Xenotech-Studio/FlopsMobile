/**
 * 客户端最低支持版本事件总线：
 *  - fetchWithDebugLog 命中 426 时 notifyClientOutdated(...)
 *  - UpgradeRequiredOverlay 在顶层订阅 → 切到强制升级遮罩
 *
 * 模块级单例 + lastDetail 缓存：组件挂载晚于命中也能立刻拿到状态。
 */

export type ClientOutdatedDetail = {
  platform: string;
  min: string;
  reported: string;
  message: string;
};

type Listener = (d: ClientOutdatedDetail) => void;

let lastDetail: ClientOutdatedDetail | null = null;
const listeners = new Set<Listener>();

export function notifyClientOutdated(detail: ClientOutdatedDetail): void {
  lastDetail = detail;
  listeners.forEach((fn) => {
    try { fn(detail); } catch { /* noop */ }
  });
}

export function subscribeClientOutdated(fn: Listener): () => void {
  listeners.add(fn);
  if (lastDetail) {
    try { fn(lastDetail); } catch { /* noop */ }
  }
  return () => { listeners.delete(fn); };
}

export function getLastClientOutdated(): ClientOutdatedDetail | null {
  return lastDetail;
}
