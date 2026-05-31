/**
 * Flops 服务端 API 客户端（仅 chat 相关）
 * 与 FlopsDesktop 行为对齐：登录、会话、流式聊天、取消、安全确认。
 */
import { convProfileLog } from './debug/conversationLoadProfile';
import { fetchWithDebugLog } from './utils/httpDebugLog';
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
  wrapKConvForWire,
  decryptMessageLocal,
  decryptSseChunkLocal,
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
  | { type: 'tool_result'; tool_name: string; result: unknown; index?: number }
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

/** 当前用户信息（含头像、昵称、邮箱），来自 GET /api/user/{user_id} */
export type CurrentUserInfo = {
  id?: string;
  nickname?: string;
  avatarUrl?: string;
  email?: string;
  [key: string]: unknown;
};

/** /api/auth/config 返回：captcha 是否启用 */
export type AuthConfig = {
  captcha_enabled: boolean;
  captcha_app_id?: string | null;
};

/** GET /api/auth/config —— 前端启动 / 进入注册页时拉一次 */
export async function getAuthConfig(serverBaseUrl: string): Promise<AuthConfig> {
  const base = ensureSlash(serverBaseUrl);
  const res = await fetchWithDebugLog(`${base}api/auth/config`, { method: 'GET' });
  if (!res.ok) return { captcha_enabled: false };
  const data = (await res.json()) as Partial<AuthConfig>;
  return {
    captcha_enabled: Boolean(data.captcha_enabled),
    captcha_app_id: data.captcha_app_id ?? null,
  };
}

/** POST /api/auth/send_email_code */
export async function sendEmailCode(
  serverBaseUrl: string,
  email: string,
  accessToken?: string
): Promise<{ cooldown: number; code_ttl: number }> {
  const base = ensureSlash(serverBaseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchWithDebugLog(
    `${base}api/auth/send_email_code`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ email }),
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
  /** 当前生效的上下文摘要 id（若有则可能存在压缩分界展示） */
  active_context_summary_id?: string;
  context_summaries?: ContextSummary[];
  /** 上下文 L1 投影：主 system / 摘要注入 / 逐字尾 / 工具 schema 各自的 L1 字符数 + 上限。
   *  用于 composer 旁环形进度条算"上下文已用比例"。后端按需返回，缺省时退化用"消息条数已压缩"。 */
  context_projection_l1?: Record<string, unknown>;
};

/**
 * 获取对话列表：GET /api/conversations。
 * 列表里每条 encrypted conv 都带 (title_ciphertext, k_conv_blob)，用 K_user 派 K_conv
 * 后本地解出 title 写回。对齐 FlopsWeb `utils/convTitleDecrypt.js` 的语义。
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

  // 加密 conv title 本地解：K_user 缺失或单条解失败都保留原 title sentinel，不抛错
  try {
    const kUserStr = await getStoredKUser();
    if (kUserStr) {
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
          if (!kConv) continue;
          const blob = base64ToBytes(raw.title_ciphertext);
          const pt = aesGcmDecrypt(blob, kConv);
          const decoded = new TextDecoder().decode(pt);
          // server 把 title 当 JSON 字符串存进密文：`"foo"`，所以这里要 parse 一层
          raw.title = JSON.parse(decoded);
        } catch {
          // 单条解失败保留原 sentinel
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[conv list mobile] title decrypt batch failed:', (e as Error)?.message || e);
  }

  return { conversations: list };
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
  };
  const tParse = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // 加密对话：用本机 K_user 派生 K_conv 缓存 + 本地解密 messages + title
  if (conversation && conversation.encrypted && conversation.k_conv_blob) {
    try {
      let kConv = getCachedKConv(conversationId);
      if (!kConv) {
        const kUserStr = await getStoredKUser();
        if (kUserStr) {
          const kUserBytes = base64ToBytes(kUserStr);
          kConv = deriveKConvFromBlob(conversation.k_conv_blob, kUserBytes);
          setCachedKConv(conversationId, kConv);
        }
      }
      if (kConv) {
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
 * 创建会话：POST /api/conversations（可选 body.bound_agent_id，与 FlopsWeb 一致）
 */
export async function createConversation(
  session: Session,
  opts?: { bound_agent_id?: string; encrypted?: boolean }
): Promise<{ id: string }> {
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
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error('服务端未返回会话 id');
  // 创建成功后注册 K_conv 到 cache
  if (opts?.encrypted) {
    try {
      const pending = (body as Record<string, unknown>).__pending_kconv as Uint8Array | undefined;
      if (pending) setCachedKConv(data.id, pending);
    } catch { /* ignore */ }
  }
  return { id: data.id };
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

export type ChatV2StreamStart =
  | { tag: 'new_message'; message: string; flops_refs?: unknown[] }
  | { tag: 'regenerate'; after_user_index: number; message?: string; flops_refs?: unknown[] }
  | { tag: 'resume'; run_id: string };

export type StreamChatV2LoopOptions = {
  /** 返回 false 时停止循环（例如已切换对话） */
  isAlive?: () => boolean;
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
        // 加密对话：encrypted_chunk wrapper → 解出 inner JSON 再分发
        if (data && data.type === 'encrypted_chunk' && data.ciphertext) {
          const _kc = getCachedKConv(conversationId);
          if (_kc) {
            try {
              const innerStr = decryptSseChunkLocal(`data: ${jsonStr}\n\n`, _kc);
              if (innerStr && innerStr.startsWith('data: ')) {
                data = JSON.parse(
                  innerStr.slice('data: '.length).replace(/\n\n$/, '').trim()
                ) as typeof data;
              }
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[encrypted_chunk mobile] decrypt failed:', (e as Error)?.message || e);
              continue;
            }
          } else {
            // eslint-disable-next-line no-console
            console.warn('[encrypted_chunk mobile] no cached K_conv, skip');
            continue;
          }
        }
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
        }
        if (data.type === 'v2_run' && typeof (data as { run_id?: string }).run_id === 'string') {
          const rid = (data as { run_id: string }).run_id;
          if (rid) v2RunId = rid;
        }
        if (data.type === 'v2_reload_pending') {
          /* server SIGTERM 前主动通知：靠应用层事件让 client 立刻退出本次 reader 走 reconnect。
             把事件透传给上层 UI 显示「服务器热更新中…」（onEvent 处理者负责 UI）。 */
          // eslint-disable-next-line no-console
          console.warn('[chat_v2 mobile] server reload pending, will reconnect');
          onEvent(data as ChatStreamEvent);
          return;
        }
        if (data.type === 'v2_step_rollback') {
          /* server reload 后 resume worker 重跑当前 step 前发此事件——上层 UI 应清掉本 step
             已显示的 partial blocks，避免 LLM 重生成内容与旧 partial 重复。 */
          onEvent(data as ChatStreamEvent);
          continue;
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
      body = {
        message: start.message,
        ...(Array.isArray(start.flops_refs) && start.flops_refs.length > 0
          ? { flops_refs: start.flops_refs }
          : {}),
      };
    } else if (start.tag === 'regenerate') {
      body = {
        regenerate: true,
        after_user_index: start.after_user_index,
        ...(typeof start.message === 'string' && start.message.length > 0 ? { message: start.message } : {}),
        ...(Array.isArray(start.flops_refs) && start.flops_refs.length > 0
          ? { flops_refs: start.flops_refs }
          : {}),
      };
    } else {
      body = { subscribe_only: true, run_id: v2RunId, replay_from: 0 };
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
