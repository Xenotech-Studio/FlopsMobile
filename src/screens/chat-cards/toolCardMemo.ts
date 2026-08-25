/**
 * 工具卡 React.memo 的公用比较器。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────────
 * 流式期间 ChatScreen 每次重渲染都会把整棵消息区重建一遍，历史消息里的几十张工具卡
 * 会跟着全量 reconcile。卡片本身并不便宜（JSON.parse 参数、markdown、diff 上色…），
 * 而它们**绝大多数根本没变**——变的只有当前这一张。加上 memo 就能在没变的卡上直接短路。
 *
 * ── 为什么不能用默认浅比较 ──────────────────────────────────────────────────
 * ChatScreen 传下来的一堆函数 prop（getToolStatusLabel / renderToolCardSafetyActions /
 * wrapFileToolPreviewBody / renderAnsiText / onOpenEntry …）是组件体内的裸函数或内联箭头，
 * **每次 render 都是新标识**。默认 React.memo 一比就必然不等，等于没加。
 *
 * 所以这里只比「值 prop」，显式忽略函数 prop 的标识。忽略是安全的，因为这些函数满足：
 *   - 要么是纯映射（getToolStatusLabel、formatSec）；
 *   - 要么把所有会变的输入都通过**实参**接收（renderToolCardSafetyActions(reviewId,
 *     isSubmitting)、wrapFileToolPreviewBody(isFull, isStreaming, cardKey, children)、
 *     renderAnsiText(text, maxLen)），闭包里只剩 styles / colors 这类已经在比较列表里的值；
 *   - 要么闭包只捕获稳定的 useCallback + 本卡固定的 cardKey（onOpenEntry、onEcho、onSubmit）。
 * 主题（colors）走 styles 引用比较，主题一换 createChatStyles 出新对象，卡片照常刷新。
 * Context（ConversationAttachmentsContext / FlowDocItemMetaContext）不受 memo 阻断。
 *
 * ── block 为什么可以按引用比 ────────────────────────────────────────────────
 * ChatScreen 的 onEvent 对 localBlocks 的每一次改动都是**整块替换**
 * （localBlocks[i] = { ...localBlocks[i], ... }），从不原地改字段，所以
 * 「引用没变」⟺「内容没变」。历史消息侧的 blocks 同理由 rawMessagesToLocal 一次性产出。
 */

/**
 * 造一个只比指定「值 prop」的比较器，其余 prop（函数标识）一律忽略。
 *
 * 用法：`React.memo(FooCardImpl, toolCardPropsEqual<Props>(['block', 'cardKey', ...]))`
 * —— 键名写全、写显式，新增 prop 时忘了加进来会被 review 看见（而不是被浅比较悄悄放过）。
 */
export function toolCardPropsEqual<P extends object>(
  valueKeys: readonly (keyof P)[]
): (a: Readonly<P>, b: Readonly<P>) => boolean {
  return (a, b) => {
    for (let i = 0; i < valueKeys.length; i++) {
      const k = valueKeys[i];
      if (a[k] !== b[k]) return false;
    }
    return true;
  };
}

/**
 * 绝大多数工具卡共享的一组值 prop。
 *
 * 注意这里**不含** fileArgs / 由 block 派生的任何东西：像 parseFileToolArgs(block) 这种
 * 每次 render 都新建对象、但内容纯粹由 block 决定的派生值，按引用比会让 memo 永不命中；
 * 而 block 已经在比较列表里，block 没变 ⟹ 派生值内容也没变，直接省掉更正确也更快。
 */
export const COMMON_TOOL_CARD_VALUE_KEYS = [
  'block',
  'cardKey',
  'viewMode',
  'styles',
  'isSubmitting',
] as const;
