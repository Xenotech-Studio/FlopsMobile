/**
 * Flops 服务端 API 客户端（仅 chat 相关）
 * 与 FlopsDesktop 行为对齐：登录、会话、流式聊天、取消、安全确认。
 */
import { fetchWithDebugLog } from './utils/httpDebugLog';

export type Session = {
  user_id: string;
  server_base_url: string;
  access_token: string;
};

export type ChatStreamEvent =
  | { type: 'thinking' }
  | { type: 'checking_tools' }
  | { type: 'tool_start'; tool_name: string; arguments?: string }
  | { type: 'tool_result'; tool_name: string; result: unknown }
  | { type: 'safety_confirmation_required'; tool_name: string; review_id: string; command?: string; cwd?: string; arguments?: string; review?: Record<string, unknown>; conversation_id?: string }
  | { type: 'safety_review'; tool_name: string; review: Record<string, unknown> }
  | { type: 'step_complete' }
  | { type: 'cancelled'; done?: boolean }
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
  const res = await fetchWithDebugLog(`${base}api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: userId,
      password,
      device_name: deviceName,
    }),
  });
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
 * 创建会话：POST /api/conversations
 */
export async function createConversation(session: Session): Promise<{ id: string }> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `创建会话失败: ${res.status}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error('服务端未返回会话 id');
  return { id: data.id };
}

/**
 * 流式聊天：POST /api/conversations/:id/chat，SSE 解析后按事件回调
 */
export async function streamChat(
  session: Session,
  conversationId: string,
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/chat`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ message }),
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
          } catch {
            // 忽略单帧解析错误
          }
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
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
