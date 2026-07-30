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
 * device 定向过滤：前台 inbox SSE 是用户级广播，账户下每台设备（iPhone / Android / 别的手机）
 * 都会收到同一 remote_mic_invite 帧。过滤优先级：
 *   1. targetDeviceId（新，beacon device_id {platform}_{uuid}）—— 与本机 beacon device_id 比对。
 *      **四端通吃，Android 由此能成为目标**。
 *   2. phoneTokenHash（旧，sha256(device_token)[:16]）—— 兜底：服务端给旧 App 构建仍附带此字段，
 *      与本机 APNs token hash 比对（仅 iOS 有）。
 * 两者都不带 → APNs 定向通道（已按 only_device_token 送到目标机），不过滤。
 */
import { getOwnApnsTokenHash } from '../notifications/apnsClient';
import { getBeaconDeviceId } from './clientInstanceId';

export type RemoteMicInviteDetail = {
  inviteId: string;
  desktopName?: string;
  desktopDeviceId?: string;
  /** 电脑选中的目标设备 beacon device_id（{platform}_{uuid}）。新服务端 SSE 帧带；四端通吃。 */
  targetDeviceId?: string;
  /** 旧字段：目标手机 token_hash（sha256(device_token)[:16]）。服务端对 iOS 目标兜旧 App 构建仍带。 */
  phoneTokenHash?: string;
};

type Listener = (d: RemoteMicInviteDetail) => void;

let lastDetail: RemoteMicInviteDetail | null = null;
let lastInviteId: string | null = null;
const listeners = new Set<Listener>();

export function notifyRemoteMicInvite(detail: RemoteMicInviteDetail): void {
  if (!detail.inviteId || detail.inviteId === lastInviteId) return;
  // 认领去重：无论最终是否投递，同一广播帧（SSE 重连补帧 / 重发）不再重复处理
  lastInviteId = detail.inviteId;
  void routeInviteToDevice(detail);
}

/** device 定向过滤后再落 lastDetail + 派发。非本机的定向邀请（含 Android）静默丢弃、不缓存，
 *  避免晚挂载的订阅者从 lastDetail 拿到不该弹的邀请。 */
async function routeInviteToDevice(detail: RemoteMicInviteDetail): Promise<void> {
  if (detail.targetDeviceId) {
    // 新：按 beacon device_id 定向（四端通吃，Android 也能匹配）
    const mine = await getBeaconDeviceId();
    if (mine !== detail.targetDeviceId) return; // 本机不是电脑选中的目标设备
  } else if (detail.phoneTokenHash) {
    // 旧：兜底按 APNs token hash 定向（仅 iOS 有；旧服务端/旧帧路径）
    const mine = await getOwnApnsTokenHash();
    if (mine !== detail.phoneTokenHash) return; // 本机不是电脑选中的目标手机
  }
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

// ── 连接级 bye（电脑主动断开）───────────────────────────────────────────────
// ConversationContext 收到 SSE type=remote_dictation event=bye 帧时发到这里，
// RemoteMicScreen 按 invite_id 匹配后就地结束录音页。
// 不做 lastDetail 缓存：录音页不在（已关/未开）时电脑断开无需处理 ——
// 下次进页 accept 会发现 status 非 accepted，走既有失效路径。

type ByeListener = (inviteId: string) => void;

const byeListeners = new Set<ByeListener>();

export function notifyRemoteMicBye(inviteId: string): void {
  if (!inviteId) return;
  byeListeners.forEach((fn) => {
    try { fn(inviteId); } catch { /* noop */ }
  });
}

export function subscribeRemoteMicBye(fn: ByeListener): () => void {
  byeListeners.add(fn);
  return () => { byeListeners.delete(fn); };
}
