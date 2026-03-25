/**
 * Flops 服务端 API 客户端（仅 chat 相关）
 * 与 FlopsDesktop 行为对齐：登录、会话、流式聊天、取消、安全确认。
 */
import { convProfileLog } from './debug/conversationLoadProfile';
import { fetchWithDebugLog } from './utils/httpDebugLog';

export type Session = {
  user_id: string;
  server_base_url: string;
  access_token: string;
};

/** 用量快照（与 server merge_usage_stats 结构一致） */
export type UsageByModelRow = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  estimated_cost_usd?: number;
};

export type UsageStats = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  estimated_cost_usd?: number;
  by_model?: Record<string, UsageByModelRow>;
};

export type UsageRun = {
  run_id?: string;
  last_message_index?: number;
  usage?: UsageStats;
};

export type ChatStreamEvent =
  | { type: 'v2_run'; run_id?: string }
  | { type: 'thinking' }
  | { type: 'checking_tools' }
  | { type: 'tool_call_start'; index: number; name: string }
  | { type: 'tool_call_delta'; index: number; arguments_delta: string }
  | { type: 'tool_call_ready'; index: number; name: string; arguments: string }
  | { type: 'tool_call_executing'; index: number }
  | { type: 'tool_call_done'; index: number; success?: boolean }
  | { type: 'tool_start'; tool_name: string; arguments?: string; index?: number }
  | { type: 'tool_stream'; tool_name: string; chunk: string }
  | { type: 'tool_result'; tool_name: string; result: unknown; index?: number }
  | { type: 'tool_result_chunk'; index: number; stdout_append?: string; set?: Record<string, unknown>; patches?: unknown; readings_by_url?: Record<string, unknown> }
  | { type: 'safety_confirmation_required'; tool_name: string; review_id: string; command?: string; cwd?: string; arguments?: string; review?: Record<string, unknown>; conversation_id?: string }
  | { type: 'safety_review'; tool_name: string; review: Record<string, unknown> }
  | { type: 'step_complete' }
  | { type: 'cancelled'; done?: boolean }
  | {
      type: 'usage';
      usage_stats?: UsageStats;
      usage_run?: UsageRun;
      conversation_id?: string;
    }
  | { content?: string; error?: string; done?: boolean; conversation_id?: string };

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
}

/**
 * 登录：POST /api/login
 */
export async function login(
  serverBaseUrl: string,
  userId: string,
  password: string,
  deviceName: string = 'FlopsMobile'
): Promise<{ session: Session }> {
  const base = ensureSlash(serverBaseUrl);
  const res = await fetchWithDebugLog(
    `${base}api/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: userId,
        password,
        device_name: deviceName,
      }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `登录失败: ${res.status}`);
  }
  const data = (await res.json()) as {
    user?: { id?: string };
    access_token?: string;
  };
  const token = data.access_token;
  const uid = (data.user && data.user.id) || userId;
  if (!token) throw new Error('服务端未返回 access_token');
  return {
    session: {
      user_id: uid,
      server_base_url: base,
      access_token: token,
    },
  };
}

/**
 * 修改密码：POST /api/change_user_password
 * 需要当前密码验证，成功后仅服务端更新密码，本地 session 不变（下次登录用新密码）。
 */
export async function changePassword(
  serverBaseUrl: string,
  userId: string,
  oldPassword: string,
  newPassword: string
): Promise<{ message: string }> {
  const base = ensureSlash(serverBaseUrl);
  const res = await fetchWithDebugLog(
    `${base}api/change_user_password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: userId,
        old_password: oldPassword,
        password: newPassword,
      }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `修改密码失败: ${res.status}`);
  }
  const data = (await res.json()) as { message?: string };
  return { message: data.message ?? 'Password changed successfully' };
}

/** 当前用户信息（含头像、昵称），来自 GET /api/user/{user_id} */
export type CurrentUserInfo = {
  id?: string;
  nickname?: string;
  avatarUrl?: string;
  [key: string]: unknown;
};

/**
 * 获取当前用户信息（含 avatarUrl、nickname），用于账户页展示头像等
 */
export async function getCurrentUserInfo(
  serverBaseUrl: string,
  userId: string,
  accessToken: string
): Promise<CurrentUserInfo | null> {
  const base = ensureSlash(serverBaseUrl);
  const url = `${base}api/user/${encodeURIComponent(userId)}?access_token=${encodeURIComponent(accessToken)}`;
  try {
    const res = await fetchWithDebugLog(url);
    if (!res.ok) return null;
    const data = (await res.json()) as CurrentUserInfo;
    return data;
  } catch {
    return null;
  }
}

export type ConversationListItem = {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  message_count?: number;
  /** 与 Web 列表一致：chat_v2 是否有进行中的 run */
  chat_v2_running?: boolean;
  /** 与 Web 列表一致：本轮结束后未在会话内读过 */
  chat_v2_unread?: boolean;
};

export type ConversationMessage = {
  role: string;
  content?: string;
  metadata?: Record<string, unknown>;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
};

export type AgentProfile = {
  display_name?: string;
  call_name?: string;
};

export type Conversation = {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  messages?: ConversationMessage[];
  /** 服务端仍有进行中的 chat_v2 run 时存在，用于 subscribe_only 恢复 */
  active_chat_v2_run_id?: string;
  usage_stats?: UsageStats;
  usage_runs?: UsageRun[];
  bound_agent_id?: string;
  agent_profile?: AgentProfile;
};

/**
 * 获取对话列表：GET /api/conversations
 */
export async function listConversations(
  session: Session
): Promise<{ conversations: ConversationListItem[] }> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `获取对话列表失败: ${res.status}`);
  }
  const data = (await res.json()) as ConversationListItem[] | { conversations?: ConversationListItem[] };
  const list = Array.isArray(data) ? data : (data as { conversations?: ConversationListItem[] }).conversations ?? [];
  return { conversations: list };
}

type ResponseBodyReader = { read(): Promise<{ value?: Uint8Array; done: boolean }> };

/**
 * 对话列表「进行中 / 未读」实时状态：GET /api/conversations/inbox/stream（SSE），与 FlopsWeb ConversationList 对齐。
 * 需在 RN 开启流式 response.body（与 streamChat 相同）。
 */
export async function runInboxStream(
  session: Session,
  signal: AbortSignal,
  onData: (msg: Record<string, unknown>) => void
): Promise<void> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations/inbox/stream`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
    signal,
    reactNative: { textStreaming: true },
  } as RequestInit);
  if (!res.ok) return;
  const resAny = res as { body?: { getReader(): ResponseBodyReader } };
  const reader = resAny.body?.getReader();
  if (!reader) return;

  const g = (typeof globalThis !== 'undefined' ? globalThis : {}) as Record<string, unknown>;
  const TD = g.TextDecoder as new (label?: string) => { decode(d: Uint8Array): string } | undefined;
  const decodeChunk = (b: Uint8Array | undefined): string => {
    if (!b) return '';
    if (!TD) return Array.from(b).map((c) => String.fromCharCode(c)).join('');
    return new TD('utf-8').decode(b);
  };
  let buffer = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decodeChunk(value);
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (!raw) continue;
      try {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        onData(msg);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 获取单个对话详情（含消息）：GET /api/conversations/:id
 */
export async function getConversation(
  session: Session,
  conversationId: string
): Promise<{ conversation: Conversation }> {
  const base = session.server_base_url;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `获取对话失败: ${res.status}`);
  }
  const conversation = (await res.json()) as Conversation;
  const t2 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const msgs = conversation?.messages;
  const messageCount = Array.isArray(msgs) ? msgs.length : 0;
  const rid = conversation?.active_chat_v2_run_id;
  const hasActiveRun = typeof rid === 'string' && rid.trim().length > 0;
  convProfileLog('getConversation', {
    conversationId,
    /** fetch Promise resolve（RN 上通常接近首包+下载完成，不等同于纯 TTFB） */
    fetchAwaitMs: Math.round(t1 - t0),
    resJsonParseMs: Math.round(t2 - t1),
    fetchPlusJsonMs: Math.round(t2 - t0),
    status: res.status,
    messageCount,
    hasActiveRun,
  });
  return { conversation };
}

/**
 * 删除会话：DELETE /api/conversations/:id
 */
export async function deleteConversation(
  session: Session,
  conversationId: string
): Promise<void> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `删除对话失败: ${res.status}`);
  }
}

/**
 * 创建会话：POST /api/conversations（可选 body.bound_agent_id，与 FlopsWeb 一致）
 */
export async function createConversation(
  session: Session,
  opts?: { bound_agent_id?: string }
): Promise<{ id: string }> {
  const base = session.server_base_url;
  const body: Record<string, string> = {};
  const bid = String(opts?.bound_agent_id || '').trim();
  if (bid) body.bound_agent_id = bid;
  const res = await fetchWithDebugLog(`${base}api/conversations`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `创建会话失败: ${res.status}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error('服务端未返回会话 id');
  return { id: data.id };
}

/** GET /api/agentf/agent-ids — 与 FlopsWeb Chat.jsx 一致 */
export async function getAgentIds(session: Session): Promise<string[]> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/agentf/agent-ids`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { agent_ids?: unknown };
  return Array.isArray(data.agent_ids) ? data.agent_ids.map(String) : [];
}

/** GET /api/agent/profile?agent_id= — 与 FlopsWeb 一致 */
export async function getAgentProfile(session: Session, agentId: string): Promise<AgentProfile> {
  const base = session.server_base_url;
  const id = String(agentId || '').trim();
  if (!id) return {};
  const res = await fetchWithDebugLog(
    `${base}api/agent/profile?agent_id=${encodeURIComponent(id)}`,
    {
      method: 'GET',
      headers: authHeaders(session.access_token),
    }
  );
  if (!res.ok) return {};
  const data = (await res.json()) as Record<string, unknown>;
  return {
    display_name: typeof data.display_name === 'string' ? data.display_name : undefined,
    call_name: typeof data.call_name === 'string' ? data.call_name : undefined,
  };
}

/** PUT /api/agent/profile — body { agent_id, display_name?, call_name? }，与 server.py 一致 */
export async function putAgentProfile(
  session: Session,
  agentId: string,
  body: { display_name: string; call_name: string }
): Promise<AgentProfile> {
  const base = session.server_base_url;
  const id = String(agentId || '').trim();
  if (!id) throw new Error('缺少 agent_id');
  const res = await fetchWithDebugLog(`${base}api/agent/profile`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      agent_id: id,
      display_name: body.display_name,
      call_name: body.call_name,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `保存资料失败: ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    display_name: typeof data.display_name === 'string' ? data.display_name : undefined,
    call_name: typeof data.call_name === 'string' ? data.call_name : undefined,
  };
}

export type StreamChatOptions = {
  /** 重新回答：不发送新消息，让服务端截断后重新流式生成 */
  regenerate?: boolean;
  /** 0-based 的第几条 user 消息后重新生成（不传则最后一条） */
  after_user_index?: number;
};

/**
 * 流式聊天：POST /api/conversations/:id/chat，SSE 解析后按事件回调
 * options.regenerate 为 true 时请求重新回答最后一条 user 消息，可不传 message。
 */
export async function streamChat(
  session: Session,
  conversationId: string,
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  options?: StreamChatOptions
): Promise<void> {
  const base = session.server_base_url;
  const body = options?.regenerate
    ? { regenerate: true, ...(options.after_user_index != null && { after_user_index: options.after_user_index }) }
    : { message };
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/chat`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify(body),
    signal,
    // RN 默认 fetch 无 response.body，需用 react-native-fetch-api 并开启流式
    reactNative: { textStreaming: true },
  } as RequestInit);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `请求失败: ${res.status}`);
  }
  const resAny = res as { body?: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } } };
  const reader = resAny.body?.getReader();
  if (!reader) throw new Error('响应无 body');

  const g = (typeof globalThis !== 'undefined' ? globalThis : {}) as Record<string, unknown>;
  const TD = g.TextDecoder as new (label?: string) => { decode(d: Uint8Array): string } | undefined;
  const decodeChunk = (b: Uint8Array | undefined): string => {
    if (!b) return '';
    const Decoder = TD;
    if (!Decoder) return Array.from(b).map((c) => String.fromCharCode(c)).join('');
    return new (Decoder as new (label?: string) => { decode(d: Uint8Array): string })('utf-8').decode(b);
  };
  let buffer = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decodeChunk(value);
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (dataLine) {
        const raw = dataLine.slice(5).trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as ChatStreamEvent;
            onEvent(parsed);
            if ('done' in parsed && parsed.done === true) return;
            if ('type' in parsed && parsed.type === 'cancelled') return;
            // 让每个 tool_result_chunk 单独一帧渲染，等下一帧再处理下一条，便于 UI 逐段绘制
            if ('type' in parsed && parsed.type === 'tool_result_chunk') {
              await new Promise<void>((r) => {
                if (typeof requestAnimationFrame !== 'undefined') {
                  requestAnimationFrame(() => setTimeout(r, 0));
                } else {
                  setTimeout(r, 0);
                }
              });
            }
          } catch {
            // 忽略单帧解析错误
          }
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

const CHAT_V2_RECONNECT_MAX = 8;
const CHAT_V2_RECONNECT_DELAY_MS = 300;

export type ChatV2StreamStart =
  | { tag: 'new_message'; message: string }
  | { tag: 'regenerate'; after_user_index: number }
  | { tag: 'resume'; run_id: string };

export type StreamChatV2LoopOptions = {
  /** 返回 false 时停止循环（例如已切换对话） */
  isAlive?: () => boolean;
};

function getTextDecoder(): { decode(chunk: Uint8Array, options?: { stream?: boolean }): string } {
  const g = (typeof globalThis !== 'undefined' ? globalThis : {}) as Record<string, unknown>;
  const TD = g.TextDecoder as
    | (new (label?: string) => { decode(chunk: Uint8Array, options?: { stream?: boolean }): string })
    | undefined;
  if (TD) return new TD('utf-8');
  return {
    decode(chunk: Uint8Array) {
      return Array.from(chunk)
        .map((c) => String.fromCharCode(c))
        .join('');
    },
  };
}

async function yieldToolResultChunkFrame(): Promise<void> {
  await new Promise<void>((r) => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => setTimeout(r, 0));
    } else {
      setTimeout(r, 0);
    }
  });
}

/**
 * chat_v2：首包发消息或 regenerate，断线后 subscribe_only + replay_from 重连（与 FlopsWeb 一致）。
 */
export async function streamChatV2Loop(
  session: Session,
  conversationId: string,
  start: ChatV2StreamStart,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  options?: StreamChatV2LoopOptions
): Promise<void> {
  const base = session.server_base_url;
  const alive = options?.isAlive ?? (() => true);
  let v2RunId = start.tag === 'resume' ? String(start.run_id || '').trim() : '';
  let replayFrom = 0;
  let reconnectAttempt = 0;
  let streamCompleted = false;
  const decoder = getTextDecoder();

  const consumeReader = async (
    reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> }
  ): Promise<void> => {
    let buffer = '';
    while (alive() && !signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() === '') continue;
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        replayFrom += 1;
        let data: ChatStreamEvent & { done?: boolean; type?: string };
        try {
          data = JSON.parse(jsonStr) as ChatStreamEvent & { done?: boolean; type?: string };
        } catch {
          continue;
        }
        if (data.type === 'v2_run' && typeof (data as { run_id?: string }).run_id === 'string') {
          const rid = (data as { run_id: string }).run_id;
          if (rid) v2RunId = rid;
        }
        if ('error' in data && data.error) {
          throw new Error(String(data.error));
        }
        onEvent(data as ChatStreamEvent);
        if ('done' in data && data.done === true) {
          streamCompleted = true;
          return;
        }
        if ('type' in data && data.type === 'cancelled') {
          streamCompleted = true;
          return;
        }
        if ('type' in data && data.type === 'tool_result_chunk') {
          await yieldToolResultChunkFrame();
        }
      }
    }
  };

  while (!streamCompleted && alive() && !signal?.aborted) {
    const isReconnect = reconnectAttempt > 0;
    let body: Record<string, unknown>;
    if (isReconnect) {
      body = { subscribe_only: true, run_id: v2RunId, replay_from: replayFrom };
    } else if (start.tag === 'new_message') {
      body = { message: start.message };
    } else if (start.tag === 'regenerate') {
      body = { regenerate: true, after_user_index: start.after_user_index };
    } else {
      body = { subscribe_only: true, run_id: v2RunId, replay_from: 0 };
    }

    const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/chat_v2`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify(body),
      signal,
      reactNative: { textStreaming: true },
    } as RequestInit);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = (err as { detail?: string }).detail || `请求失败: ${res.status}`;
      if (res.status === 409 && !isReconnect) {
        throw new Error('该对话已有进行中的回复，请等待结束或稍后重试');
      }
      if (isReconnect) {
        throw new Error(`流重连失败(${res.status}): ${detail}`);
      }
      throw new Error(detail);
    }

    const resAny = res as {
      body?: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } };
    };
    const reader = resAny.body?.getReader();
    if (!reader) throw new Error('响应无 body');

    await consumeReader(reader);

    if (streamCompleted || signal?.aborted || !alive()) return;
    if (!v2RunId) throw new Error('流中断且缺少 run_id，无法恢复');
    reconnectAttempt += 1;
    if (reconnectAttempt > CHAT_V2_RECONNECT_MAX) {
      throw new Error('流式连接中断，重连次数已达上限');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHAT_V2_RECONNECT_DELAY_MS);
    });
  }
}

/**
 * 取消当前会话回复：POST /api/conversations/:id/cancel
 */
export async function cancelConversation(
  session: Session,
  conversationId: string
): Promise<void> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/cancel`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `取消失败: ${res.status}`);
  }
}

/**
 * 提交安全确认：POST /api/conversations/:id/safety/decision
 */
export async function submitSafetyDecision(
  session: Session,
  conversationId: string,
  reviewId: string,
  decision: 'approve' | 'reject'
): Promise<void> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(
    `${base}api/conversations/${conversationId}/safety/decision`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ review_id: reviewId, decision }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `提交确认失败: ${res.status}`);
  }
}

/** GET /api/user/layout-preferences — 返回扁平偏好对象（与 Web 一致） */
export async function getLayoutPreferences(session: Session): Promise<Record<string, unknown>> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/user/layout-preferences`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `加载偏好失败: ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

/** POST /api/user/layout-preferences — 合并写入 */
export async function setLayoutPreferences(
  session: Session,
  prefs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/user/layout-preferences`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify(prefs),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `保存偏好失败: ${res.status}`);
  }
  const data = (await res.json()) as { preferences?: Record<string, unknown> };
  return data?.preferences && typeof data.preferences === 'object' ? data.preferences : {};
}

/** 默认助手人设路径，与主对话注入优先级一致（先于根路径 SOUL.md） */
export const DEFAULT_AGENT_SOUL_FILE = 'default/SOUL.md';

/** GET /api/agentf?file=...&meta=1 — 逻辑 agent 文件（阶段 0 为 SOUL） */
export type AgentfFilePayload = {
  content: string;
  file: string;
  max_chars: number;
};

function agentfQuery(file: string, meta: boolean): string {
  const q = new URLSearchParams({ file });
  if (meta) q.set('meta', '1');
  return q.toString();
}

export async function getAgentfFile(
  session: Session,
  file: string,
  options?: { meta?: boolean }
): Promise<AgentfFilePayload | string> {
  const base = session.server_base_url;
  const meta = options?.meta !== false;
  const url = `${base}api/agentf?${agentfQuery(file, meta)}`;
  const res = await fetchWithDebugLog(url, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `读取文件失败: ${res.status}`);
  }
  if (!meta) {
    return await res.text();
  }
  const data = (await res.json()) as { content?: string; file?: string; max_chars?: number };
  return {
    content: typeof data.content === 'string' ? data.content : '',
    file: typeof data.file === 'string' ? data.file : file,
    max_chars: typeof data.max_chars === 'number' ? data.max_chars : 32000,
  };
}

/** POST /api/agentf?file=... — body JSON { content } */
export async function putAgentfFile(session: Session, file: string, content: string): Promise<AgentfFilePayload> {
  const base = session.server_base_url;
  const q = agentfQuery(file, false);
  const res = await fetchWithDebugLog(`${base}api/agentf?${q}`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `保存文件失败: ${res.status}`);
  }
  const data = (await res.json()) as { content?: string; file?: string; max_chars?: number };
  return {
    content: typeof data.content === 'string' ? data.content : '',
    file: typeof data.file === 'string' ? data.file : file,
    max_chars: typeof data.max_chars === 'number' ? data.max_chars : 32000,
  };
}

export type UsageSummaryMonthly = {
  month?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  estimated_cost_usd?: number;
};

export type UsageSummaryDaily = {
  date?: string;
  has_data?: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  estimated_cost_usd?: number;
};

export type UsageSummaryResponse = {
  ok?: boolean;
  error?: string;
  monthly_totals?: UsageSummaryMonthly[];
  daily?: UsageSummaryDaily[];
};

/** GET /api/user/usage-summary */
export async function getUsageSummary(session: Session, days: number = 90): Promise<UsageSummaryResponse> {
  const base = session.server_base_url;
  const q = new URLSearchParams({ days: String(days) });
  const res = await fetchWithDebugLog(`${base}api/user/usage-summary?${q.toString()}`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `加载用量统计失败: ${res.status}`);
  }
  return (await res.json()) as UsageSummaryResponse;
}

export type ModelsConfigResponse = {
  selected_model?: string;
  selected_model_label?: string;
  /** label -> model id，与 Web/Desktop 一致 */
  available_models?: Record<string, string>;
  model_price_reference?: Record<string, unknown>;
  all_models?: Record<string, unknown>;
  allowlist_ids?: string[];
  default_model?: string;
};

/** GET /api/models/config */
export async function getModelsConfig(session: Session): Promise<ModelsConfigResponse> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/models/config`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `加载模型配置失败: ${res.status}`);
  }
  return (await res.json()) as ModelsConfigResponse;
}

/** POST /api/models/select — body `{ model }`，返回完整模型配置 payload */
export async function selectModel(session: Session, model: string): Promise<ModelsConfigResponse> {
  const base = session.server_base_url;
  const m = String(model || '').trim();
  const res = await fetchWithDebugLog(`${base}api/models/select`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: m }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `切换模型失败: ${res.status}`);
  }
  return (await res.json()) as ModelsConfigResponse;
}
