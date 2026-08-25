/**
 * 档 B 授权解密桥的事件总线（WP3）。
 *
 * 来源只有一条：ConversationContext 的 inbox SSE 收到 type=conversation_access_request 帧。
 * 承接方是根级的 ConversationAccessRequestOverlay。两者之间没有现成的数据通路，
 * 照抄本仓已有的 remoteMicInviteBus 模式（模块级单例 + lastDetail 缓存 + 按 id 去重）。
 *
 * 缓存 lastDetail 的理由与那边一样：Overlay 挂载可能晚于帧到达（冷启动/重连补帧），
 * 晚订阅者也要能立刻拿到当前待决的请求。
 *
 * 去重按 request_id：SSE 重连补帧、服务端重发同一请求不会重复弹；agent 连发新请求
 * （新 request_id）则最新一条顶掉旧的 —— 授权是低频动作，排队反而让用户搞不清在批什么。
 */

export type ConversationAccessRequestDetail = {
  requestId: string;
  /** 发起方对话 A（decision 要 POST 到它的路径下；服务端会校验一致性） */
  requesterConversationId: string;
  /** agent 想读的那条加密对话 D */
  targetConversationId: string;
  reason: string;
};

type Listener = (d: ConversationAccessRequestDetail) => void;

let lastDetail: ConversationAccessRequestDetail | null = null;
let lastRequestId: string | null = null;
const listeners = new Set<Listener>();

export function notifyConversationAccessRequest(detail: ConversationAccessRequestDetail): void {
  if (!detail.requestId || detail.requestId === lastRequestId) return;
  lastRequestId = detail.requestId;
  lastDetail = detail;
  listeners.forEach((fn) => {
    try {
      fn(detail);
    } catch {
      /* noop */
    }
  });
}

export function subscribeConversationAccessRequest(fn: Listener): () => void {
  listeners.add(fn);
  if (lastDetail) {
    try {
      fn(lastDetail);
    } catch {
      /* noop */
    }
  }
  return () => {
    listeners.delete(fn);
  };
}

/** 用户已经处理完（同意/拒绝/放弃）→ 清缓存，免得下次挂载又把旧的弹出来。 */
export function clearConversationAccessRequest(): void {
  lastDetail = null;
}

// ── 批量标题解密授权（list_conversations 触发）——与上面同款单例总线，独立一套 ──
export type ConversationTitlesRequestDetail = {
  requestId: string;
  requesterConversationId: string;
  count: number;
  targetIds: string[];
};

let lastTitlesDetail: ConversationTitlesRequestDetail | null = null;
let lastTitlesRequestId: string | null = null;
const titlesListeners = new Set<(d: ConversationTitlesRequestDetail) => void>();

export function notifyConversationTitlesRequest(detail: ConversationTitlesRequestDetail): void {
  if (!detail.requestId || detail.requestId === lastTitlesRequestId) return;
  lastTitlesRequestId = detail.requestId;
  lastTitlesDetail = detail;
  titlesListeners.forEach((fn) => {
    try {
      fn(detail);
    } catch {
      /* noop */
    }
  });
}

export function subscribeConversationTitlesRequest(
  fn: (d: ConversationTitlesRequestDetail) => void,
): () => void {
  titlesListeners.add(fn);
  if (lastTitlesDetail) {
    try {
      fn(lastTitlesDetail);
    } catch {
      /* noop */
    }
  }
  return () => {
    titlesListeners.delete(fn);
  };
}

export function clearConversationTitlesRequest(): void {
  lastTitlesDetail = null;
}
