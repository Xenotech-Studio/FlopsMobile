/**
 * BroadcastStatsReporter —— 播报模式下，把会话统计推给 iOS 播报 Live Activity（灵动岛 expanded
 * 的 .bottom 区 + 锁屏横幅时间下方那一行 🎙️/⏳）。UI-less，与 [[BroadcastLinkRouter]] 同构。
 *
 * 数据源：ConversationContext 的 runningMap / unreadMap（由 inbox SSE 实时维护，见
 * src/context/ConversationContext.tsx）。两张表都只存值为 true 的对话 id，故直接 Object.keys().length：
 *  - activeCount  = runningMap  的键数 = 正在进行（有 agent 在跑）的对话数
 *  - pendingCount = unreadMap   的键数 = 已完成待处理（未读）的对话数
 *
 * 仅播报开时才推（Live Activity 只在播报时存在）；关播报后 reportBroadcastStats 内部自会 no-op，
 * 且原生侧无活动时亦 no-op。Android / 未 rebuild 的旧 iOS 包在原生侧天然 no-op。
 *
 * 挂在 ConversationProvider 之内（才能用 useRunningConvMap / useUnreadConvMap）。
 */
import { useEffect } from 'react';
import { useRunningConvMap, useUnreadConvMap } from '../context/ConversationContext';
import { reportBroadcastStats, useBroadcastMode } from '../audio/ttsRealtime';

export function BroadcastStatsReporter(): null {
  const broadcast = useBroadcastMode();
  const runningMap = useRunningConvMap();
  const unreadMap = useUnreadConvMap();

  const activeCount = Object.keys(runningMap).length;
  const pendingCount = Object.keys(unreadMap).length;

  useEffect(() => {
    if (!broadcast) return;
    // broadcast 刚开 / 计数变化都会跑到这里；reportBroadcastStats 自带去重，重复值不重复下发。
    reportBroadcastStats(activeCount, pendingCount);
  }, [broadcast, activeCount, pendingCount]);

  return null;
}
