/**
 * 上下文压缩分界插入位置与预览文案；算法与 FlopsWeb flops-chat-ui / messageTransform 对齐。
 * Mobile 气泡内 blocks 未做 document 合并，insideAssistant 的 insertBeforeBlockIndex 按「合并前 blocks」计。
 */
import type { ConversationMessage, ContextSummary } from '../api';
import {
  coalesceAssistantTurn,
  rawMessagesToLocal,
  rawUserMessageIsMetaOnly,
  rawUserMessageIsInjection,
  rawUserMessageIsTaskEvent,
  rawTaskEventIsInjection,
  type ChatMessage,
} from './chatLocalMessages';

function parseToolMessageResult(msg: ConversationMessage): unknown {
  if (!msg || msg.role !== 'tool') return null;
  const raw = typeof msg.content === 'string' ? msg.content : '';
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

type GroupEntry = { msg: ConversationMessage; rawIndex: number };

export function mapRawMessageIndexToLocalBubbleIndex(raw: ConversationMessage[] | null | undefined): Map<number, number> {
  const arr = raw ?? [];
  const map = new Map<number, number>();
  const bubbles: ChatMessage[] = [];
  let assistantGroup: ConversationMessage[] = [];
  let groupRawIndices: number[] = [];

  const flushAssistant = () => {
    const one = coalesceAssistantTurn(assistantGroup);
    if (one) {
      const localIdx = bubbles.length;
      bubbles.push(one);
      for (const ri of groupRawIndices) map.set(ri, localIdx);
    }
    assistantGroup = [];
    groupRawIndices = [];
  };

  for (let i = 0; i < arr.length; i++) {
    const msg = arr[i];
    if (!msg || typeof msg.role !== 'string') continue;
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      // 分类顺序必须与 rawMessagesToLocalWithUsageMap 完全一致，否则气泡下标错位、分界线被错算到末尾。
      if (rawUserMessageIsInjection(msg) && assistantGroup.length > 0) {
        // P2 用户穿插：并入当前 assistant 气泡（flush 时由组内统一 set）
        assistantGroup.push(msg);
        groupRawIndices.push(i);
        continue;
      }
      if (rawUserMessageIsTaskEvent(msg)) {
        // 注意：task_event 自带 isMeta=true，若先判 meta-only 会被整条吞掉，与 render 不一致
        if (rawTaskEventIsInjection(msg) && assistantGroup.length > 0) {
          assistantGroup.push(msg);
          groupRawIndices.push(i);
          continue;
        }
        // 触发：独立灰条气泡（这里只关心计数与下标，内容用占位）
        flushAssistant();
        bubbles.push({ role: 'user', content: '' });
        map.set(i, bubbles.length - 1);
        continue;
      }
      if (rawUserMessageIsMetaOnly(msg)) continue;
      flushAssistant();
      const content = typeof msg.content === 'string' ? msg.content : '';
      bubbles.push({ role: 'user', content });
      map.set(i, bubbles.length - 1);
      continue;
    }
    if (msg.role === 'assistant' || msg.role === 'tool') {
      assistantGroup.push(msg);
      groupRawIndices.push(i);
      continue;
    }
  }
  flushAssistant();
  return map;
}

function extractAssistantGroupContainingRawIndex(arr: ConversationMessage[], e: number): GroupEntry[] | null {
  let assistantGroup: GroupEntry[] = [];
  for (let i = 0; i < arr.length; i++) {
    const msg = arr[i];
    if (!msg || typeof msg.role !== 'string') continue;
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      if (rawUserMessageIsMetaOnly(msg)) continue;
      if (assistantGroup.some((x) => x.rawIndex === e)) return assistantGroup;
      assistantGroup = [];
      continue;
    }
    if (msg.role === 'assistant' || msg.role === 'tool') {
      assistantGroup.push({ msg, rawIndex: i });
      continue;
    }
  }
  if (assistantGroup.some((x) => x.rawIndex === e)) return assistantGroup;
  return null;
}

type PreBlock =
  | { type: 'text'; content: string }
  | {
      type: 'tool';
      tool_name: string;
      status: string;
      arguments?: string;
      result?: unknown;
    };

function buildPreMergeBlocksWithRawStarts(group: GroupEntry[]): { blocks: PreBlock[]; starts: number[] } {
  const blocks: PreBlock[] = [];
  const starts: number[] = [];
  const messages = group.map((x) => x.msg);
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const rawIdx = group[i].rawIndex;
    if (msg.role === 'assistant') {
      const text = (msg.content != null ? String(msg.content) : '').trim();
      if (text) {
        blocks.push({ type: 'text', content: text });
        starts.push(rawIdx);
      }
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length > 0) {
        for (let j = 0; j < toolCalls.length; j++) {
          const tc = toolCalls[j];
          const fn = typeof tc === 'object' && tc && tc.function ? tc.function : {};
          const name = fn.name != null && fn.name !== '' ? fn.name : 'unknown';
          const args =
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments != null ? fn.arguments : {});
          const toolMsg = messages[i + 1 + j];
          const result = toolMsg && toolMsg.role === 'tool' ? parseToolMessageResult(toolMsg) : null;
          const toolRawIdx = group[i + 1 + j].rawIndex;
          blocks.push({
            type: 'tool',
            tool_name: name,
            status: 'completed',
            arguments: args,
            result,
          });
          starts.push(toolRawIdx);
        }
        i += 1 + toolCalls.length;
        continue;
      }
      i++;
    } else if (msg.role === 'tool') {
      i++;
    } else {
      i++;
    }
  }
  return { blocks, starts };
}

function findInsertBeforePreIndex(starts: number[], e: number): number {
  for (let b = 0; b < starts.length; b++) {
    if (starts[b] >= e) return b;
  }
  return starts.length;
}

export type ContextCompressVisualPlacement =
  | { kind: 'beforeBubble'; insertBeforeIndex: number; coversExclusiveEndRaw: number }
  | {
      kind: 'insideAssistant';
      assistantMessageIndex: number;
      insertBeforeBlockIndex: number;
      coversExclusiveEndRaw: number;
    };

export function rawCoversExclusiveEndToVisualPlacement(
  rawMessages: ConversationMessage[] | null | undefined,
  coversExclusiveEnd: number
): ContextCompressVisualPlacement | null {
  const e =
    typeof coversExclusiveEnd === 'number' && Number.isFinite(coversExclusiveEnd)
      ? Math.floor(coversExclusiveEnd)
      : NaN;
  const arr = rawMessages ?? [];
  if (!Array.isArray(arr) || arr.length === 0 || !Number.isFinite(e) || e < 0 || e >= arr.length) {
    return null;
  }
  const msgAtE = arr[e];
  if (!msgAtE || typeof msgAtE.role !== 'string') return null;

  const bubbleMap = mapRawMessageIndexToLocalBubbleIndex(arr);
  if (!bubbleMap.has(e)) return null;
  const localIdx = bubbleMap.get(e)!;

  if (msgAtE.role === 'user') {
    return { kind: 'beforeBubble', insertBeforeIndex: localIdx, coversExclusiveEndRaw: e };
  }

  if (msgAtE.role !== 'assistant' && msgAtE.role !== 'tool') return null;

  const group = extractAssistantGroupContainingRawIndex(arr, e);
  if (!group || group.length === 0) return null;

  const { blocks: preBlocks, starts } = buildPreMergeBlocksWithRawStarts(group);
  const insertBeforePre = findInsertBeforePreIndex(starts, e);
  // Mobile 渲染未对 start/stop_doc_recording 做块合并，与 Web post-merge 下标对齐用「合并前」下标即可。
  const insertBeforeBlockIndex = insertBeforePre;

  return {
    kind: 'insideAssistant',
    assistantMessageIndex: localIdx,
    insertBeforeBlockIndex,
    coversExclusiveEndRaw: e,
  };
}

export type ContextCompressDividerPlacement =
  | {
      kind: 'beforeIndex';
      insertBeforeIndex: number;
      activeSummary: ContextSummary;
      visibleCount: number;
      fullCount: number;
      fullLocalBubbleCount: number;
      coversExclusiveEndRaw: number;
    }
  | {
      kind: 'insideAssistantBlocks';
      assistantMessageIndex: number;
      insertBeforeBlockIndex: number;
      activeSummary: ContextSummary;
      visibleCount: number;
      fullCount: number;
      fullLocalBubbleCount: number;
      coversExclusiveEndRaw: number;
    }
  | {
      kind: 'afterLastVisible';
      activeSummary: ContextSummary;
      visibleCount: number;
      fullCount: number;
      fullLocalBubbleCount: number;
      coversExclusiveEnd: number;
      localInsertBeforeIndex: number;
    };

export function resolveContextCompressDividerPlacement(p: {
  messageCount: number;
  rawMessages: unknown;
  contextSummaries: unknown;
  activeContextSummaryId: string | null | undefined;
  /** 尾窗模式：当前窗口首条在全量里的下标（= messageWindowMeta.viewStart）。不传 = 0（全量，旧行为）。 */
  rawViewOffset?: number;
  /** 尾窗模式：全量消息总数（= messageWindowMeta.total）。不传 = 用 arr.length（全量，旧行为）。 */
  rawTotal?: number;
}): ContextCompressDividerPlacement | null {
  const n =
    typeof p.messageCount === 'number' && Number.isFinite(p.messageCount) ? Math.floor(p.messageCount) : 0;
  const aid = typeof p.activeContextSummaryId === 'string' ? p.activeContextSummaryId.trim() : '';
  if (!aid || n <= 0) return null;

  const arr = Array.isArray(p.rawMessages) ? (p.rawMessages as ConversationMessage[]) : [];
  if (arr.length === 0) return null;

  const list = Array.isArray(p.contextSummaries) ? (p.contextSummaries as ContextSummary[]) : [];
  const active = list.find((s) => s && typeof s === 'object' && s.id === aid);
  if (!active) return null;

  const e = active.covers_exclusive_end;
  if (typeof e !== 'number' || !Number.isFinite(e)) return null;
  const ei = Math.floor(e); // 全局坐标：covers raw[0..ei-1]

  // 尾窗坐标系：arr 只是 [viewOffset, viewOffset+arr.length) 这一窗口；ei 是全局下标。
  const viewOffset =
    typeof p.rawViewOffset === 'number' && Number.isFinite(p.rawViewOffset) && p.rawViewOffset >= 0
      ? Math.floor(p.rawViewOffset)
      : 0;
  const fullCount =
    typeof p.rawTotal === 'number' && Number.isFinite(p.rawTotal) && p.rawTotal >= 0
      ? Math.floor(p.rawTotal)
      : arr.length;

  if (ei <= 0 || ei >= fullCount) return null;

  const fullLocalBubbleCount = rawMessagesToLocal(arr).length;
  const viewEnd = viewOffset + arr.length;
  // 整个可见窗口都还在压缩区里（逐字起点在窗口之后）—— 不画分界
  if (viewEnd <= ei) return null;
  // 逐字起点在窗口之前 / 恰在窗首 —— 整窗都是逐字区，顶部画"上文已压缩"
  if (viewOffset >= ei) {
    return {
      kind: 'beforeIndex',
      insertBeforeIndex: 0,
      activeSummary: active,
      visibleCount: n,
      fullCount,
      fullLocalBubbleCount,
      coversExclusiveEndRaw: ei,
    };
  }

  // 逐字起点落在窗口内：把全局 ei 转成窗口内局部坐标再求 visual placement
  const eLocal = ei - viewOffset;
  const visual = rawCoversExclusiveEndToVisualPlacement(arr, eLocal);
  if (!visual) return null;

  if (visual.kind === 'beforeBubble') {
    if (visual.insertBeforeIndex < n) {
      return {
        kind: 'beforeIndex',
        insertBeforeIndex: visual.insertBeforeIndex,
        activeSummary: active,
        visibleCount: n,
        fullCount,
        fullLocalBubbleCount,
        coversExclusiveEndRaw: ei,
      };
    }
    return {
      kind: 'afterLastVisible',
      activeSummary: active,
      visibleCount: n,
      fullCount,
      fullLocalBubbleCount,
      coversExclusiveEnd: ei,
      localInsertBeforeIndex: visual.insertBeforeIndex,
    };
  }

  if (visual.kind === 'insideAssistant') {
    if (visual.assistantMessageIndex < n) {
      return {
        kind: 'insideAssistantBlocks',
        assistantMessageIndex: visual.assistantMessageIndex,
        insertBeforeBlockIndex: visual.insertBeforeBlockIndex,
        activeSummary: active,
        visibleCount: n,
        fullCount,
        fullLocalBubbleCount,
        coversExclusiveEndRaw: ei,
      };
    }
    return {
      kind: 'afterLastVisible',
      activeSummary: active,
      visibleCount: n,
      fullCount,
      fullLocalBubbleCount,
      coversExclusiveEnd: ei,
      localInsertBeforeIndex: visual.assistantMessageIndex,
    };
  }

  return null;
}

export function getCompressedRegionLastMessagePreview(
  rawMessages: unknown,
  coversExclusiveEnd: number | undefined
): string {
  const arr = Array.isArray(rawMessages) ? (rawMessages as ConversationMessage[]) : [];
  const e =
    typeof coversExclusiveEnd === 'number' && Number.isFinite(coversExclusiveEnd)
      ? Math.floor(coversExclusiveEnd)
      : 0;
  if (e <= 0 || arr.length === 0) return '';

  function collapseWhitespace(s: string): string {
    return String(s || '')
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function visibleTextFromRaw(m: ConversationMessage): string {
    if (!m || typeof m.role !== 'string') return '';
    const role = m.role;
    if (role === 'tool' || role === 'system') return '';
    if (role === 'user') {
      if (rawUserMessageIsMetaOnly(m)) return '';
      return collapseWhitespace(typeof m.content === 'string' ? m.content : '');
    }
    if (role === 'assistant') {
      return collapseWhitespace(typeof m.content === 'string' ? m.content : '');
    }
    return '';
  }

  for (let i = e - 1; i >= 0; i--) {
    const t = visibleTextFromRaw(arr[i]);
    if (t) return t;
  }
  return '';
}
