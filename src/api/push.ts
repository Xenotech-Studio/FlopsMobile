/**
 * Flops 服务端 APNs 推送 API（与 flops_push_apns.py 对齐）
 *
 * - registerApnsToken：登记本机 device token + env（sandbox/production）+ topic（bundle ID，dev/release 各异）
 * - listApnsTokens：列出本人已登记 token（调试展示）
 * - removeApnsToken：移除某条 token
 * - requestDebugApnsPush：让服务端给该用户所有 token 发一条调试推送
 */
import { fetchWithDebugLog } from '../utils/httpDebugLog';

function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function authHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  } as const;
}

export type ApnsEnv = 'sandbox' | 'production';

export type ApnsTokenRow = {
  token: string;
  token_short: string;
  env: ApnsEnv;
  ts?: number;
  device_name?: string;
  identifier_for_vendor?: string;
  ua?: string;
};

export type ApnsDebugResultRow = {
  token_short: string;
  env: ApnsEnv | null;
  ok: boolean;
  status: number;
  apns_id?: string | null;
  reason?: string | null;
  auto_removed?: boolean;
};

export async function registerApnsToken(
  baseUrl: string,
  accessToken: string,
  payload: {
    device_token: string;
    env: ApnsEnv;
    topic?: string;
    device_name?: string;
    identifier_for_vendor?: string;
    ua?: string;
  }
): Promise<{ ok: boolean; meta?: Record<string, unknown> }> {
  const res = await fetchWithDebugLog(buildUrl(baseUrl, '/api/push/apns/register'), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`register failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function listApnsTokens(
  baseUrl: string,
  accessToken: string
): Promise<{ tokens: ApnsTokenRow[] }> {
  const res = await fetchWithDebugLog(buildUrl(baseUrl, '/api/push/apns/tokens'), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json();
}

export async function removeApnsToken(
  baseUrl: string,
  accessToken: string,
  token: string
): Promise<{ ok: boolean; removed: number }> {
  const res = await fetchWithDebugLog(
    buildUrl(baseUrl, `/api/push/apns/tokens/${encodeURIComponent(token)}`),
    {
      method: 'DELETE',
      headers: authHeaders(accessToken),
    }
  );
  if (!res.ok) throw new Error(`remove failed: ${res.status}`);
  return res.json();
}

export async function requestDebugApnsPush(
  baseUrl: string,
  accessToken: string,
  body?: { title?: string; body?: string }
): Promise<{ ok: boolean; reason?: string; count?: number; results: ApnsDebugResultRow[] }> {
  const res = await fetchWithDebugLog(buildUrl(baseUrl, '/api/push/apns/debug'), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`debug push failed: ${res.status} ${text}`);
  }
  return res.json();
}

export type ApnsPresenceState = 'foreground' | 'background';

/** AppState 切换时上报；服务端依此判断要不要推（前台不打扰）。 */
export async function reportApnsPresence(
  baseUrl: string,
  accessToken: string,
  state: ApnsPresenceState,
): Promise<void> {
  await fetchWithDebugLog(buildUrl(baseUrl, '/api/push/apns/presence'), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ state }),
  }).catch(() => {
    // presence 上报失败不致命：超时后服务端 key 自动回落 unknown，最差就是会推一条不该推的
  });
}

export type ApnsPushPrefs = {
  need_confirm: boolean;
  turn_done: boolean;
  turn_failed: boolean;
};

export async function getApnsPrefs(
  baseUrl: string,
  accessToken: string,
): Promise<{ prefs: ApnsPushPrefs }> {
  const res = await fetchWithDebugLog(buildUrl(baseUrl, '/api/push/apns/prefs'), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`get prefs failed: ${res.status}`);
  return res.json();
}

export async function updateApnsPrefs(
  baseUrl: string,
  accessToken: string,
  prefs: Partial<ApnsPushPrefs>,
): Promise<{ prefs: ApnsPushPrefs }> {
  const res = await fetchWithDebugLog(buildUrl(baseUrl, '/api/push/apns/prefs'), {
    method: 'PUT',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ prefs }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`update prefs failed: ${res.status} ${text}`);
  }
  return res.json();
}
