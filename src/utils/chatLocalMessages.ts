/**
 * 服务端 OpenAI 式 messages → 本地气泡列表；与用量 run 的 raw 下标对齐。
 */
import type { ConversationMessage } from '../api';
import { normalizeFlopsRefs, type FlopsRef } from '../chat/flopsRefs';

export type ToolResult = {
  stdout?: string;
  stderr?: string;
  error?: string;
  success?: boolean;
  exit_code?: number;
};

export type StreamBlock =
  | { type: 'text'; content: string }
  | {
      type: 'thinking';
      content: string;
      /** false：当前还在流式接收；true：已收口（后续 text/tool 已开始或流结束） */
      closed: boolean;
      /** 服务端记录的推理耗时；恢复历史时可能携带，流式中常为空 */
      seconds?: number;
      /** 流式开始时间（ms epoch），用于"短思考默认隐藏"判断 */
      startedAt?: number;
    }
  | {
      type: 'tool';
      index?: number;
      tool_name: string;
      status: string;
      arguments?: string;
      streaming_content?: string;
      result?: ToolResult | unknown;
      review_id?: string;
      conversation_id?: string;
      review?: Record<string, unknown>;
      command?: string;
      cwd?: string;
    };

export type ChatMessage =
  | { role: 'user'; content: string; flops_refs?: FlopsRef[] }
  | { role: 'assistant'; content: string; blocks?: StreamBlock[] }
  | { role: 'error'; content: string };

function parseToolResult(msg: ConversationMessage): unknown {
  if (!msg || msg.role !== 'tool') return null;
  const raw = typeof msg.content === 'string' ? msg.content : '';
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** 将服务端一轮 assistant + tool 消息合并为一条本地 assistant（含 blocks） */
export function coalesceAssistantTurn(messages: ConversationMessage[]): ChatMessage | null {
  if (!messages || messages.length === 0) return null;
  const blocks: StreamBlock[] = [];
  let fullContent = '';
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      // 思考字段（多别名兼容服务端 reasoning_wire）：若存在，先于正文渲染为可折叠思考块
      const rawAny = msg as unknown as Record<string, unknown>;
      const reasoningRaw =
        (typeof rawAny.reasoning_content === 'string' && rawAny.reasoning_content) ||
        (typeof rawAny.thinking === 'string' && rawAny.thinking) ||
        (typeof rawAny.reasoning === 'string' && rawAny.reasoning) ||
        '';
      if (typeof reasoningRaw === 'string' && reasoningRaw.trim()) {
        const rsRaw =
          typeof rawAny.reasoning_seconds === 'number'
            ? (rawAny.reasoning_seconds as number)
            : Number(rawAny.reasoning_seconds);
        const seconds = Number.isFinite(rsRaw) && rsRaw > 0 ? rsRaw : undefined;
        blocks.push({
          type: 'thinking',
          content: reasoningRaw,
          closed: true,
          ...(seconds !== undefined ? { seconds } : {}),
        });
      }
      const text = (msg.content != null ? String(msg.content) : '').trim();
      if (text) {
        blocks.push({ type: 'text', content: text });
        fullContent += (fullContent ? '\n\n' : '') + text;
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
          const result = toolMsg && toolMsg.role === 'tool' ? parseToolResult(toolMsg) : null;
          blocks.push({
            type: 'tool',
            tool_name: name,
            status: 'completed',
            arguments: args,
            result,
          });
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
  if (blocks.length === 0) return null;
  return {
    role: 'assistant',
    content: fullContent || '(empty)',
    blocks,
  };
}

export type RawMessagesLocalResult = {
  messages: ChatMessage[];
  /** 服务端 raw 下标 → 合并后 messages 数组中 assistant 条目的下标 */
  rawToLocalAssistantIndex: Map<number, number>;
};

function isTruthyMetaFlag(v: unknown): boolean {
  return v === true || v === 1 || v === 'true';
}

/** 与 Web/Desktop messageTransform.rawUserMessageIsMetaOnly 一致 */
export function rawUserMessageIsMetaOnly(msg: ConversationMessage | null | undefined): boolean {
  if (!msg || msg.role !== 'user') return false;
  if (isTruthyMetaFlag(msg.isMeta)) return true;
  const md = msg.metadata;
  if (md && typeof md === 'object' && isTruthyMetaFlag(md.isMeta)) return true;
  return false;
}

/**
 * 单次遍历生成本地消息列表与 raw→assistant 下标映射（供 usage_runs 对齐）。
 */
export function rawMessagesToLocalWithUsageMap(raw: ConversationMessage[]): RawMessagesLocalResult {
  const messages: ChatMessage[] = [];
  const rawToLocalAssistantIndex = new Map<number, number>();
  let assistantGroup: ConversationMessage[] = [];
  let groupRawIndices: number[] = [];

  const flushAssistant = () => {
    const one = coalesceAssistantTurn(assistantGroup);
    if (one) {
      const localIdx = messages.length;
      messages.push(one);
      for (const ri of groupRawIndices) {
        rawToLocalAssistantIndex.set(ri, localIdx);
      }
    }
    assistantGroup = [];
    groupRawIndices = [];
  };

  for (let i = 0; i < (raw ?? []).length; i++) {
    const msg = raw[i];
    if (!msg || typeof msg.role !== 'string') continue;
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      if (rawUserMessageIsMetaOnly(msg)) continue;
      flushAssistant();
      const content = typeof msg.content === 'string' ? msg.content : '';
      const refs = normalizeFlopsRefs(
        (msg.metadata && (msg.metadata as Record<string, unknown>).flops_refs) || null,
      );
      messages.push(
        refs.length > 0
          ? { role: 'user', content, flops_refs: refs }
          : { role: 'user', content },
      );
      continue;
    }
    if (msg.role === 'assistant' || msg.role === 'tool') {
      assistantGroup.push(msg);
      groupRawIndices.push(i);
      continue;
    }
  }
  flushAssistant();
  return { messages, rawToLocalAssistantIndex };
}

export function rawMessagesToLocal(raw: ConversationMessage[]): ChatMessage[] {
  return rawMessagesToLocalWithUsageMap(raw).messages;
}

export function resolveLocalAssistantIndexFromRawUsageIndex(
  rawToLocal: Map<number, number>,
  rawIdx: number
): number {
  if (!(rawToLocal instanceof Map) || typeof rawIdx !== 'number' || rawIdx < 0) return -1;
  if (rawToLocal.has(rawIdx)) return rawToLocal.get(rawIdx)!;
  for (let d = 1; d <= 12; d++) {
    const j = rawIdx - d;
    if (j >= 0 && rawToLocal.has(j)) return rawToLocal.get(j)!;
  }
  return -1;
}
