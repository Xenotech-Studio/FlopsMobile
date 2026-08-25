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

export type TaskEventPayload = {
  status?: string;
  exit_code?: number;
  runtime_seconds?: number;
  description?: string;
  command?: string;
  cwd?: string;
  log_path?: string;
  log_size_bytes?: number;
  log_tail?: string;
  log_tail_truncated?: boolean;
  task_id?: string;
  device_id?: string;
  ended_at?: string;
  /** 事件种类。缺省（旧执行端 / 后台命令）= 子进程任务完成；'browser_download' = 内建浏览器下载。 */
  kind?: string;
  /** 下载事件分两阶段：'started' 触发时、'done' 结束时。 */
  phase?: string;
  download_url?: string;
  download_filename?: string;
  download_save_path?: string;
  download_total_bytes?: number;
  download_received_bytes?: number;
};

export type StreamBlock =
  | { type: 'text'; content: string }
  | {
      type: 'task_event';
      content: string;
      task_event: TaskEventPayload | null;
      arrival?: string;
    }
  | { type: 'user_injection'; content: string; arrival?: string }
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
      tool_call_id?: string;
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
      /** 工具授权（批量标题解密 / 档B对话访问）：挂起等用户放行时，按钮内嵌进本工具卡 */
      auth_request?: {
        kind: 'titles' | 'access';
        request_id: string;
        requester_conversation_id: string;
        count?: number;
        target_ids?: string[];
        target_conversation_id?: string;
        reason?: string;
      };
      authorization_error?: string;
    };

/** 服务端 TTS 落库的音频元数据（挂在 assistant 消息 metadata.audio）。 */
export type MessageAudio = {
  format?: string;
  sample_rate?: number;
  /** 完整 mp3 URL 列表（encrypted 时为 .mp3.enc）。 */
  segments: string[];
  encrypted?: boolean;
};

/** 用户消息附件（对齐 web metadata.flops_attachments）：聊天里渲染成可点击的文件链/卡片。 */
export type FlopsAttachment = {
  url: string;
  filename: string;
  mime_type?: string;
  /** 字节大小（若服务端给了 size / size_bytes）。 */
  size?: number;
};

/** 从服务端 metadata.flops_attachments 归一化出附件列表；无 url 的丢弃。 */
export function normalizeFlopsAttachments(raw: unknown): FlopsAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: FlopsAttachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const rec = a as Record<string, unknown>;
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!url) continue;
    const filename =
      (typeof rec.filename === 'string' && rec.filename.trim()) ||
      (typeof rec.name === 'string' && (rec.name as string).trim()) ||
      '附件';
    const mime =
      typeof rec.mime_type === 'string' && rec.mime_type.trim() ? rec.mime_type.trim() : undefined;
    const sizeRaw = rec.size ?? rec.size_bytes;
    const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? sizeRaw : undefined;
    out.push({
      url,
      filename,
      ...(mime ? { mime_type: mime } : {}),
      ...(size !== undefined ? { size } : {}),
    });
  }
  return out;
}

export type ChatMessage = (
  | { role: 'user'; content: string; flops_refs?: FlopsRef[]; attachments?: FlopsAttachment[] }
  | { role: 'assistant'; content: string; blocks?: StreamBlock[]; audio?: MessageAudio }
  | { role: 'task_event'; content: string; task_event: TaskEventPayload | null; arrival?: string }
  | { role: 'error'; content: string }
) & {
  /** 本条本地消息在「当前窗口 serverRawMessages」里的起始 raw 下标。
   *  渲染时配合 messageWindow.viewStart 得到不随 prepend/append 漂移的全局 key
   *  （维持 maintainVisibleContentPosition 的视图身份）。流式/乐观插入的消息可能无此值。 */
  _key?: number;
};

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
  // 合并本轮所有 assistant 消息的 metadata.audio.segments（去重保序）。
  // 服务端每个 run 幂等写全量 segments，但一轮可能含多个 run；累积以防漏段。
  const audioSegments: string[] = [];
  let audioMeta: { format?: string; sample_rate?: number; encrypted?: boolean } | null = null;
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const audioRaw = (msg.metadata as Record<string, unknown> | undefined)?.audio as
        | MessageAudio
        | undefined;
      if (audioRaw && Array.isArray(audioRaw.segments)) {
        for (const s of audioRaw.segments) {
          if (typeof s === 'string' && s && !audioSegments.includes(s)) audioSegments.push(s);
        }
        audioMeta = {
          format: audioRaw.format,
          sample_rate: audioRaw.sample_rate,
          encrypted: audioRaw.encrypted,
        };
      }
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
            tool_call_id: tc && typeof tc === 'object' && tc.id != null ? String(tc.id) : undefined,
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
    } else if (
      msg.role === 'user' &&
      (msg as unknown as { kind?: unknown }).kind === 'task_event'
    ) {
      blocks.push(taskEventToBlock(msg));
      i++;
    } else if (msg.role === 'user' && arrivalOf(msg) === 'injection') {
      blocks.push(userInjectionToBlock(msg));
      i++;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) return null;
  const out: ChatMessage = {
    role: 'assistant',
    content: fullContent || '(empty)',
    blocks,
  };
  if (audioSegments.length > 0) {
    out.audio = { ...(audioMeta ?? {}), segments: audioSegments };
  }
  return out;
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

/** 后台任务完成事件（isMeta user + kind=task_event）：不进 LLM 视角，渲染成全宽灰条 */
export function rawUserMessageIsTaskEvent(msg: ConversationMessage | null | undefined): boolean {
  if (!msg || msg.role !== 'user') return false;
  if ((msg as unknown as { kind?: unknown }).kind !== 'task_event') return false;
  if (isTruthyMetaFlag(msg.isMeta)) return true;
  const md = msg.metadata;
  if (md && typeof md === 'object' && isTruthyMetaFlag(md.isMeta)) return true;
  return false;
}

function taskEventPayloadOf(msg: ConversationMessage): TaskEventPayload | null {
  const te = (msg as unknown as { task_event?: unknown }).task_event;
  return te && typeof te === 'object' ? (te as TaskEventPayload) : null;
}

function arrivalOf(msg: ConversationMessage): string {
  const a = (msg as unknown as { arrival?: unknown }).arrival;
  return typeof a === 'string' ? a : '';
}

/** task_event → 独立气泡（触发：自成 turn 头） */
function taskEventToLocal(msg: ConversationMessage): ChatMessage {
  return {
    role: 'task_event',
    content: typeof msg.content === 'string' ? msg.content : '',
    task_event: taskEventPayloadOf(msg),
    arrival: arrivalOf(msg) || 'trigger',
  };
}

/** task_event → assistant turn 内 inline block（穿插） */
function taskEventToBlock(msg: ConversationMessage): StreamBlock {
  return {
    type: 'task_event',
    content: typeof msg.content === 'string' ? msg.content : '',
    task_event: taskEventPayloadOf(msg),
    arrival: arrivalOf(msg) || 'injection',
  };
}

export function rawTaskEventIsInjection(msg: ConversationMessage): boolean {
  return rawUserMessageIsTaskEvent(msg) && arrivalOf(msg) === 'injection';
}

/** P2 真实用户消息的「立刻穿插」：role=user、arrival=injection、非 task_event */
export function rawUserMessageIsInjection(msg: ConversationMessage): boolean {
  return (
    !!msg &&
    msg.role === 'user' &&
    (msg as unknown as { kind?: unknown }).kind !== 'task_event' &&
    arrivalOf(msg) === 'injection'
  );
}

/** 穿插用户消息 → assistant turn 内 inline block */
function userInjectionToBlock(msg: ConversationMessage): StreamBlock {
  return {
    type: 'user_injection',
    content: typeof msg.content === 'string' ? msg.content : '',
    arrival: 'injection',
  };
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
      // 该 assistant 轮的起始 raw 下标（窗口内），用于稳定全局 key
      one._key = groupRawIndices.length > 0 ? groupRawIndices[0] : undefined;
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
      if (rawUserMessageIsInjection(msg) && assistantGroup.length > 0) {
        // P2 用户穿插：并入当前 assistant turn 成 inline block
        assistantGroup.push(msg);
        groupRawIndices.push(i);
        continue;
      }
      if (rawUserMessageIsTaskEvent(msg)) {
        // 穿插：并入当前 assistant turn 成 inline block；触发：独立 turn 头
        if (rawTaskEventIsInjection(msg) && assistantGroup.length > 0) {
          assistantGroup.push(msg);
          groupRawIndices.push(i);
          continue;
        }
        flushAssistant();
        messages.push({ ...taskEventToLocal(msg), _key: i });
        continue;
      }
      if (rawUserMessageIsMetaOnly(msg)) continue;
      flushAssistant();
      const content = typeof msg.content === 'string' ? msg.content : '';
      const md = (msg.metadata && (msg.metadata as Record<string, unknown>)) || null;
      const refs = normalizeFlopsRefs((md && md.flops_refs) || null);
      const attachments = normalizeFlopsAttachments(md && md.flops_attachments);
      const userMsg: Extract<ChatMessage, { role: 'user' }> = { role: 'user', content, _key: i };
      if (refs.length > 0) userMsg.flops_refs = refs;
      if (attachments.length > 0) userMsg.attachments = attachments;
      messages.push(userMsg);
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
