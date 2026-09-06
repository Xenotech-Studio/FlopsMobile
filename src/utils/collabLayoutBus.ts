/**
 * 协同布局跨端实时跟随的事件总线。
 *
 * 来源只有一条：ConversationContext 的 inbox SSE 收到 `type=cowriter_layout` 帧
 * （服务端 `_inbox_sse_notify_cowriter_layout`，在别的端 POST /cowriter_layout 落库后广播）。
 * 承接方是 ChatScreen —— 布局 state（collabLayout）是它的**局部 state**，不在
 * ConversationContext 里，所以两者之间没有现成通路，照抄本仓已有的
 * conversationAccessBus / remoteMicInviteBus 那套模块级单例。
 *
 * 与那两个总线的两点差异，都是这条数据自身的性质决定的：
 *
 * 1. **不缓存 lastDetail。** 那两个缓存是为了「Overlay 挂载晚于帧到达也要能补看到」。
 *    布局帧不需要：ChatScreen 打开会话时本来就会 hydrate 一次完整布局（GET 带
 *    cowriter_layout + seq），那份比任何缓存的旧帧都新。留着缓存反而有害 —— 晚订阅者会
 *    先吃到一条过期帧，再被 hydrate 覆盖，白闪一次。
 *
 * 2. **不做 id 去重，改为按 conversationId 派发。** 授权请求是「一次一个、要用户批」，
 *    布局帧是「同一个会话的连续状态流」，去重会把连续切换吞掉。乱序/重复由**消费方的
 *    seq 守卫**处理（seq 比本地旧就丢），那是与 SSE / hydrate / POST 响应同一条守卫，
 *    不该在总线这层再造一份。
 */

export type CollabLayoutFrame = {
  conversationId: string;
  /** 服务端自增的布局版本号；消费方按它做 last-write-wins 守卫 */
  seq: number;
  /** 整桶 cowriter_layout（不带 layout_mode），交给 collabLayoutFromConversationMeta 归一化 */
  layout: Record<string, unknown> | null;
};

type Listener = (frame: CollabLayoutFrame) => void;

const listeners = new Set<Listener>();

export function notifyCollabLayoutFrame(frame: CollabLayoutFrame): void {
  if (!frame.conversationId) return;
  listeners.forEach((fn) => {
    try {
      fn(frame);
    } catch {
      /* noop：一个订阅者抛错不该拖垮其它订阅者，更不该把 SSE 分发循环带崩 */
    }
  });
}

export function subscribeCollabLayoutFrame(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
