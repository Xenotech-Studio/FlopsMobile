/**
 * Flops 服务端 API 客户端（仅 chat 相关）
 * 与 FlopsDesktop 行为对齐：登录、会话、流式聊天、取消、安全确认。
 */
import { convProfileLog } from './debug/conversationLoadProfile';
import { fetchWithDebugLog } from './utils/httpDebugLog';
import type { VideoPreview } from './flowdoc-native-input/previewApi';
import {
  SrpClientSession,
  deriveSrpPassword,
  generateSaltHex,
  computeVerifier,
  encryptEnvelope,
  encryptEnvelopeBytes,
  deriveKDK,
  generateKUser,
  wrapKUser,
  unwrapKUser,
  bytesToBase64,
  base64ToBytes,
  deriveKConvFromBlob,
  decryptSubagentChildrenIntoCache,
  wrapKConvBlobForUser,
  wrapKConvForWire,
  decryptMessageLocal,
  decryptSseCiphertextToText,
  setCachedKConv,
  getCachedKConv,
  deriveKAgentFromBlob,
  wrapKAgentForWire,
  setCachedKAgent,
  getCachedKAgent,
} from './lib/srp';
import {
  setStoredKUser,
  getStoredKUser,
  clearStoredKUser,
} from './lib/kUserStorage';

// transport.pub 模块级缓存：first chat_v2 POST 时拉一次，后续 forever 用
let _transportPubkeyPem: string | null = null;

async function getTransportPubkeyMobile(serverBaseUrl: string): Promise<string> {
  if (_transportPubkeyPem) return _transportPubkeyPem;
  const base = ensureSlash(serverBaseUrl);
  const res = await fetchWithDebugLog(`${base}api/transport/pubkey`, { method: 'GET' });
  if (!res.ok) throw new Error(`transport pubkey ${res.status}`);
  const data = (await res.json()) as { pubkey_pem?: string };
  if (!data.pubkey_pem) throw new Error('transport pubkey_pem missing');
  _transportPubkeyPem = data.pubkey_pem;
  return _transportPubkeyPem;
}

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
  | { type: 'thinking_delta'; content?: string }
  | { type: 'checking_tools' }
  | { type: 'tool_call_start'; index: number; name: string }
  | { type: 'tool_call_delta'; index: number; arguments_delta: string }
  | { type: 'tool_call_ready'; index: number; name: string; arguments: string }
  | { type: 'tool_call_executing'; index: number }
  | { type: 'tool_call_done'; index: number; success?: boolean }
  | { type: 'tool_start'; tool_name: string; arguments?: string; index?: number }
  | { type: 'tool_stream'; tool_name: string; chunk: string }
  | { type: 'tool_result'; tool_name: string; result: unknown; index?: number; resumed?: boolean; tool_call_id?: string }
  | {
      type: 'tool_result_chunk';
      index: number;
      stdout_append?: string;
      set?: Record<string, unknown>;
      patches?: unknown;
      readings_by_url?: Record<string, unknown>;
      pages_by_url?: Record<string, unknown>;
    }
  | {
      type: 'safety_confirmation_required';
      tool_name: string;
      index?: number;
      review_id: string;
      command?: string;
      cwd?: string;
      arguments?: string;
      review?: Record<string, unknown>;
      conversation_id?: string;
      delete_pending?: {
        delete_target?: string;
        preflight_stats?: Record<string, unknown>;
        description?: string;
      };
    }
  | { type: 'safety_review'; tool_name: string; index?: number; review: Record<string, unknown> }
  | {
      type: 'tool_authorization_required';
      authorization_kind?: 'titles' | 'access';
      /** send=写授权（subagent_continue 向无钥加密对话发消息）/ read=读授权；仅切卡片文案 */
      authorization_action?: 'send' | 'read';
      tool_name?: string;
      index?: number;
      request_id?: string;
      requester_conversation_id?: string;
      count?: number;
      target_ids?: string[];
      target_conversation_id?: string;
      reason?: string;
    }
  | { type: 'step_complete' }
  | {
      type: 'history_revision';
      conversation_id?: string;
      seq?: number;
      reason?: string;
      action?: string;
    }
  | { type: 'cancelled'; done?: boolean }
  | {
      type: 'usage';
      usage_stats?: UsageStats;
      usage_run?: UsageRun;
      conversation_id?: string;
    }
  /** 协同工作模式布局帧（CoWriter / CoPlanner 等）。
   *  注：两种 mode 的 delta 在线上**都**是 `type: 'cowriter_layout'`（服务端 ProductEvent 的
   *  kind 叫 coplanner_layout，但 SSE 上的 JSON 用 payload 自带的 type）；具体是哪个 mode
   *  看 `layout.layout_mode`。这里把 coplanner_layout 也列上纯属兼容，不依赖它出现。 */
  | {
      type: 'cowriter_layout' | 'coplanner_layout';
      conversation_id?: string;
      seq?: number;
      layout?: Record<string, unknown>;
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
 * 登录：SRP-6a 两步握手 + 互验证（POST /api/srp/login/{challenge,proof}）。
 * 明文密码不出本进程；与 backend/user_system/srp_apis.py + FlopsWeb 的 SDK 字节级互通。
 */
export async function login(
  serverBaseUrl: string,
  userId: string,
  password: string,
  deviceName: string = 'FlopsMobile'
): Promise<{ session: Session }> {
  const base = ensureSlash(serverBaseUrl);

  // 1) challenge: 服务端拿 verifier 算 B，回 salt + B + session_id
  const r1 = await fetchWithDebugLog(
    `${base}api/srp/login/challenge`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: userId }),
    },
    { log4xxAsInfo: true }
  );
  if (!r1.ok) {
    const err = await r1.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `登录失败: ${r1.status}`);
  }
  const ch = (await r1.json()) as { session_id: string; salt: string; B: string };

  // 2) 客户端 argon2 预哈希 + SRP 计算 A、M1
  const srpPw = await deriveSrpPassword(password, ch.salt);
  const sess = new SrpClientSession(userId, srpPw);
  const { A_hex, M1_hex } = sess.computeProof(ch.salt, ch.B);

  // 3) proof
  const r2 = await fetchWithDebugLog(
    `${base}api/srp/login/proof`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: ch.session_id,
        A: A_hex,
        M1: M1_hex,
        device_name: deviceName,
      }),
    },
    { log4xxAsInfo: true }
  );
  if (!r2.ok) {
    const err = await r2.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `登录失败: ${r2.status}`);
  }
  const data = (await r2.json()) as {
    user?: { id?: string };
    access_token?: string;
    M2?: string;
    k_user_blob?: string | null;
  };

  // 4) mutual auth：验证服务端的 M2，防 fake-server 中间人
  if (!data.M2 || !sess.verifyServerProof(data.M2)) {
    throw new Error('服务端身份校验失败');
  }

  const token = data.access_token;
  const uid = (data.user && data.user.id) || userId;
  if (!token) throw new Error('服务端未返回 access_token');

  // 5) K_user 生命周期（Phase 1）：跟 Web SDK 同一套行为
  //    任何 K_user 异常都不影响登录主流程；失败时清掉本机残留避免脏数据
  try {
    const kdk = deriveKDK(srpPw, ch.salt, userId);
    if (data.k_user_blob) {
      const kUser = unwrapKUser(data.k_user_blob, kdk);
      await setStoredKUser(bytesToBase64(kUser));
    } else {
      const kUser = generateKUser();
      const blob = wrapKUser(kUser, kdk);
      // Tier 3 recovery envelope（steven.pub 包 K_user）：同上传一并捎给 server
      let envelopeForUpload: string | null = null;
      try {
        const pkRes = await fetchWithDebugLog(`${base}api/srp/pubkey`, { method: 'GET' });
        if (pkRes.ok) {
          const { pubkey_pem } = (await pkRes.json()) as { pubkey_pem?: string };
          if (pubkey_pem) {
            const { encryptEnvelopeBytes } = await import('./lib/srp');
            envelopeForUpload = encryptEnvelopeBytes(kUser, pubkey_pem);
          }
        }
      } catch (e) {
        console.warn('K_user envelope generation skipped:', (e as Error)?.message || e);
      }
      const up = await fetchWithDebugLog(
        `${base}api/srp/upload_k_user`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(
            envelopeForUpload
              ? { k_user_blob: blob, k_user_envelope: envelopeForUpload }
              : { k_user_blob: blob }
          ),
        },
        { log4xxAsInfo: true }
      );
      if (up.ok) {
        await setStoredKUser(bytesToBase64(kUser));
      } else if (up.status !== 409) {
        console.warn('upload_k_user failed:', up.status);
      }
    }
  } catch (e) {
    console.warn('K_user materialization skipped:', (e as Error)?.message || e);
    await clearStoredKUser();
  }

  return {
    session: {
      user_id: uid,
      server_base_url: base,
      access_token: token,
    },
  };
}

/**
 * 修改密码：SRP-6a 走 /api/srp/change_password
 *   - 用旧密码先做一次 challenge + M1 证明持有
 *   - 新密码本地算 verifier + envelope，把三件套发上去
 * 需要 Bearer token；服务端验证 old-pwd proof 后才换 SRP credentials。
 */
export async function changePassword(
  serverBaseUrl: string,
  accessToken: string,
  userId: string,
  oldPassword: string,
  newPassword: string
): Promise<{ message: string }> {
  const base = ensureSlash(serverBaseUrl);

  // 1) 用旧密码完成一次 SRP 挑战 / 证明，准备 old_session_id / old_A / old_M1
  const r1 = await fetchWithDebugLog(
    `${base}api/srp/login/challenge`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: userId }),
    },
    { log4xxAsInfo: true }
  );
  if (!r1.ok) {
    const err = await r1.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `修改密码失败: ${r1.status}`);
  }
  const ch = (await r1.json()) as { session_id: string; salt: string; B: string };
  const oldSrpPw = await deriveSrpPassword(oldPassword, ch.salt);
  const oldSess = new SrpClientSession(userId, oldSrpPw);
  const { A_hex: oldA, M1_hex: oldM1 } = oldSess.computeProof(ch.salt, ch.B);

  // 2) 拉公钥 + 新密码算 SRP 三件套
  const pkRes = await fetchWithDebugLog(`${base}api/srp/pubkey`, { method: 'GET' });
  if (!pkRes.ok) throw new Error(`无法获取 recovery 公钥: ${pkRes.status}`);
  const { pubkey_pem } = (await pkRes.json()) as { pubkey_pem: string };

  const newSalt = generateSaltHex();
  const newSrpPw = await deriveSrpPassword(newPassword, newSalt);
  const newVerifier = computeVerifier(userId, newSrpPw, newSalt);
  const newEnvelope = encryptEnvelope(newPassword, pubkey_pem);

  // K_user 重封：本机有就复用；没有就新建一把（顺手把 K_user 体系 materialize）
  let kUserBytes: Uint8Array;
  const stored = await getStoredKUser();
  if (stored) {
    try {
      const b = base64ToBytes(stored);
      if (b.length !== 32) throw new Error('stored K_user wrong length');
      kUserBytes = b;
    } catch {
      kUserBytes = generateKUser();
    }
  } else {
    kUserBytes = generateKUser();
  }
  const newKdk = deriveKDK(newSrpPw, newSalt, userId);
  const rewrappedKUserBlob = wrapKUser(kUserBytes, newKdk);

  // 3) POST /api/srp/change_password
  const res = await fetchWithDebugLog(
    `${base}api/srp/change_password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        old_session_id: ch.session_id,
        old_A: oldA,
        old_M1: oldM1,
        salt: newSalt,
        verifier: newVerifier,
        envelope: newEnvelope,
        k_user_blob: rewrappedKUserBlob,
      }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `修改密码失败: ${res.status}`);
  }
  const data = (await res.json()) as { message?: string };
  // 改密成功才落本机 K_user（即便之前没有，现在也算正式确立）
  await setStoredKUser(bytesToBase64(kUserBytes));
  return { message: data.message ?? 'Password changed successfully' };
}

/** 当前用户信息（含头像、昵称、邮箱、手机号），来自 GET /api/user/{user_id} */
export type CurrentUserInfo = {
  id?: string;
  nickname?: string;
  avatarUrl?: string;
  email?: string;
  /** E.164，如 +8613800138000；未绑定则无此字段 */
  phone?: string;
  [key: string]: unknown;
};

/** /api/auth/config 返回：captcha / 短信通道 是否启用 */
export type AuthConfig = {
  captcha_enabled: boolean;
  captcha_app_id?: string | null;
  /** 服务端短信通道可用（同时要求已配置 captcha）。false 时手机号绑定入口不展示。 */
  sms_enabled: boolean;
};

/** GET /api/auth/config —— 前端启动 / 进入注册页时拉一次 */
export async function getAuthConfig(serverBaseUrl: string): Promise<AuthConfig> {
  const base = ensureSlash(serverBaseUrl);
  const res = await fetchWithDebugLog(`${base}api/auth/config`, { method: 'GET' });
  if (!res.ok) return { captcha_enabled: false, sms_enabled: false };
  const data = (await res.json()) as Partial<AuthConfig>;
  return {
    captcha_enabled: Boolean(data.captcha_enabled),
    captcha_app_id: data.captcha_app_id ?? null,
    sms_enabled: Boolean(data.sms_enabled),
  };
}

/**
 * 带 HTTP 状态码的 API 错误。
 * 短信相关端点的 detail 后端已保证是可直接展示的中文（含频控文案与业务错误码），
 * 但界面还要按 429 / 502 / 其它分场景兜底，所以把 status 一并带出来。
 */
export class ApiHttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string, fallback: string) {
    super(detail || fallback);
    this.name = 'ApiHttpError';
    this.status = status;
    this.detail = detail;
  }
}

async function throwHttpError(res: Response, fallback: string): Promise<never> {
  const err = (await res.json().catch(() => ({}))) as { detail?: string };
  throw new ApiHttpError(res.status, (err.detail || '').trim(), `${fallback}: ${res.status}`);
}

/**
 * POST /api/auth/send_sms_code —— 手机号绑定发码。
 * 与邮箱侧的差异：**必须带登录态**，且服务端强制 captcha（未带 captcha 凭据会 400）。
 * phone 需为 E.164（+8613800138000）。
 */
export async function sendSmsCode(
  session: Session,
  phone: string,
  captcha?: CaptchaCreds
): Promise<{ cooldown: number; code_ttl: number }> {
  const base = ensureSlash(session.server_base_url);
  const res = await fetchWithDebugLog(
    `${base}api/auth/send_sms_code`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        phone,
        captcha_ticket: captcha?.ticket ?? '',
        captcha_randstr: captcha?.randstr ?? '',
      }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) await throwHttpError(res, '发送验证码失败');
  const data = (await res.json()) as { cooldown?: number; code_ttl?: number };
  return { cooldown: data.cooldown ?? 30, code_ttl: data.code_ttl ?? 300 };
}

/** POST /api/auth/verify_sms_code —— 验码换一次性 token（需登录态） */
export async function verifySmsCode(
  session: Session,
  phone: string,
  code: string
): Promise<{ verify_token: string; token_ttl: number }> {
  const base = ensureSlash(session.server_base_url);
  const res = await fetchWithDebugLog(
    `${base}api/auth/verify_sms_code`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ phone, code }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) await throwHttpError(res, '验证码校验失败');
  const data = (await res.json()) as { verify_token?: string; token_ttl?: number };
  if (!data.verify_token) throw new Error('服务端未返回 verify_token');
  return { verify_token: data.verify_token, token_ttl: data.token_ttl ?? 600 };
}

/** POST /api/auth/bind_phone —— 补绑 / 改绑手机号（需登录态） */
export async function bindPhone(
  session: Session,
  phone: string,
  verifyToken: string
): Promise<{ phone: string; previous_phone?: string | null }> {
  const base = ensureSlash(session.server_base_url);
  const res = await fetchWithDebugLog(
    `${base}api/auth/bind_phone`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ phone, verify_token: verifyToken }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) await throwHttpError(res, '绑定手机号失败');
  const data = (await res.json()) as { phone?: string; previous_phone?: string | null };
  return { phone: data.phone ?? phone, previous_phone: data.previous_phone ?? null };
}

/** 人机验证凭据。captcha 未启用时两个字段都是空串，服务端也不会校验。 */
export type CaptchaCreds = { ticket: string; randstr: string };

/** 移动端 WebView 用的验证码承载页 URL（后端以真实 https 源提供，见 auth_verify/captcha_page.py） */
export function captchaPageUrl(serverBaseUrl: string): string {
  return `${ensureSlash(serverBaseUrl)}api/auth/captcha.html`;
}

/** POST /api/auth/send_email_code */
export async function sendEmailCode(
  serverBaseUrl: string,
  email: string,
  accessToken?: string,
  captcha?: CaptchaCreds
): Promise<{ cooldown: number; code_ttl: number }> {
  const base = ensureSlash(serverBaseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchWithDebugLog(
    `${base}api/auth/send_email_code`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        captcha_ticket: captcha?.ticket ?? '',
        captcha_randstr: captcha?.randstr ?? '',
      }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `发送验证码失败: ${res.status}`);
  }
  const data = (await res.json()) as { cooldown?: number; code_ttl?: number };
  return { cooldown: data.cooldown ?? 60, code_ttl: data.code_ttl ?? 600 };
}

/** POST /api/auth/verify_email_code */
export async function verifyEmailCode(
  serverBaseUrl: string,
  email: string,
  code: string
): Promise<{ verify_token: string; token_ttl: number }> {
  const base = ensureSlash(serverBaseUrl);
  const res = await fetchWithDebugLog(
    `${base}api/auth/verify_email_code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `验证码校验失败: ${res.status}`);
  }
  const data = (await res.json()) as { verify_token?: string; token_ttl?: number };
  if (!data.verify_token) throw new Error('服务端未返回 verify_token');
  return { verify_token: data.verify_token, token_ttl: data.token_ttl ?? 1800 };
}

/**
 * POST /api/auth/register —— 注册新账号；email + verify_token 已通过验证码流程拿到。
 * 客户端就把明文密码 → SRP 三件套，服务端不接触明文。
 */
export async function registerUser(
  serverBaseUrl: string,
  params: { user_id: string; password: string; email: string; verify_token: string }
): Promise<void> {
  const base = ensureSlash(serverBaseUrl);

  // 1) 拉公钥
  const pkRes = await fetchWithDebugLog(`${base}api/srp/pubkey`, { method: 'GET' });
  if (!pkRes.ok) throw new Error(`无法获取 recovery 公钥: ${pkRes.status}`);
  const { pubkey_pem } = (await pkRes.json()) as { pubkey_pem: string };

  // 2) 本地算 SRP 三件套 + K_user 三件套
  const salt = generateSaltHex();
  const srpPw = await deriveSrpPassword(params.password, salt);
  const verifier = computeVerifier(params.user_id, srpPw, salt);
  const envelope = encryptEnvelope(params.password, pubkey_pem);
  const kUser = generateKUser();
  const kdk = deriveKDK(srpPw, salt, params.user_id);
  const k_user_blob = wrapKUser(kUser, kdk);
  // Tier 3 recovery envelope（同 K_user，steven.pub 包）
  const k_user_envelope = encryptEnvelopeBytes(kUser, pubkey_pem);

  // 3) POST 注册 —— 后端的 /api/auth/register 已支持 SRP + K_user 字段（additive）
  const res = await fetchWithDebugLog(
    `${base}api/auth/register`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: params.user_id,
        srp_salt: salt,
        srp_verifier: verifier,
        password_envelope: envelope,
        k_user_blob,
        k_user_envelope,
        email: params.email,
        verify_token: params.verify_token,
      }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `注册失败: ${res.status}`);
  }
  // 注册后顺手把 K_user 落本机 —— 注册完通常会立刻 login，login 里也有
  // K_user materialize 兜底，但提前落避免短暂"没锁"的视觉空窗
  await setStoredKUser(bytesToBase64(kUser));
}

/** POST /api/auth/bind_email —— 老用户补绑 / 改绑邮箱（需 Bearer token） */
export async function bindEmail(
  session: Session,
  email: string,
  verifyToken: string
): Promise<{ email: string; previous_email?: string | null }> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(
    `${base}api/auth/bind_email`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ email, verify_token: verifyToken }),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `绑定邮箱失败: ${res.status}`);
  }
  const data = (await res.json()) as { email?: string; previous_email?: string | null };
  return { email: data.email ?? email, previous_email: data.previous_email ?? null };
}

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
  /** 关联的 Flowtask 项目 ID；null / 缺省 = 未挂到任何项目（"近期对话"段） */
  flowtask_project_id?: string | null;
  /** 关联的 Flowtask 项目内 folder ID；null / 缺省 = 项目直属，不在子文件夹里 */
  flowtask_folder_id?: string | null;
  /**
   * S9 加密子对话解不开时的原因。'need_parent' = K_conv 存在**父对话 meta 的加密字段**里，
   * 本次会话还没打开过那个父对话（服务端也解不开，这是零知识设计的必然结果）。
   * 置位时 title 已被换成可读占位，不再是服务端落库的 [encrypted title] 哨兵。
   */
  locked_reason?: 'need_parent' | null;
};

export type ConversationMessage = {
  role: string;
  content?: string;
  /** 技能注入等：仅进模型上下文，不展示为用户气泡（与服务端 isMeta 一致） */
  isMeta?: boolean;
  metadata?: Record<string, unknown>;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
};

export type AgentProfile = {
  agent_id?: string;
  display_name?: string;
  call_name?: string;
  /** server 标记此 agent 为 encrypted（agent record 字段、K_agent 体系存在）。 */
  encrypted?: boolean;
  /** AES-GCM(K_agent, K_user) base64；client 用 K_user 解出 K_agent 缓存。
   *  encrypted=true 时一定带；chat_v2 发送时 client 把 K_agent 包成
   *  k_agent_wire 附在 body 里。 */
  k_agent_blob?: string | null;
};

/** 服务端上下文摘要（与 Web/Desktop flops-chat-ui 一致） */
export type ContextSummary = {
  id?: string;
  summary_text?: string;
  covers_exclusive_end?: number;
  created_at?: string;
};

/** 会话消息窗口元数据（尾窗拉取时服务端返回 messages_window；对齐 web）。
 *  - total: 整个会话的消息总数
 *  - viewStart: 当前窗口首条在全量里的下标（= server returned_start）
 *  - hasOlder: viewStart 之前是否还有更旧消息
 *  - userCountBefore: raw[0..viewStart-1] 里非 isMeta 的 user 条数（把窗口内局部 user 序号还原成全局序号用） */
export type MessageWindow = {
  total: number;
  viewStart: number;
  hasOlder: boolean;
  userCountBefore: number;
};

/** 会话级附件（对齐 web conversation.attachments）：助手/任务产出的文件，assistant markdown
 *  里以指向该 url 的链接引用；渲染时把「仅由此类链接组成的段落」抬成文件卡片。 */
export type ConversationAttachment = {
  url: string;
  filename: string;
  mime_type?: string;
  /** 服务端字节大小；用于附件 chip / 预览弹窗展示（对齐 web attachment.size_bytes）。 */
  size_bytes?: number;
  /** 附件来源：user（用户上传）/ agent（助手或任务产出）。 */
  source?: string;
};

export type Conversation = {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  messages?: ConversationMessage[];
  /** 会话级附件列表（助手/任务产出文件）；见 ConversationAttachment。 */
  attachments?: ConversationAttachment[];
  /** 服务端仍有进行中的 chat_v2 run 时存在，用于 subscribe_only 恢复 */
  active_chat_v2_run_id?: string;
  usage_stats?: UsageStats;
  usage_runs?: UsageRun[];
  bound_agent_id?: string;
  agent_profile?: AgentProfile;
  /** 对话级所选模型（后端 conv meta 的 model 字段，创建时以用户默认为种子）。
   *  服务端跑这个对话时优先用它，所以 composer 的模型标签也该按它显示。 */
  model?: string;
  /** 当前生效的上下文摘要 id（若有则可能存在压缩分界展示） */
  active_context_summary_id?: string;
  context_summaries?: ContextSummary[];
  /** 上下文 L1 投影：主 system / 摘要注入 / 逐字尾 / 工具 schema 各自的 L1 字符数 + 上限。
   *  用于 composer 旁环形进度条算"上下文已用比例"。后端按需返回，缺省时退化用"消息条数已压缩"。 */
  context_projection_l1?: Record<string, unknown>;
  /**
   * S9 加密子对话解不开时的原因。'need_parent' = K_conv 存在**父对话 meta 的加密字段**里，
   * 而那个父对话已被删除 / 不在当前账号下（正常情况 getConversation 会自动去捞，捞到就没这个字段）。
   * 置位时 messages 仍是密文哨兵形态，UI 该说清楚原因而不是假装内容为空。
   */
  locked_reason?: 'need_parent' | null;
  /** 协同工作模式（CoWriter/CoPlanner/CoCoder/CoBrowser）布局桶 + 其单调 seq。
   *  结构与归一化见 utils/collabLayout；服务端权威在会话根 meta 的同名字段。 */
  cowriter_layout?: Record<string, unknown> | null;
  cowriter_layout_seq?: number;
};

/** 会话列表页大小（服务端分页）：首屏 + 每次滚到底加载的条数。
 *  今日页一屏只画 10 行，取 20 让「首屏 + 一次上滑」都不用等网络；再大就是白拉。 */
export const CONV_LIST_PAGE_SIZE = 20;

/** 一页会话列表 + 服务端分页元信息。 */
export type ConversationListPage = {
  conversations: ConversationListItem[];
  /** 服务端在本页之后还有更多（不传 limit 的全量请求恒 false） */
  hasMore: boolean;
  /** 该用户会话总数（服务端分页时由 COUNT 给出；全量请求 = 本次条数） */
  total: number;
};

/** 列表里每条 encrypted conv 都带 (title_ciphertext, k_conv_blob)，用 K_user 派 K_conv
 *  后本地解出 title **原地写回**。对齐 FlopsWeb `utils/convTitleDecrypt.js` 的语义。
 *  K_user 缺失或单条解失败都保留原 title sentinel，不抛错。 */
async function decryptConvListTitles(list: ConversationListItem[]): Promise<void> {
  try {
    const kUserStr = await getStoredKUser();
    if (!kUserStr) return;
    const kUserBytes = base64ToBytes(kUserStr);
    const { aesGcmDecrypt } = await import('./lib/srp');
    for (const c of list) {
      const raw = c as ConversationListItem & {
        encrypted?: boolean;
        title_ciphertext?: string;
        k_conv_blob?: string;
      };
      if (!raw.encrypted || !raw.title_ciphertext) continue;
      try {
        let kConv = getCachedKConv(raw.id);
        if (!kConv && raw.k_conv_blob) {
          kConv = deriveKConvFromBlob(raw.k_conv_blob, kUserBytes);
          setCachedKConv(raw.id, kConv);
        }
        if (!kConv) {
          // S9 加密子对话（列表端点不带 k_conv_source，只能靠「加密 + 有 title 密文 +
          // 没有 k_conv_blob」这个形态判定 —— 普通加密对话一定带 blob，不会误判）。
          // 钥匙在发起它的那个对话手里，没打开过就解不开。给个能看懂的占位，
          // 别把服务端哨兵 [encrypted title] 直接摆给用户。
          if (!raw.k_conv_blob) {
            raw.locked_reason = 'need_parent';
            raw.title = '子对话 · 待解锁';
          }
          continue;
        }
        const blob = base64ToBytes(raw.title_ciphertext);
        const pt = aesGcmDecrypt(blob, kConv);
        const decoded = new TextDecoder().decode(pt);
        // server 把 title 当 JSON 字符串存进密文：`"foo"`，所以这里要 parse 一层
        raw.title = JSON.parse(decoded);
        raw.locked_reason = null;  // 父对话刚被打开、本轮重解走的就是这条
      } catch {
        // 单条解失败保留原 sentinel
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[conv list mobile] title decrypt batch failed:', (e as Error)?.message || e);
  }
}

/**
 * 获取对话列表：GET /api/conversations?limit=&offset=[&flowtask_project_id=]。
 *
 * 服务端按 `updated_at DESC` 排完序再切窗，所以翻页稳定。传 limit 时服务端回
 * `{conversations, has_more, total}` 信封；不传则回旧的裸数组（本函数两种都吃）。
 * 手机端一律传 limit —— 全量是 900+ 条 / 1.4MB，今日页只画 10 行。
 *
 * 注：offset 分页的固有语义 —— 翻页途中有会话被更新而上浮时，可能跨页重复/漏一条。
 * 重复由调用方按 id 去重（见 ConversationContext.loadMore）。
 */
/**
 * 本次进程里已经尝试过 mint 的子对话 id。会话列表会被反复拉（下拉刷新、分页、
 * sidebar_refresh 广播、回前台 catchup…），没有这个集合就会对同一批子对话反复打请求。
 * 失败的会移除允许重试；成功的留着 —— 下一轮列表里它已带自己的 k_conv_blob，不会再被判为 pre-mint。
 */
const _autoMintAttempted = new Set<string>();

/**
 * 列表驱动自动 mint：把列表里所有 pre-mint 的加密子对话就地升级成 direct。
 *
 * eager-mint 靠 SSE subagent_child_spawned 触发，手机不在线（或那条事件丢了）时 spawn 出来的
 * 子对话就一直停在 pre-mint —— 列表里显示「子对话 · 待解锁」，得等用户点进去才自愈。
 * 这里每次拉完列表顺手扫一遍，用户既不用翻列表也不用打开子对话。
 *
 * 父对话是普通加密对话、自带 K_user 包的 k_conv_blob，所以本机有 K_user 就能现场派出父 K_conv
 * —— 不需要用户「打开过」父对话。真拿不到（父被删）就跳过，保持锁定态。
 *
 * 返回真正 mint 成功的条数；调用方 >0 时应重拉一次列表把标题换上来。
 */
export async function autoMintPreMintChildren(
  session: Session,
  list: ConversationListItem[]
): Promise<number> {
  const pending = list
    .filter((c) => (c as { locked_reason?: string }).locked_reason === 'need_parent')
    .map((c) => String(c.id || '').trim())
    .filter((id) => id && !_autoMintAttempted.has(id));
  if (pending.length === 0) return 0;
  let minted = 0;
  let cursor = 0;
  // 并发封顶 3：一次列表里可能有十几条待 mint，串行太慢、全并发在移动网络上又太冲
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const id = pending[cursor];
      cursor += 1;
      _autoMintAttempted.add(id);
      const ok = await mintChildKConvDirect(session, id);
      if (ok) minted += 1;
      else _autoMintAttempted.delete(id); // 失败 → 下一轮列表允许重试
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
  return minted;
}

export async function listConversations(
  session: Session,
  opts: { limit?: number; offset?: number; flowtaskProjectId?: string } = {}
): Promise<ConversationListPage> {
  const base = session.server_base_url;
  const qs = new URLSearchParams();
  if (typeof opts.limit === 'number') {
    qs.set('limit', String(opts.limit));
    qs.set('offset', String(opts.offset ?? 0));
  }
  if (opts.flowtaskProjectId) qs.set('flowtask_project_id', opts.flowtaskProjectId);
  const q = qs.toString();
  const res = await fetchWithDebugLog(`${base}api/conversations${q ? `?${q}` : ''}`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `获取对话列表失败: ${res.status}`);
  }
  const data = (await res.json()) as
    | ConversationListItem[]
    | { conversations?: ConversationListItem[]; has_more?: boolean; total?: number };
  const envelope = Array.isArray(data) ? null : data;
  const list = Array.isArray(data) ? data : envelope?.conversations ?? [];

  await decryptConvListTitles(list);

  return {
    conversations: list,
    hasMore: Boolean(envelope?.has_more),
    total: typeof envelope?.total === 'number' ? envelope.total : list.length,
  };
}

/** Flops 后端给项目维护的子文件夹（跟 Flowtask 项目挂钩的那种）。 */
export type FlowtaskFolder = {
  id: string;
  project_id: string;
  parent_id?: string | null;
  name: string;
  sort_key?: number | null;
  created_at?: string;
  updated_at?: string;
  conversation_count?: number;
};

/**
 * 原子设置会话的「项目 + 文件夹」归属：POST /api/conversations/{cid}/placement
 * 省略字段 = 保持不变；显式 null/'' = 移出。
 */
export async function placeConversation(
  session: Session,
  conversationId: string,
  opts: { flowtask_project_id?: string | null; flowtask_folder_id?: string | null }
): Promise<void> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(
    `${base}api/conversations/${encodeURIComponent(conversationId)}/placement`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify(opts),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `归属设置失败: ${res.status}`);
  }
}

/**
 * 列项目内的 folder：GET /api/flowtask/projects/{project_id}/folders
 * 返回顺序就是后端给的顺序（已按 sort_key）。
 */
export async function listFlowtaskFolders(
  session: Session,
  projectId: string
): Promise<{ folders: FlowtaskFolder[] }> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(
    `${base}api/flowtask/projects/${encodeURIComponent(projectId)}/folders`,
    {
      method: 'GET',
      headers: authHeaders(session.access_token),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `获取项目文件夹失败: ${res.status}`);
  }
  const data = (await res.json()) as { folders?: FlowtaskFolder[] };
  return { folders: Array.isArray(data?.folders) ? data.folders : [] };
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
/** 首屏只拉尾部消息。web 用 400，但手机上 400 条带大工具结果的消息响应可达数 MB，JSON.parse +
 *  解密 + 渲染都很慢（实测 504 条会话拉 400 → 解析+解密 4.3s、渲染 2.8s）。手机用更小的首窗，
 *  滚到顶再分页补（CHAT_MESSAGES_LOAD_OLDER）。调这个数即可平衡"打开速度 vs 初始可见条数"。 */
export const CHAT_MESSAGES_INITIAL_LIMIT = 40;
/** 上滚加载更旧每批条数（GET .../messages/before 的 limit）。与首窗一致，每批都 40。 */
export const CHAT_MESSAGES_LOAD_OLDER = 40;

/** 从 API 响应里解析 messages_window 元数据；无（老 server / 全量返回）时返回 null。 */
function parseMessageWindow(data: unknown): MessageWindow | null {
  const mw = (data as { messages_window?: Record<string, unknown> } | null)?.messages_window;
  if (mw && typeof mw.total === 'number') {
    return {
      total: mw.total,
      viewStart: typeof mw.returned_start === 'number' ? mw.returned_start : 0,
      hasOlder: !!mw.has_older,
      userCountBefore: typeof mw.user_count_before === 'number' ? mw.user_count_before : 0,
    };
  }
  return null;
}

/**
 * S9 加密子对话：K_conv 存在**父对话 meta 的加密字段** subagent_children 里（受父 K_conv
 * 保护，服务器解不开）。用户可能从推送直接点进子对话，此时父对话本次会话压根没打开过 ——
 * 缓存里没有这把钥匙。这里去把父对话的 meta 捞回来，本地解出全部子 key 入缓存，返回本条那把。
 *
 * 走 /conversations/{parent}/meta 轻量端点：只要 k_conv_blob +
 * subagent_children_ciphertext 两个字段，没必要为一把钥匙把父对话上百条消息拉下来再逐条解密
 * （手机上那是几 MB 的响应，实测 400 条要 4.3s）。
 *
 * 捞不到（父对话被删 / 不在当前账号下 / 无 K_user）返回 null —— 调用方保持密文形态，
 * UI 显示锁定态，不装作解开了。
 */
async function resolveChildKConvViaParent(
  session: Session,
  conv: { id?: string; k_conv_source?: string; k_conv_parent?: string }
): Promise<Uint8Array | null> {
  if (conv?.k_conv_source !== 'parent_meta') return null;
  const parentId = String(conv?.k_conv_parent || '').trim();
  const childId = String(conv?.id || '').trim();
  if (!parentId || !childId) return null;
  try {
    const kUserStr = await getStoredKUser();
    if (!kUserStr) return null;
    const kUserBytes = base64ToBytes(kUserStr);
    const res = await fetchWithDebugLog(
      `${session.server_base_url}api/conversations/${encodeURIComponent(parentId)}/meta`,
      { method: 'GET', headers: authHeaders(session.access_token) }
    );
    if (!res.ok) return null;
    const parentMeta = (await res.json()) as {
      id?: string;
      k_conv_blob?: string;
      subagent_children_ciphertext?: string;
    };
    let parentK = getCachedKConv(parentId);
    if (!parentK && parentMeta?.k_conv_blob) {
      parentK = deriveKConvFromBlob(parentMeta.k_conv_blob, kUserBytes);
      setCachedKConv(parentId, parentK);
    }
    if (!parentK) return null;
    decryptSubagentChildrenIntoCache(parentMeta, parentK);
    return getCachedKConv(childId);
  } catch (e) {
    console.warn('[encrypted child mobile] 经父对话取 K_conv 失败:', (e as Error)?.message || e);
    return null;
  }
}

/**
 * 解出**任意一条自有加密对话**的 K_conv。三条路依次试：
 *   1. 模块级缓存（打开过就有）
 *   2. 自己的 k_conv_blob（普通加密对话 / 已 mint 成 direct 的子对话）
 *   3. 父镜像绕行（尚未 mint 的加密子对话：钥匙在父对话 meta 的 subagent_children 里）
 *
 * 三条都不通返回 null —— 调用方据此判「拿不到钥匙」，不要假装拿到了。
 * 与 flops-chat-ui/crypto/access.js 的 resolveKConvForConversation 同构。
 */
async function resolveKConvForConversation(
  session: Session,
  conversationId: string
): Promise<Uint8Array | null> {
  const cid = String(conversationId || '').trim();
  if (!cid) return null;
  const cached = getCachedKConv(cid);
  if (cached) return cached;
  const kUserStr = await getStoredKUser();
  if (!kUserStr) return null;
  const kUserBytes = base64ToBytes(kUserStr);
  const meta = await fetchConversationMeta(session, cid);
  if (!meta) return null;
  if (meta.k_conv_blob) {
    try {
      const k = deriveKConvFromBlob(meta.k_conv_blob, kUserBytes);
      setCachedKConv(cid, k);
      return k;
    } catch {
      return null;
    }
  }
  // 没有自己的 blob → 未 mint 的加密子对话，钥匙在父对话 meta 里
  const parentId = String(meta.k_conv_parent || '').trim();
  if (!parentId) return null;
  const parentMeta = await fetchConversationMeta(session, parentId);
  if (!parentMeta) return null;
  let parentK = getCachedKConv(parentId);
  if (!parentK && parentMeta.k_conv_blob) {
    try {
      parentK = deriveKConvFromBlob(parentMeta.k_conv_blob, kUserBytes);
      setCachedKConv(parentId, parentK);
    } catch {
      return null;
    }
  }
  if (!parentK) return null;
  decryptSubagentChildrenIntoCache(parentMeta, parentK);
  return getCachedKConv(cid);
}

/** 顶层 meta（/meta 轻量端点，不带 messages）。授权与 mint 只要里面那几个加密字段。 */
async function fetchConversationMeta(
  session: Session,
  conversationId: string
): Promise<ConversationCryptoMeta | null> {
  try {
    const res = await fetchWithDebugLog(
      `${session.server_base_url}api/conversations/${encodeURIComponent(conversationId)}/meta`,
      { method: 'GET', headers: authHeaders(session.access_token) }
    );
    if (!res.ok) return null;
    return (await res.json()) as ConversationCryptoMeta;
  } catch {
    return null;
  }
}

/** 解密相关只关心 meta 里这几个字段。 */
type ConversationCryptoMeta = {
  id?: string;
  encrypted?: boolean;
  k_conv_blob?: string;
  k_conv_parent?: string;
  subagent_children_ciphertext?: string;
  title_ciphertext?: string;
};

/**
 * 档 B 授权解密桥（WP3）：用户对「agent 想读对话 D」的决策回传。
 *
 * approve 必须带 D 的 K_conv wire —— 服务端没有 K_user，不给 wire 它永远读不到 D
 * （这正是零知识要的效果）。所以解不出钥匙时**抛错**给 UI 显示，而不是发一个没 wire
 * 的 approve 让服务端 400（那样用户以为授权成功了，实际 agent 永远读不到）。
 *
 * requester_k_conv_wire 是可选的「顺手」：发起方对话 A 加密时带上，服务端就能立刻唤醒
 * 它的 agent 去读 D；不带则事件入队，等用户下次打开 A 才看到（不丢，只是不即时）。
 */
/** 发起方对话若绑定加密 agent，续起 run 的 server 入口 unwrap_request_keys 会要求 k_agent_wire，缺则
 *  400 被 spawner 吞掉、续起 run 永不执行（点允许后卡「提交中」、agent 不继续的根因）。这里解出发起方
 *  bound agent 的 K_agent 包成 wire；明文 agent / 未解锁则返回 null（无需带）。 */
async function resolveRequesterAgentWire(
  session: Session,
  requesterConversationId: string,
  pub: string
): Promise<string | null> {
  try {
    const meta = await fetchConversationMeta(session, String(requesterConversationId || '').trim());
    const agentId =
      meta && typeof (meta as { bound_agent_id?: unknown }).bound_agent_id === 'string'
        ? String((meta as { bound_agent_id?: string }).bound_agent_id).trim()
        : '';
    if (!agentId) return null;
    const kAgent = getCachedKAgent(agentId);
    if (!kAgent) return null;
    return wrapKAgentForWire(kAgent, pub);
  } catch {
    return null;
  }
}

export async function submitConversationAccessDecision(
  session: Session,
  opts: {
    requestId: string;
    decision: 'approve' | 'reject';
    requesterConversationId: string;
    targetConversationId: string;
  }
): Promise<void> {
  const base = session.server_base_url;
  const body: Record<string, unknown> = {
    request_id: opts.requestId,
    // 服务端契约是 approve / reject（不是 approved / rejected），见 server.py
    decision: opts.decision,
    target_conversation_id: opts.targetConversationId,
  };
  if (opts.decision === 'approve') {
    const targetK = await resolveKConvForConversation(session, opts.targetConversationId);
    if (!targetK) {
      throw new Error('拿不到目标对话的密钥（可能已被删除，或不在当前账号下）');
    }
    const pub = await getTransportPubkeyMobile(base);
    body.target_k_conv_wire = wrapKConvForWire(targetK, pub);
    const requesterK = getCachedKConv(opts.requesterConversationId);
    if (requesterK) {
      try {
        body.requester_k_conv_wire = wrapKConvForWire(requesterK, pub);
      } catch {
        // 包不上不算致命：授权本身照样成立，只是发起方要等下次打开才看到结果
      }
    }
    // 发起方绑定加密 agent → 续起 run 入口要 k_agent_wire，一并带上（缺则 400 被吞、续起不执行）
    const reqAgentWire = await resolveRequesterAgentWire(session, opts.requesterConversationId, pub);
    if (reqAgentWire) body.requester_k_agent_wire = reqAgentWire;
  }
  const res = await fetchWithDebugLog(
    `${base}api/conversations/${encodeURIComponent(opts.requesterConversationId)}/access/decision`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(session.access_token) },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `提交授权决策失败: ${res.status}`);
  }
}

/**
 * 批量标题解密授权（list_conversations 触发）：用户对「agent 想看你 N 个加密对话的标题」弹窗点
 * 允许/拒绝。允许时用 K_user 逐个解出这些对话标题明文打包上送 titles_decision；服务端缓存 5min +
 * 唤醒发起方 agent 再次 list_conversations 即见明文。服务端无 K_user、不解标题，零知识不破。
 */
export async function submitConversationTitlesDecision(
  session: Session,
  opts: {
    requestId: string;
    decision: 'approve' | 'reject';
    requesterConversationId: string;
    targetIds: string[];
  }
): Promise<void> {
  const base = session.server_base_url;
  const body: Record<string, unknown> = { request_id: opts.requestId, decision: opts.decision };
  if (opts.decision === 'approve') {
    const { aesGcmDecrypt } = await import('./lib/srp');
    const titles: Array<{ conversation_id: string; title: string }> = [];
    for (const raw of Array.isArray(opts.targetIds) ? opts.targetIds : []) {
      const cid = String(raw || '').trim();
      if (!cid) continue;
      try {
        const meta = await fetchConversationMeta(session, cid);
        const ct = meta && typeof meta.title_ciphertext === 'string' ? meta.title_ciphertext : '';
        if (!ct) continue;
        const k = await resolveKConvForConversation(session, cid);
        if (!k) continue;
        const title = JSON.parse(new TextDecoder().decode(aesGcmDecrypt(base64ToBytes(ct), k)));
        if (typeof title === 'string') titles.push({ conversation_id: cid, title });
      } catch (e) {
        console.warn('[conv-titles] 解密标题失败(跳过):', cid, (e as Error)?.message || e);
      }
    }
    body.titles = titles;
    const pub = await getTransportPubkeyMobile(base);
    const requesterK = getCachedKConv(opts.requesterConversationId);
    if (requesterK) {
      try {
        body.requester_k_conv_wire = wrapKConvForWire(requesterK, pub);
      } catch {
        // 包不上不致命：授权照样成立，发起方等下次打开才看到
      }
    }
    // 发起方绑定加密 agent → 续起 run 入口要 k_agent_wire，一并带上（缺则 400 被吞、续起不执行）
    const reqAgentWire = await resolveRequesterAgentWire(session, opts.requesterConversationId, pub);
    if (reqAgentWire) body.requester_k_agent_wire = reqAgentWire;
  }
  const res = await fetchWithDebugLog(
    `${base}api/conversations/${encodeURIComponent(opts.requesterConversationId)}/access/titles_decision`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(session.access_token) },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `提交标题授权决策失败: ${res.status}`);
  }
}

/**
 * eager-mint（WP3）：服务端刚 spawn 一条加密子对话 → 趁本端此刻手里有父对话的 K_conv，
 * 立刻把它 mint 成 direct（k_conv_blob = AES-GCM(child_K_conv, K_user)）。
 *
 * 全程静默、不抛错：这只是把「用户真正打开该子对话时才会做的自愈」提前到 spawn 瞬间，
 * 没做成也不影响正确性（打开时还会再做一次），只是少了那点提前量。
 * 返回是否真的 mint 了，仅供调试。
 */
export async function mintChildKConvDirect(
  session: Session,
  childConversationId: string
): Promise<boolean> {
  try {
    const cid = String(childConversationId || '').trim();
    if (!cid) return false;
    const meta = await fetchConversationMeta(session, cid);
    if (!meta || !meta.encrypted) return false;
    // 已有自己的 blob = 已经 direct（端点幂等，但没必要白跑一趟网络）
    if (meta.k_conv_blob) return false;
    if (!String(meta.k_conv_parent || '').trim()) return false;
    const kUserStr = await getStoredKUser();
    if (!kUserStr) return false;
    const childK = await resolveKConvForConversation(session, cid);
    if (!childK) return false;
    const blobB64 = wrapKConvBlobForUser(childK, base64ToBytes(kUserStr));
    const res = await fetchWithDebugLog(
      `${session.server_base_url}api/conversations/${encodeURIComponent(cid)}/upgrade_encrypted_kconv`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(session.access_token) },
        body: JSON.stringify({ k_conv_blob: blobB64 }),
      }
    );
    return res.ok;
  } catch (e) {
    console.warn('[eager-mint mobile] 升级 direct 失败（不影响功能）:', (e as Error)?.message || e);
    return false;
  }
}

export async function getConversation(
  session: Session,
  conversationId: string,
  /** 不传 = 全量（保持老调用方行为）；路由打开会显式传 CHAT_MESSAGES_INITIAL_LIMIT 走尾窗 */
  messagesLimit?: number
): Promise<{ conversation: Conversation; messagesWindow: MessageWindow | null }> {
  const base = session.server_base_url;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const limitQuery =
    typeof messagesLimit === 'number' && messagesLimit > 0 ? `?messages_limit=${messagesLimit}` : '';
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}${limitQuery}`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `获取对话失败: ${res.status}`);
  }
  const conversation = (await res.json()) as Conversation & {
    encrypted?: boolean;
    k_conv_blob?: string;
    title_ciphertext?: string;
    messages?: Array<Record<string, unknown>>;
    /** S9 加密子对话的明文路由字段：K_conv 去哪儿取、父对话是谁 */
    k_conv_source?: string;
    k_conv_parent?: string;
    locked_reason?: 'need_parent' | null;
  };
  const tParse = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // 加密对话：用本机 K_user 派生 K_conv 缓存 + 本地解密 messages + title。
  // S9：加密 flops 子对话没有自己的 k_conv_blob，K_conv 存在父对话 meta 里 → 打开父对话时
  // 已被 decryptSubagentChildrenIntoCache 预缓存；这里用 getCachedKConv 命中即可解。
  // （子对话直开且父未加载 → 缓存 miss → 保持锁定，用户先打开父对话再回来；跨对话属授权桥 S10。）
  if (conversation && conversation.encrypted) {
    try {
      let kConv = getCachedKConv(conversationId);
      if (!kConv && conversation.k_conv_blob) {
        const kUserStr = await getStoredKUser();
        if (kUserStr) {
          const kUserBytes = base64ToBytes(kUserStr);
          kConv = deriveKConvFromBlob(conversation.k_conv_blob, kUserBytes);
          setCachedKConv(conversationId, kConv);
        }
      }
      if (!kConv && !conversation.k_conv_blob) {
        // S9 加密子对话：钥匙不在自己身上，去父对话 meta 里捞（父对话没打开过时的常态）
        kConv = await resolveChildKConvViaParent(session, conversation);
        if (!kConv) conversation.locked_reason = 'need_parent';
      }
      if (kConv) {
        // 本对话若是父对话（带 subagent_children_ciphertext）→ 顺带把子 key 预缓存
        decryptSubagentChildrenIntoCache(
          conversation as { subagent_children_ciphertext?: string },
          kConv,
        );
        conversation.locked_reason = null;
        // S9 删父自愈：本对话是「密钥存父 meta」的加密子对话且尚未 direct → 用 K_user 重包一份
        // 独立 k_conv_blob 上送升级，脱离对父依赖（父删也不丢）。fire-and-forget。
        const _convAny = conversation as { k_conv_source?: string; k_conv_blob?: string };
        if (_convAny.k_conv_source === 'parent_meta' && !_convAny.k_conv_blob) {
          try {
            const kUserStr2 = await getStoredKUser();
            if (kUserStr2) {
              const blobB64 = wrapKConvBlobForUser(kConv, base64ToBytes(kUserStr2));
              void fetchWithDebugLog(`${base}api/conversations/${conversationId}/upgrade_encrypted_kconv`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders(session.access_token) },
                body: JSON.stringify({ k_conv_blob: blobB64 }),
              }).catch(() => {});
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[encrypted child mobile] 升级 direct 失败(不影响解密):', (e as Error)?.message || e);
          }
        }
        if (Array.isArray(conversation.messages)) {
          conversation.messages = conversation.messages.map((m) => decryptMessageLocal(m, kConv!));
        }
        // conv 自己的 title 也带密文（跟列表接口同款），ChatScreen 顶部标题直接读
        // conversation.title，所以这里得就地替换掉 server 给的 sentinel
        if (typeof conversation.title_ciphertext === 'string' && conversation.title_ciphertext) {
          try {
            const { aesGcmDecrypt } = await import('./lib/srp');
            const blob = base64ToBytes(conversation.title_ciphertext);
            const pt = aesGcmDecrypt(blob, kConv);
            conversation.title = JSON.parse(new TextDecoder().decode(pt));
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[encrypted conv mobile] title decrypt failed:', (e as Error)?.message || e);
          }
        }
      }
    } catch (e) {
      // 失败时 messages 保留 sentinel 状态，UI 起码不崩
      // eslint-disable-next-line no-console
      console.warn('[encrypted conv mobile] decrypt failed:', (e as Error)?.message || e);
    }
  }
  // 加密 agent：拿到 agent_profile.k_agent_blob 后用 K_user 派生 K_agent 缓存，
  // 供后续 chat_v2 POST 拼 k_agent_wire。多个 conv 共享同一 K_agent。
  if (conversation?.agent_profile?.encrypted && conversation.agent_profile.k_agent_blob) {
    const aid = String(conversation.agent_profile.agent_id || conversation.bound_agent_id || '').trim();
    if (aid && !getCachedKAgent(aid)) {
      try {
        const kUserStr = await getStoredKUser();
        if (kUserStr) {
          const kUserBytes = base64ToBytes(kUserStr);
          const kAgent = deriveKAgentFromBlob(conversation.agent_profile.k_agent_blob, kUserBytes);
          setCachedKAgent(aid, kAgent);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[encrypted agent mobile] K_agent derive failed:', (e as Error)?.message || e);
      }
    }
  }
  const t2 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const msgs = conversation?.messages;
  const messageCount = Array.isArray(msgs) ? msgs.length : 0;
  const rid = conversation?.active_chat_v2_run_id;
  const hasActiveRun = typeof rid === 'string' && rid.trim().length > 0;
  convProfileLog('getConversation', {
    conversationId,
    /** fetch Promise resolve（RN 上通常接近首包+下载完成，不等同于纯 TTFB） */
    fetchAwaitMs: Math.round(t1 - t0),
    /** 纯 JSON.parse（res.json()）耗时 */
    jsonParseMs: Math.round(tParse - t1),
    /** 解密 messages + title + agent 派生耗时 */
    decryptMs: Math.round(t2 - tParse),
    resJsonParseMs: Math.round(t2 - t1),
    fetchPlusJsonMs: Math.round(t2 - t0),
    status: res.status,
    messageCount,
    hasActiveRun,
  });
  // messages_window 是响应顶层字段（conversation 即整个 JSON），尾窗时存在
  return { conversation, messagesWindow: parseMessageWindow(conversation) };
}

/**
 * 轻量拉取对话顶层元信息：GET /api/conversations/:id/meta
 * 只返回顶层字段（含 active_chat_v2_run_id），不含 messages，耗时极短。
 * 用于回前台 resume 判定——先看有没有活动 run，再决定要不要拉全量。
 */
export async function getConversationMeta(
  session: Session,
  conversationId: string
): Promise<{ conversation: Partial<Conversation> & { active_chat_v2_run_id?: string } }> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/meta`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `获取对话元信息失败: ${res.status}`);
  }
  const conversation = (await res.json()) as Partial<Conversation> & {
    active_chat_v2_run_id?: string;
  };
  return { conversation };
}

/**
 * 加载更旧消息（上滚分页）：GET /api/conversations/:id/messages/before?before_index=&limit=
 * 返回的 older 消息密文用同会话已缓存的 K_conv 就地解密（对齐 web）。
 * @returns older 已解密的 ConversationMessage[] + 新的窗口元数据
 */
export async function getMessagesBefore(
  session: Session,
  conversationId: string,
  beforeIndex: number,
  limit: number = CHAT_MESSAGES_LOAD_OLDER
): Promise<{ messages: ConversationMessage[]; messagesWindow: MessageWindow | null }> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(
    `${base}api/conversations/${conversationId}/messages/before?before_index=${beforeIndex}&limit=${limit}`,
    { method: 'GET', headers: authHeaders(session.access_token) }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `加载更旧消息失败: ${res.status}`);
  }
  const data = (await res.json()) as {
    messages?: Array<Record<string, unknown>>;
    window?: Record<string, unknown>;
  };
  let older: ConversationMessage[] = Array.isArray(data.messages)
    ? (data.messages as unknown as ConversationMessage[])
    : [];
  // 加密会话：用同会话已缓存的 K_conv 就地解密 older（初次 getConversation 已 setCachedKConv）
  const kConv = getCachedKConv(conversationId);
  if (kConv && older.length > 0) {
    try {
      older = older.map((m) => decryptMessageLocal(m as unknown as Record<string, unknown>, kConv) as unknown as ConversationMessage);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[encrypted conv mobile] older decrypt failed:', (e as Error)?.message || e);
    }
  }
  // /messages/before 的窗口字段挂在 data.window 下（对齐 web）
  return { messages: older, messagesWindow: parseMessageWindow({ messages_window: data.window }) };
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
 * P2 待发队列：agent 在跑时用户发的消息排队（服务端存、多端可见），本段 run 收尾时自动按序发；
 * 也可对某条「立刻穿插」注入当前活跃 run。加密对话：content 用 K_conv 加密后落盘（明文不出端）。
 */
export async function enqueueSendQueue(
  session: Session,
  conversationId: string,
  message: unknown,
  flopsRefs?: unknown[]
): Promise<{ id: string }> {
  const base = session.server_base_url;
  const body: Record<string, unknown> = { message };
  if (Array.isArray(flopsRefs) && flopsRefs.length > 0) body.flops_refs = flopsRefs;
  const kConv = getCachedKConv(conversationId);
  if (kConv) {
    try {
      const pub = await getTransportPubkeyMobile(base);
      body.k_conv_wire = wrapKConvForWire(kConv, pub);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[send_queue mobile] wrap K_conv failed:', (e as Error)?.message || e);
    }
  }
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/send_queue`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `入队失败: ${res.status}`);
  }
  const data = (await res.json()) as { id?: string };
  return { id: String(data.id || '') };
}

/** 列出待发队列；加密对话用同会话已缓存的 K_conv 就地解密 content（对齐 web/desktop）。 */
export async function getSendQueue(
  session: Session,
  conversationId: string
): Promise<Array<{ id: string; content: unknown }>> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/send_queue`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
  let items = Array.isArray(data.items) ? data.items : [];
  const kConv = getCachedKConv(conversationId);
  if (kConv && items.length > 0) {
    try {
      items = items.map((m) => decryptMessageLocal(m, kConv) as Record<string, unknown>);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[send_queue mobile] decrypt failed:', (e as Error)?.message || e);
    }
  }
  return items.map((m) => ({ id: String(m.id || ''), content: m.content }));
}

export async function deleteSendQueueItem(
  session: Session,
  conversationId: string,
  itemId: string
): Promise<void> {
  const base = session.server_base_url;
  await fetchWithDebugLog(`${base}api/conversations/${conversationId}/send_queue/${itemId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  }).catch(() => undefined);
}

/** 立刻穿插：移出待发队列 → 注入当前活跃 run（content 已加密落盘，无需再带 wire）。 */
export async function injectSendQueueItem(
  session: Session,
  conversationId: string,
  itemId: string
): Promise<void> {
  const base = session.server_base_url;
  await fetchWithDebugLog(`${base}api/conversations/${conversationId}/send_queue/${itemId}/inject`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => undefined);
}

/**
 * 创建会话：POST /api/conversations（可选 body.bound_agent_id，与 FlopsWeb 一致）
 */
export async function createConversation(
  session: Session,
  opts?: { bound_agent_id?: string; encrypted?: boolean }
): Promise<{ id: string; bound_agent_id?: string; agent_profile?: AgentProfile; model?: string }> {
  const base = session.server_base_url;
  const body: Record<string, unknown> = {};
  const bid = String(opts?.bound_agent_id || '').trim();
  if (bid) body.bound_agent_id = bid;
  // 加密对话：现场生成 K_conv + 用本机 K_user 包成 k_conv_blob 一并 POST，
  // 创建成功后 setCachedKConv 让随后的 chat_v2 自带 k_conv_wire
  if (opts?.encrypted) {
    const kUserStr = await getStoredKUser();
    if (!kUserStr) throw new Error('本机无 K_user，请先重新登录');
    const { generateKConvAndBlob } = await import('./lib/srp');
    const kUserBytes = base64ToBytes(kUserStr);
    const { kConvBytes, kConvBlobB64 } = generateKConvAndBlob(kUserBytes);
    body.encrypted = true;
    body.k_conv_blob = kConvBlobB64;
    // 缓存到 SDK module-level cache（chat_v2 路径会查它）
    // 但 conv id 还不知道（创建后才知）；我们 store 一份临时键，回头 patch
    (body as Record<string, unknown>).__pending_kconv = kConvBytes;
  }
  const res = await fetchWithDebugLog(`${base}api/conversations`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ ...body, __pending_kconv: undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `创建会话失败: ${res.status}`);
  }
  const data = (await res.json()) as {
    id?: string;
    bound_agent_id?: string;
    agent_profile?: AgentProfile;
    model?: string;
  };
  if (!data.id) throw new Error('服务端未返回会话 id');
  // 创建成功后注册 K_conv 到 cache
  if (opts?.encrypted) {
    try {
      const pending = (body as Record<string, unknown>).__pending_kconv as Uint8Array | undefined;
      if (pending) setCachedKConv(data.id, pending);
    } catch { /* ignore */ }
  }
  // 返回 bound_agent_id + agent_profile（对齐 web）：惰性创建的草稿对话靠这个在首条消息前
  // 灌进 conversationMetaRef，否则加密 bound agent 的 chat_v2 缺 k_agent_wire → server 400。
  // model = server 以用户默认为种子写的对话级模型，供 composer 标签立即显示。
  return {
    id: data.id,
    bound_agent_id: typeof data.bound_agent_id === 'string' ? data.bound_agent_id : undefined,
    agent_profile: data.agent_profile,
    model: typeof data.model === 'string' ? data.model : undefined,
  };
}

/**
 * GET /api/preview/by-url：读某个视频 URL 的转码镜像状态。
 * 返回 {state, url?, source_codec?, ...}；找不到 / 失败 / 401 返回 null。
 * 与 web flowdoc-editor-core/previewApi.js 同语义，供 flowdoc 渲染引擎经注入调用。
 */
export async function getVideoPreviewByUrl(
  session: Session,
  url: string
): Promise<VideoPreview | null> {
  if (!url) return null;
  try {
    const base = session.server_base_url;
    const res = await fetchWithDebugLog(
      `${base}api/preview/by-url?url=${encodeURIComponent(url)}`,
      { method: 'GET', headers: authHeaders(session.access_token) }
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { preview?: VideoPreview } | null;
    const preview = data && typeof data === 'object' ? data.preview : null;
    return preview && typeof preview === 'object' && preview.state ? preview : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/preview/trigger：对一个原始视频 URL 触发后台 H.264 转码镜像任务。
 * 返回最新 preview dict（通常 state='pending'）；失败 / 401 返回 null。
 */
export async function triggerVideoPreview(
  session: Session,
  url: string,
  filename: string,
  mimeType: string
): Promise<VideoPreview | null> {
  if (!url) return null;
  try {
    const base = session.server_base_url;
    const res = await fetchWithDebugLog(`${base}api/preview/trigger`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ url, filename: filename || '', mime_type: mimeType || 'video/mp4' }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { preview?: VideoPreview } | null;
    const preview = data && typeof data === 'object' ? data.preview : null;
    return preview && typeof preview === 'object' && preview.state ? preview : null;
  } catch {
    return null;
  }
}

/** GET /api/agentf/agent-ids — 与 FlopsWeb Chat.jsx 一致（顺序：用户设置页保存的序，或默认字母序） */
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

/** PUT /api/agentf/agent-order — body { agent_ids } 全量排列；未在 App 内提供 UI 时可自用于自动化 */
export async function putAgentIdOrder(
  session: Session,
  agentIds: string[]
): Promise<string[]> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/agentf/agent-order`, {
    method: 'PUT',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_ids: agentIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `保存顺序失败: ${res.status}`);
  }
  const data = (await res.json()) as { agent_ids?: unknown };
  return Array.isArray(data.agent_ids) ? data.agent_ids.map(String) : agentIds;
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

/* server reload 实测：3s shutdown + ~1-3s startup + recovery sweep ≈ 5-8s。20×500=10s 兜底。 */
const CHAT_V2_RECONNECT_MAX = 20;
const CHAT_V2_RECONNECT_DELAY_MS = 500;

/** server 409：重生成的不是最新一条非-meta user 消息，继续会丢中间所有消息，需客户端确认后带
 *  confirm_non_latest_regenerate=true 重试。携带 detail 供 UI 弹确认框展示影响范围。 */
export type NonLatestRegenerateDetail = {
  error: 'non_latest_regenerate_requires_confirm';
  message?: string;
  after_user_index?: number;
  latest_user_index?: number;
  target_preview?: string;
  latest_preview?: string;
  messages_to_drop?: number;
  total_messages?: number;
};
export class NonLatestRegenerateConfirmError extends Error {
  detail: NonLatestRegenerateDetail;
  constructor(detail: NonLatestRegenerateDetail) {
    super(detail.message || '重新生成会丢失中间消息，需确认');
    this.name = 'NonLatestRegenerateConfirmError';
    this.detail = detail;
  }
}

export type ChatV2StreamStart =
  /** message：纯字符串（旧行为），或多模态 content 数组（含 flops_attachment 附件 part）。
   *  server _normalize_client_chat_message 兼容两者；附件只在数组形态下才被解析。 */
  | { tag: 'new_message'; message: string | Array<Record<string, unknown>>; flops_refs?: unknown[] }
  | {
      tag: 'regenerate';
      after_user_index?: number;
      /** P1d：trigger task_event 的"重新处理"——按 task_id 锚定（与 after_user_index 二选一） */
      regenerate_after_task_id?: string;
      message?: string;
      flops_refs?: unknown[];
      /** 重生成的不是最新一条 user 消息时，server 409 要求确认（会丢中间消息）；用户确认后带 true 重试 */
      confirm_non_latest_regenerate?: boolean;
    }
  | { tag: 'resume'; run_id: string };

/** 每帧的投递元信息。 */
export type ChatStreamFrameMeta = {
  /**
   * 这帧来自**回放段**（服务端补历史），而不是实时段。
   *
   * 判据是服务端契约（server.py `_chat_v2_subscribe_stream`）：回放段原样吐、不注入游标；
   * 实时段注入 `_replay_from`。所以「没有 `_replay_from` 且不是 `v2_buffer_cursor`」⟺ 回放。
   * 不用内容比对 —— 回放段是合并段、实时段是原始事件，粒度不同，按内容对不上
   * （engine/execution.py subscribe 的文档明确写了这点）。
   */
  replayed: boolean;
};

export type StreamChatV2LoopOptions = {
  /** 返回 false 时停止循环（例如已切换对话） */
  isAlive?: () => boolean;
  /**
   * resume 时的起始游标（`subscribe(from_cursor)` 口径）。省略 / 0 = 从这轮 run 的开头
   * 补全部历史（新客户端、或本地没有可续的内容时的正确选择）。
   *
   * 之所以要从外面传：replayFrom 本来是本函数闭包里的 let，切后台 abort 后闭包连同游标
   * 一起没了，下一次 resume 只能从 0 重来 —— 表现为「回前台整轮重放一遍」。
   */
  initialReplayFrom?: number;
  /**
   * 游标推进时回调，供调用方把它存到组件外（ref）以便跨调用 resume。
   * 每帧都会触发，实现里别做重活、更别 setState。
   */
  onCursorAdvance?: (runId: string, cursor: number) => void;
  /** 加密 agent 时，让 loop 知道当前 bound agent + k_agent_blob 兜底（缓存里没有时用 K_user 派生）。
   *  对应 server 端：encrypted agent 的 chat_v2 必须带 k_agent_wire，否则 400。 */
  agentEncryption?: {
    agentId: string;
    kAgentBlobB64?: string | null;
  };
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
  /** 第二参给出该帧的投递元信息：`replayed` = 这是回放段（服务端未注入游标）。
   *  调用方可据此把回放段攒起来批量渲染，实时段维持逐帧。可选，不读也不影响正确性。 */
  onEvent: (event: ChatStreamEvent, meta?: ChatStreamFrameMeta) => void,
  signal?: AbortSignal,
  options?: StreamChatV2LoopOptions
): Promise<void> {
  const base = session.server_base_url;
  const alive = options?.isAlive ?? (() => true);
  let v2RunId = start.tag === 'resume' ? String(start.run_id || '').trim() : '';
  /* resume 续流：从调用方存下来的游标接着走；其余情况（新消息 / regenerate）恒 0。
     只有 resume 认这个值 —— 新起一轮 run 的游标空间跟上一轮无关，混用会错位。 */
  let replayFrom = start.tag === 'resume' ? Math.max(0, options?.initialReplayFrom ?? 0) : 0;
  let reconnectAttempt = 0;
  let streamCompleted = false;
  const decoder = getTextDecoder();

  const consumeReader = async (
    reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> }
  ): Promise<void> => {
    let buffer = '';
    while (alive() && !signal?.aborted) {
      let readResult: { value?: Uint8Array; done: boolean };
      try {
        readResult = await reader.read();
      } catch (err: unknown) {
        /* server reload / 网络断开：reader.read() 抛 NetworkError。AbortError 让外层处理；
           其他错误静默 return，让外层 while 检查 streamCompleted=false 走 reconnect 分支。 */
        if (typeof err === 'object' && err !== null && 'name' in err && (err as { name?: string }).name === 'AbortError') {
          throw err;
        }
        // eslint-disable-next-line no-console
        console.warn('[chat_v2 mobile] reader interrupted, will reconnect:', (err as Error)?.message || err);
        /* 兜底：server 在 SIGKILL 之前把 v2_reload_pending chunk 送出失败时，client 收不到。
           reader 抛错时主动给上层一个 synthetic 事件让 banner 能显示。reload-pending 是 application
           层契约——网络断开通常意味着 server 在 reload，这个推断对绝大多数场景适用。 */
        try {
          onEvent({
            type: 'v2_reload_pending',
            message: '服务器热更新中，稍后将继续',
          } as unknown as ChatStreamEvent);
        } catch {
          /* ignore */
        }
        return;
      }
      const { value, done } = readResult;
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
        let data: ChatStreamEvent & {
          done?: boolean;
          type?: string;
          _replay_from?: number;
          replay_from?: number;
          ciphertext?: string;
        };
        try {
          data = JSON.parse(jsonStr) as ChatStreamEvent & {
            done?: boolean;
            type?: string;
            _replay_from?: number;
            replay_from?: number;
            ciphertext?: string;
          };
        } catch {
          continue;
        }
        /* 加密对话：encrypted_chunk wrapper → 解出 inner JSON 再分发。
           注意顺序 —— 服务端是**先**把 _replay_from 注入内层事件 JSON
           （_chat_v2_subscribe_stream 里的 sse_inject_replay_cursor），**再**把整块包成
           encrypted_chunk（_sse_response → maybe_encrypt_sse_stream）。所以游标在密文内层，
           外层信封只有 {type, ciphertext}。这里解包后 data 就是带游标的内层事件，
           下面的游标推进与回放判定直接读它即可，不需要额外从外层搬运。 */
        if (data && data.type === 'encrypted_chunk' && data.ciphertext) {
          const _kc = getCachedKConv(conversationId);
          if (_kc) {
            /* 直接把已经解析出来的 ciphertext 交给解密，绕开 `data: …\n\n` 信封的拆包/重包
               和为拿回 ciphertext 而做的第二次 JSON.parse（详见 decryptSseCiphertextToText）。
               subagent 实时帧每 250ms 重发全量 agent_blocks，这条路上省下的逐字符循环很实在。 */
            const innerStr = decryptSseCiphertextToText(data.ciphertext, _kc);
            if (innerStr == null) {
              // eslint-disable-next-line no-console
              console.warn('[encrypted_chunk mobile] decrypt failed');
              continue;
            }
            try {
              data = JSON.parse(innerStr) as typeof data;
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[encrypted_chunk mobile] inner JSON parse failed:', (e as Error)?.message || e);
              continue;
            }
          } else {
            // eslint-disable-next-line no-console
            console.warn('[encrypted_chunk mobile] no cached K_conv, skip');
            continue;
          }
        }
        /* 游标推进 + 判定这帧是不是「回放」。
           服务端契约（server.py _chat_v2_subscribe_stream）：回放段原样吐、**不注入游标**；
           实时段注入 _replay_from。所以「没有 _replay_from 且不是 v2_buffer_cursor」⟺ 回放帧。
           严格按这个契约判，不看内容 —— 回放段是合并段、实时段是原始事件，按内容对不上。 */
        let isReplayFrame = false;
        if (typeof data._replay_from === 'number' && Number.isFinite(data._replay_from)) {
          replayFrom = data._replay_from;
        } else if (
          data.type === 'v2_buffer_cursor' &&
          typeof data.replay_from === 'number' &&
          Number.isFinite(data.replay_from)
        ) {
          replayFrom = data.replay_from;
        } else {
          replayFrom += 1;
          isReplayFrame = true;
        }
        if (data.type === 'v2_run' && typeof (data as { run_id?: string }).run_id === 'string') {
          const rid = (data as { run_id: string }).run_id;
          if (rid) v2RunId = rid;
        }
        /* 放在 v2_run 之后上报：新起一轮时 run_id 是靠这一帧才知道的，
           先认到 id 再报，这一帧的游标也就一并记上了。没有 run_id 就无从归属，跳过。 */
        if (v2RunId) options?.onCursorAdvance?.(v2RunId, replayFrom);
        if (data.type === 'v2_reload_pending') {
          /* server SIGTERM 前主动通知：靠应用层事件让 client 立刻退出本次 reader 走 reconnect。
             把事件透传给上层 UI 显示「服务器热更新中…」（onEvent 处理者负责 UI）。 */
          // eslint-disable-next-line no-console
          console.warn('[chat_v2 mobile] server reload pending, will reconnect');
          onEvent(data as ChatStreamEvent, { replayed: isReplayFrame });
          return;
        }
        if (data.type === 'v2_step_rollback') {
          /* server reload 后 resume worker 重跑当前 step 前发此事件——上层 UI 应清掉本 step
             已显示的 partial blocks，避免 LLM 重生成内容与旧 partial 重复。 */
          onEvent(data as ChatStreamEvent, { replayed: isReplayFrame });
          continue;
        }
        if ('error' in data && data.error) {
          throw new Error(String(data.error));
        }
        onEvent(data as ChatStreamEvent, { replayed: isReplayFrame });
        if ('done' in data && data.done === true) {
          streamCompleted = true;
          return;
        }
        if ('type' in data && data.type === 'cancelled') {
          streamCompleted = true;
          return;
        }
        if ('type' in data && data.type === 'suspended_awaiting_user') {
          // 本轮挂起等用户确认/回答（授权 / 安全确认 / 选择题）：这是**正常的流结束**（服务端随后关闭
          // 连接、marker 不带 done），不是异常中断。必须与 done/cancelled 一样收尾——否则会被误判成
          // "流中断"→ 徒劳 subscribe_only 重连到已挂起的 run → 20 次耗尽 → 弹「流式连接中断」红横幅
          // 并从此停流（用户反复遇到的红横幅根因，ask_user_question 早就存在故"之前就有"）。
          // 与 Desktop createAssistantChatStreamSession 的 suspended_awaiting_user 处理一致。
          streamCompleted = true;
          return;
        }
        /* 每帧让路只为**实时**流畅（让 UI 有机会画一帧）。回放段不能让：那会把
           「瞬间追平」拆成几百次渲染，正是「稀里哗啦重放一遍」的直接来源。 */
        if (!isReplayFrame && 'type' in data && data.type === 'tool_result_chunk') {
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
      body = {
        message: start.message,
        ...(Array.isArray(start.flops_refs) && start.flops_refs.length > 0
          ? { flops_refs: start.flops_refs }
          : {}),
      };
    } else if (start.tag === 'regenerate') {
      body = {
        regenerate: true,
        ...(start.regenerate_after_task_id
          ? { regenerate_after_task_id: start.regenerate_after_task_id }
          : { after_user_index: start.after_user_index }),
        ...(typeof start.message === 'string' && start.message.length > 0 ? { message: start.message } : {}),
        ...(Array.isArray(start.flops_refs) && start.flops_refs.length > 0
          ? { flops_refs: start.flops_refs }
          : {}),
        ...(start.confirm_non_latest_regenerate ? { confirm_non_latest_regenerate: true } : {}),
      };
    } else {
      /* resume 首发。**必须用 replayFrom 而不是写死 0** —— 它已按 initialReplayFrom 预置
         （没有可续的游标时本来就是 0）。写死 0 的话服务端 subscribe(from_cursor=0) 会把整轮
         从头重放一遍，切后台回来就是「稀里哗啦重收一遍」。下面 isReconnect 分支同源。 */
      body = { subscribe_only: true, run_id: v2RunId, replay_from: replayFrom };
    }

    // 加密 conv + agent：用 cached K_conv / K_agent 算 k_conv_wire / k_agent_wire 附在 body 里
    // （每次发 / 重连都重算 nonce）。K_agent 走 options.agentEncryption 兜底派生：
    // 缓存里没有 + 调用方给了 k_agent_blob 时，用本机 K_user 派生并存回缓存。
    {
      const _kcSend = getCachedKConv(conversationId);

      let _kaSend: Uint8Array | null = null;
      const _agentEnc = options?.agentEncryption;
      if (_agentEnc && _agentEnc.agentId) {
        _kaSend = getCachedKAgent(_agentEnc.agentId);
        if (!_kaSend && _agentEnc.kAgentBlobB64) {
          try {
            const kUserStr = await getStoredKUser();
            if (kUserStr) {
              const kUserBytes = base64ToBytes(kUserStr);
              _kaSend = deriveKAgentFromBlob(_agentEnc.kAgentBlobB64, kUserBytes);
              setCachedKAgent(_agentEnc.agentId, _kaSend);
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[encrypted chat_v2 mobile] K_agent derive failed:', (e as Error)?.message || e);
          }
        }
      }

      if (_kcSend || _kaSend) {
        try {
          const pub = await getTransportPubkeyMobile(base);
          if (_kcSend) body.k_conv_wire = wrapKConvForWire(_kcSend, pub);
          if (_kaSend) body.k_agent_wire = wrapKAgentForWire(_kaSend, pub);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[encrypted chat_v2 mobile] wrap K_conv/K_agent failed:', (e as Error)?.message || e);
          throw new Error('加密对话发送失败：本机无法包装密钥');
        }
      }
    }

    let res: Response;
    try {
      res = await fetchWithDebugLog(`${base}api/conversations/${conversationId}/chat_v2`, {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: JSON.stringify(body),
        signal,
        reactNative: { textStreaming: true },
      } as RequestInit);
    } catch (fetchErr: unknown) {
      if (typeof fetchErr === 'object' && fetchErr !== null && 'name' in fetchErr && (fetchErr as { name?: string }).name === 'AbortError') {
        throw fetchErr;
      }
      /* reconnect 时 server 还在重启，fetch 直接抛 NetworkError；当作"重试一次" */
      if (!isReconnect) throw fetchErr;
      // eslint-disable-next-line no-console
      console.warn(`[chat_v2 mobile] reconnect fetch failed (attempt ${reconnectAttempt}):`, (fetchErr as Error)?.message || fetchErr);
      reconnectAttempt += 1;
      if (reconnectAttempt > CHAT_V2_RECONNECT_MAX) throw new Error('流重连次数已达上限（fetch）');
      await new Promise<void>((r) => setTimeout(r, CHAT_V2_RECONNECT_DELAY_MS));
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const rawDetail = (err as { detail?: unknown }).detail;
      /* 非最新重生成需确认：detail 是结构化对象（{error, message, messages_to_drop, ...}），
         抛专用错误让上层弹确认框，而不是当成"已有进行中回复"。 */
      if (
        res.status === 409 &&
        !isReconnect &&
        rawDetail &&
        typeof rawDetail === 'object' &&
        (rawDetail as { error?: string }).error === 'non_latest_regenerate_requires_confirm'
      ) {
        throw new NonLatestRegenerateConfirmError(rawDetail as NonLatestRegenerateDetail);
      }
      const detail =
        (typeof rawDetail === 'string' ? rawDetail : undefined) || `请求失败: ${res.status}`;
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
/** 挂起/恢复：加密对话在提交确认/回应时重发 k_conv_wire，供服务端续起 run 解密对话续跑
 *  （零知识，服务端不持久持钥）。非加密对话 getCachedKConv 返回 null，自然跳过。 */
async function buildResumeKeyWire(
  session: Session,
  conversationId: string
): Promise<{ k_conv_wire?: string; k_agent_wire?: string }> {
  const kConv = getCachedKConv(conversationId);
  if (!kConv) return {};
  try {
    const pub = await getTransportPubkeyMobile(session.server_base_url);
    const out: { k_conv_wire?: string; k_agent_wire?: string } = {
      k_conv_wire: wrapKConvForWire(kConv, pub),
    };
    // 绑定加密 agent 的对话：续起 run 入口还需 k_agent_wire 才能解 agent 绑定，缺则 server unwrap 400、
    // 续起 run 静默不执行 —— 正是 Mobile 点选择题(ask_user_question)/安全确认提交后对话不继续的根因
    // （Web Chat.jsx 提交 ask/safety 都带 k_agent_wire，Mobile 这条 resume-wire 漏了）。与授权决策同款解析。
    const agentWire = await resolveRequesterAgentWire(session, conversationId, pub);
    if (agentWire) out.k_agent_wire = agentWire;
    return out;
  } catch (e) {
    console.warn('[resume-key-wire] wrap K_conv/K_agent failed:', (e as Error)?.message || e);
    return {};
  }
}

export async function submitSafetyDecision(
  session: Session,
  conversationId: string,
  reviewId: string,
  decision: 'approve' | 'reject'
): Promise<void> {
  const base = session.server_base_url;
  const _wire = await buildResumeKeyWire(session, conversationId);
  const res = await fetchWithDebugLog(
    `${base}api/conversations/${conversationId}/safety/decision`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ review_id: reviewId, decision, ..._wire }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `提交确认失败: ${res.status}`);
  }
}

/** 提交 ask_user_question 的用户选择，解阻塞正在等待的本轮 run（answers=[{header,question,answer}]）。 */
export async function answerAskUserQuestion(
  session: Session,
  conversationId: string,
  answers: { header?: string; question?: string; answer: string }[]
): Promise<void> {
  const base = session.server_base_url;
  const _wire = await buildResumeKeyWire(session, conversationId);
  const res = await fetchWithDebugLog(
    `${base}api/conversations/${conversationId}/ask/answer`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ answers, ..._wire }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `提交选择失败: ${res.status}`);
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

export type ProviderKeyStatus = Record<string, { configured?: boolean; hint?: string }>;
export type OfficialSubscriptionInfo = {
  subscribed?: boolean;
  tier?: string;
  tier_label?: string;
  package_market_ids?: string[];
  owner?: string;
};

export type ModelsConfigResponse = {
  selected_model?: string;
  selected_model_label?: string;
  /** label -> model id（`<owner>:<market_id>` 形态），与 Web/Desktop 一致 */
  available_models?: Record<string, string>;
  all_models?: Record<string, string>;
  /** market_id -> 价格 / 思考强度 / 能力（已剥 owner，查表前先 marketIdOf） */
  model_price_reference?: Record<string, unknown>;
  model_thinking_strengths?: Record<string, unknown>;
  model_capabilities?: Record<string, unknown>;
  allowlist_ids?: string[];
  allowlist_provider_keys?: string[];
  allowlist_provider_catalog?: { key: string; label: string }[];
  /** BYOK：每供应商是否已配 key + 末 4 位掩码 */
  provider_key_status?: ProviderKeyStatus;
  /** 官方精选套餐订阅状态 */
  official_subscription?: OfficialSubscriptionInfo;
  default_model?: string;
  /** POST /models/select 带 conversation_id 时回显：本次写入的对话级模型 */
  conversation_id?: string;
  conversation_model?: string;
};

/** 模型 id 为 `<owner>:<market_id>`；按「首个冒号且左侧无斜杠」切分（与后端一致）。 */
export function marketIdOf(modelId: string): string {
  const s = String(modelId || '').trim();
  if (!s) return '';
  const i = s.indexOf(':');
  if (i > 0 && s.slice(0, i).indexOf('/') === -1) return s.slice(i + 1);
  return s;
}

const OFFICIAL_OWNER = 'flops_official';

/** 取 owner 部分（剥 market_id）；与 marketIdOf 互补，按同一切分规则。 */
export function ownerOf(modelId: string): string {
  const s = String(modelId || '').trim();
  if (!s) return '';
  const i = s.indexOf(':');
  if (i > 0 && s.slice(0, i).indexOf('/') === -1) return s.slice(0, i);
  return '';
}

/**
 * 与后端 `_get_allowlist_provider_key` / FlopsWeb `getAllowlistProviderKeyFromModelId` 一致：
 * 资源节点 flops/→flops；官方 owner→official；其余按 market 路由首段；兜底 other。
 */
export function getAllowlistProviderKeyFromModelId(modelId: string): string {
  if (!modelId || typeof modelId !== 'string') return 'other';
  const owner = ownerOf(modelId);
  const market = marketIdOf(modelId);
  if (market.startsWith('flops/')) return 'flops';
  if (owner === OFFICIAL_OWNER) return 'official';
  if (market.startsWith('openrouter/')) return 'openrouter';
  if (market.startsWith('minimax/')) return 'minimax';
  if (market.startsWith('dashscope/')) return 'dashscope';
  if (market.startsWith('deepseek/')) return 'deepseek';
  if (market.startsWith('boundlessai/')) return 'boundlessai';
  if (market.startsWith('aiprimetech/')) return 'aiprimetech';
  if (market.startsWith('bailianplan/')) return 'bailianplan';
  if (market.startsWith('zhipu/')) return 'zhipu';
  return 'other';
}

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

/**
 * POST /api/models/select — 返回完整模型配置 payload。
 * 双语义端点（与后端 set_model_config 一致）：
 *   - 带 conversation_id → 只改该对话的模型（对话级覆盖，可中途切换），回显 conversation_model；
 *   - 不带 → 改用户级默认模型（新对话创建时的种子）。
 * 跑对话时服务端优先读对话 meta 的 model，所以在已有对话里切模型**必须**带 conversationId，
 * 否则只写了用户默认、压不过对话级覆盖（表现为"切了模型没生效"）。
 */
export async function selectModel(
  session: Session,
  model: string,
  conversationId?: string
): Promise<ModelsConfigResponse> {
  const base = session.server_base_url;
  const m = String(model || '').trim();
  const cid = String(conversationId || '').trim();
  const res = await fetchWithDebugLog(`${base}api/models/select`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify(cid ? { model: m, conversation_id: cid } : { model: m }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `切换模型失败: ${res.status}`);
  }
  return (await res.json()) as ModelsConfigResponse;
}

/** POST /api/models/provider_key — 配置/清除自己某供应商的 API key（BYOK）。apiKey 为空串=清除。 */
export async function setProviderKey(
  session: Session,
  provider: string,
  apiKey: string,
): Promise<ModelsConfigResponse> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/models/provider_key`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: String(provider || '').trim(), api_key: apiKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `保存 API Key 失败: ${res.status}`);
  }
  return (await res.json()) as ModelsConfigResponse;
}

/**
 * POST /api/models/allowlist — 设置模型白名单（打勾列表）。body `{ model_ids }`，返回完整模型配置 payload。
 * model_ids 为完整 `<owner>:<market_id>` 形态；后端会拒绝空列表，调用方需保证至少留一个。
 */
export async function setModelAllowlist(
  session: Session,
  modelIds: string[],
): Promise<ModelsConfigResponse> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/models/allowlist`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_ids: modelIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `保存模型白名单失败: ${res.status}`);
  }
  return (await res.json()) as ModelsConfigResponse;
}

/**
 * POST /api/models/provider_allowlist — 设置供应商 allowlist（启用哪些供应商）。
 * body `{ providers }`（model_id 前缀段，如 openrouter/flops/official）；后端拒绝空列表。
 */
export async function setProviderAllowlist(
  session: Session,
  providers: string[],
): Promise<ModelsConfigResponse> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/models/provider_allowlist`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `保存供应商白名单失败: ${res.status}`);
  }
  return (await res.json()) as ModelsConfigResponse;
}

/**
 * POST /api/models/provider_key/test — 测试某供应商 key 的连通性（不落库）。
 * apiKey 传空串时后端用已存的老 key 测，所以允许空。返回 { ok, message }。
 */
export async function testProviderKey(
  session: Session,
  provider: string,
  apiKey: string,
): Promise<{ ok: boolean; message: string }> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/models/provider_key/test`, {
    method: 'POST',
    headers: { ...authHeaders(session.access_token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: String(provider || '').trim(), api_key: apiKey }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    message?: string;
    detail?: string;
  };
  if (!res.ok) {
    throw new Error(data.detail || data.message || `测试失败: ${res.status}`);
  }
  return {
    ok: !!data.ok,
    message: data.message || (data.ok ? '连接成功' : '连接失败'),
  };
}

/* ============================================================
 * FlowDoc 文档树 + 快照
 *   - 树：GET /api/flowdoc/tx/tree（Flops 代理到 FlowDoc /api/tree/tree）
 *   - 快照：GET /api/flowdoc/doc/{doc_id}/snapshot（二进制 Y.Doc）
 *   两条都走 Flops，无需配置额外的 FlowDoc 域名 / 鉴权头。
 * ============================================================ */

export type FlowDocTreeItem = {
  id: string;
  name?: string | null;
  /** 'folder' / 'doc' / 'cooperateInbox'；其它类型容错保留字符串原值 */
  type: string;
  parentId?: string | null;
  children?: string[];
  level?: number;
  /** 文档是否为空（无正文）。后端 tree 返回；!== false 视为空（与 web 一致），用于切换文档图标。 */
  isEmpty?: boolean;
  accessRole?: 'owner' | 'collaborator';
  ownerNickname?: string | null;
  ownerUserId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
};

export async function getFlowDocTree(session: Session): Promise<FlowDocTreeItem[]> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/flowdoc/tx/tree`, {
    method: 'GET',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`获取 FlowDoc 文档树失败: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { ok?: boolean; tree?: FlowDocTreeItem[]; error?: string };
  if (data?.ok === false) throw new Error(data.error || '获取 FlowDoc 文档树失败');
  return Array.isArray(data?.tree) ? data.tree : [];
}

/** paper 文档的 arXiv HTML（经 Flops 代理 flowdoc-server /api/paper/fetch-arxiv-html）。
 *  - variant='processed'：后处理正文（含合并 CSS、参考文献），适合阅读；'raw'：处理前快照
 *  - cacheOnly=true：只读服务端缓存，无缓存返回 {ok:true, cache_miss:true, html:''}，不触发爬取
 *  - forceRefresh=true：重新爬取（慢）
 *  返回的 html 直接喂 WebView（移动端 viewer，不做 web 的 Shadow DOM 注入）。 */
export type PaperArxivHtmlResult = {
  ok: boolean;
  html: string;
  cacheMiss: boolean;
  error?: string;
};
export async function fetchPaperArxivHtml(
  session: Session,
  opts: {
    itemId: string;
    variant?: 'processed' | 'raw';
    cacheOnly?: boolean;
    forceRefresh?: boolean;
  },
): Promise<PaperArxivHtmlResult> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(`${base}api/paper/fetch-arxiv-html`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      item_id: opts.itemId,
      full_html: true,
      variant: opts.variant ?? 'processed',
      cache_only: opts.cacheOnly ?? false,
      force_refresh: opts.forceRefresh ?? false,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false) {
    const err =
      (typeof data.error === 'string' && data.error) ||
      (typeof data.detail === 'string' && data.detail) ||
      `HTTP ${res.status}`;
    return { ok: false, html: '', cacheMiss: false, error: err };
  }
  const html =
    (typeof data.html === 'string' && data.html) ||
    (typeof data.html_preview === 'string' && data.html_preview) ||
    '';
  return { ok: true, html, cacheMiss: Boolean(data.cache_miss) };
}

/** 取单个 item 的标题（代理 flowdoc-server GET /api/tree/item/{id}，只回 name）。
 *  用于 paper 锚点 subdoc 的 tab 标签——subdoc 引用只有 {id,type}，名字要另取。 */
export async function getFlowDocItemName(
  session: Session,
  docId: string,
): Promise<string | null> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(
    `${base}api/flowdoc/tree/item/${encodeURIComponent(docId)}`,
    { method: 'GET', headers: authHeaders(session.access_token) },
  );
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (data.success === false) return null;
  return typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
}

/** 返回 Y.Doc 二进制快照。404 时返回 null（文档存在于树但尚无 snapshot：新建未输入文字的状态）。 */
export async function getFlowDocSnapshot(
  session: Session,
  docId: string,
): Promise<Uint8Array | null> {
  const base = session.server_base_url;
  const res = await fetchWithDebugLog(
    `${base}api/flowdoc/doc/${encodeURIComponent(docId)}/snapshot`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access_token}` },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`获取 FlowDoc 快照失败: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
