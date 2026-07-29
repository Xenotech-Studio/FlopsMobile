/**
 * 跨设备语音输入邀请事件总线：
 *  - 前台：ConversationContext 的 inbox SSE 收到 type=remote_mic_invite 帧时 notifyRemoteMicInvite(...)
 *  - 后台被通知唤醒：DeepLinkRouter 收到 APNs 点击 payload 时同样发到这里
 *  - RemoteMicInviteOverlay 在顶层订阅 → 弹应用内确认卡片（两条来源同一承接方）
 *
 * 模块级单例 + lastDetail 缓存（照抄 clientCompatBus）：组件挂载晚于帧到达也能立刻拿到
 * （冷启动 APNs 路径依赖这一点）。
 * 按 invite_id 去重：SSE 重连补帧 / 服务端重发同一邀请不会重复弹；桌面端连发新邀请
 * （新 invite_id）则最新一条顶掉旧的。
 */

export type RemoteMicInviteDetail = {
  inviteId: string;
  desktopName?: string;
  desktopDeviceId?: string;
};

type Listener = (d: RemoteMicInviteDetail) => void;

let lastDetail: RemoteMicInviteDetail | null = null;
let lastInviteId: string | null = null;
const listeners = new Set<Listener>();

export function notifyRemoteMicInvite(detail: RemoteMicInviteDetail): void {
  if (!detail.inviteId || detail.inviteId === lastInviteId) return;
  lastInviteId = detail.inviteId;
  lastDetail = detail;
  listeners.forEach((fn) => {
    try { fn(detail); } catch { /* noop */ }
  });
}

/** overlay 消费完（接受 / 拒绝 / 验证失效）后调：清缓存，避免晚挂载的订阅者重拿已处理的邀请。
 *  invite_id 去重记录保留 —— 同一邀请此后也不再弹。 */
export function clearRemoteMicInvite(): void {
  lastDetail = null;
}

export function subscribeRemoteMicInvite(fn: Listener): () => void {
  listeners.add(fn);
  if (lastDetail) {
    try { fn(lastDetail); } catch { /* noop */ }
  }
  return () => { listeners.delete(fn); };
}
