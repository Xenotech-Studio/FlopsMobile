/**
 * 跨 ChatScreen 生命周期的「续流快照」。
 *
 * 为什么需要：DrawerShell 只挂一个顶层页，且用 key 强制 unmount/remount（那是产品定的
 * 「不保留状态」）。所以从对话页切到今日页，ChatScreen 整个卸载 —— currentAssistantBlocks /
 * streamingText / resumeCursorRef 全没。再点回来是全新挂载，本地没有半截内容，
 * resumeV2Stream 只能 replay_from:0 从这轮 run 开头整轮重放，用户看着答案从头再打一遍。
 *
 * 游标和内容必须**成对**存：`replay_from: N` 的语义是「只发 N 之后的帧」，光有游标没有
 * 对应的前半段，续流后界面上只会有答案的后半截，前半截永久缺失（要等 run 结束、完整
 * 消息由 getConversation 落地才补回来）——那比全量重放更糟。所以要么一起存，要么都不存。
 *
 * 只在内存：进程被杀就没了，那种情况下退回全量回放本来就是对的（run 多半也早结束了）。
 * 不落 AsyncStorage —— blocks 里可能有工具输出等大块内容，写盘不值当，且陈旧风险更高。
 */
import type { StreamBlock } from './chatLocalMessages';

/** 快照最长有效期。超过就当没有——run 早该结束了，还不如老老实实全量拉一次。 */
export const RESUME_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

export type ChatResumeSnapshot = {
  conversationId: string;
  /** 这份内容属于哪一轮 run。取快照时必须与当前 active run 对上，否则一律不认。 */
  runId: string;
  /** 服务端口径的绝对游标（subscribe(from_cursor) 用） */
  cursor: number;
  blocks: StreamBlock[];
  text: string;
  status: string;
  savedAt: number;
};

let memo: ChatResumeSnapshot | null = null;

/** 存一份（同一 conversation+run 直接覆盖）。 */
export function saveResumeSnapshot(snap: ChatResumeSnapshot): void {
  if (!snap.conversationId || !snap.runId || snap.cursor <= 0) return;
  memo = snap;
}

/**
 * 取快照并**消费掉**（取到就清，避免同一份被二次使用）。
 * conversation / run 对不上、或已过期，一律返回 null → 调用方走全量回放的老路。
 */
export function takeResumeSnapshot(
  conversationId: string,
  runId: string
): ChatResumeSnapshot | null {
  const s = memo;
  if (!s) return null;
  if (s.conversationId !== conversationId || s.runId !== runId) return null;
  if (Date.now() - s.savedAt > RESUME_SNAPSHOT_TTL_MS) {
    memo = null;
    return null;
  }
  if (!s.blocks.length || s.cursor <= 0) return null;
  memo = null;
  return s;
}

/** 清空。不传 conversationId = 无条件清；传了则只在匹配时清（别误删别的对话的）。 */
export function clearResumeSnapshot(conversationId?: string): void {
  if (!memo) return;
  if (conversationId && memo.conversationId !== conversationId) return;
  memo = null;
}
