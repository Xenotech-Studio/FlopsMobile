/**
 * usage_run 的判等，给 ChatScreen 的 setUsageRuns 做 bail-out 用。
 *
 * 一次 run 里 `usage` 帧会被反复推送，且往往内容完全一样。旧写法每帧都 `[...prev]`
 * 新建数组，React 必然重渲染整棵 ChatScreen —— 这是 "Maximum update depth exceeded"
 * 那条链上的一份压力来源。内容没变就返回原数组，让 React bail out。
 *
 * 判等两个方向都不能错：太松会把真实用量更新吞掉（界面 token 数不再动），
 * 太紧就退回逐帧重渲染。所以嵌套结构（by_model 之类）一律按「不等」处理 ——
 * 宁可多渲染一次，也不漏更新。
 */
import type { UsageRun } from '../api';

export function usageRunEqual(a: UsageRun | undefined, b: UsageRun | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.run_id !== b.run_id || a.last_message_index !== b.last_message_index) return false;
  const ua = (a.usage ?? {}) as Record<string, unknown>;
  const ub = (b.usage ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(ua), ...Object.keys(ub)]);
  for (const k of keys) {
    const va = ua[k];
    const vb = ub[k];
    if (va !== null && typeof va === 'object') return false;
    if (vb !== null && typeof vb === 'object') return false;
    if (va !== vb) return false;
  }
  return true;
}
