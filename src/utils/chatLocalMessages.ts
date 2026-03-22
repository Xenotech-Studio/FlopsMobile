/**
 * 服务端 OpenAI 式 messages → 本地气泡列表；与用量 run 的 raw 下标对齐。
 */
import type { ConversationMessage } from '../api';

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
  | { role: 'user'; content: string }
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
      flushAssistant();
      const content = typeof msg.content === 'string' ? msg.content : '';
      messages.push({ role: 'user', content });
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
