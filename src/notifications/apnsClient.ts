/**
 * iOS APNs 原生模块包装：与 ios/FlopsMobile/FlopsPushModule.swift 对齐。
 *
 * - requestApnsPermission：弹系统权限框 + registerForRemoteNotifications。
 * - getApnsAuthorizationStatus：查权限状态。
 * - getCachedDeviceToken：若 AppDelegate 已拿到 token 则立即返回；否则 reject。
 * - addApnsTokenListener：订阅 token 变更事件（Apple 偶发刷新 token 时再次回流）。
 *
 * Android 上调用任意方法都返回 unsupported；调用方需先按 Platform 判断。
 */

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { sha256Hex } from '../utils/sha256Hex';

export type ApnsAuthStatus =
  | 'notDetermined'
  | 'denied'
  | 'authorized'
  | 'provisional'
  | 'ephemeral'
  | 'unknown'
  | 'unsupported';

type FlopsPushModuleType = {
  requestPermission(): Promise<{ granted: boolean; registered: boolean }>;
  getAuthorizationStatus(): Promise<{ status: string }>;
  registerSilently(): Promise<{ status: string; registered: boolean }>;
  getDeviceToken(): Promise<{ token: string; env: 'sandbox' | 'production' }>;
  getBundleIdentifier(): Promise<{ bundleId: string }>;
  getDeviceInfo(): Promise<{ deviceName: string; identifierForVendor: string }>;
  getPendingDeepLink(): Promise<{ payload: ApnsDeepLinkPayload | null }>;
};

/** push_event 注入到 APNs payload 里的字段（除 aps 之外）。 */
export type ApnsDeepLinkKind = 'need_confirm' | 'turn_done' | 'turn_failed' | 'remote_mic_invite';
export type ApnsDeepLinkPayload = {
  kind: ApnsDeepLinkKind | string;
  conversation_id?: string;
  review_id?: string;
  tool_name?: string;
  decision?: string;
  duration_ms?: number;
  ts?: number;
  [k: string]: unknown;
};

const FlopsPushModule: FlopsPushModuleType | undefined = (NativeModules as any).FlopsPushModule;

const isIOS = Platform.OS === 'ios';
const emitter = isIOS && FlopsPushModule
  ? new NativeEventEmitter(FlopsPushModule as any)
  : null;

export type ApnsTokenEvent = { token: string; env: 'sandbox' | 'production' };
export type ApnsErrorEvent = { error: string };

export function isApnsSupported(): boolean {
  return isIOS && !!FlopsPushModule;
}

export async function requestApnsPermission(): Promise<{ granted: boolean; registered: boolean }> {
  if (!FlopsPushModule) return { granted: false, registered: false };
  return FlopsPushModule.requestPermission();
}

export async function getApnsAuthorizationStatus(): Promise<ApnsAuthStatus> {
  if (!FlopsPushModule) return 'unsupported';
  const r = await FlopsPushModule.getAuthorizationStatus();
  return r.status as ApnsAuthStatus;
}

/**
 * 已授权时静默调用 `registerForRemoteNotifications`（不弹权限框）。
 * - 用于 app 启动 / 回前台时根据「本地 toggle + iOS 权限」的自动续注册。
 * - 未授权时不弹任何 UI，仅返回当前状态，由调用方（如设置页 toggle）决定下一步。
 */
export async function registerApnsSilently(): Promise<{ status: ApnsAuthStatus; registered: boolean }> {
  if (!FlopsPushModule) return { status: 'unsupported', registered: false };
  const r = await FlopsPushModule.registerSilently();
  return { status: r.status as ApnsAuthStatus, registered: !!r.registered };
}

export type DeviceTokenResult =
  /** 已拿到 token */
  | { ok: true; token: string; env: 'sandbox' | 'production' }
  /** 原生 didFailToRegisterForRemoteNotificationsWithError 的真实原因 */
  | { ok: false; kind: 'register_failed'; error: string }
  /** 还未注册或注册中（再等一下） */
  | { ok: false; kind: 'pending' };

export async function getCachedDeviceToken(): Promise<DeviceTokenResult> {
  if (!FlopsPushModule) return { ok: false, kind: 'register_failed', error: 'unsupported_platform' };
  try {
    const r = await FlopsPushModule.getDeviceToken();
    return { ok: true, token: r.token, env: r.env };
  } catch (e: any) {
    const code: string = e?.code || 'unknown';
    const msg: string = e?.message || String(e);
    if (code === 'no_token') return { ok: false, kind: 'pending' };
    return { ok: false, kind: 'register_failed', error: `${code}: ${msg}` };
  }
}

/**
 * 本机 APNs device token 的 hash（sha256 前 16 位），与服务端 remote_mic.token_hash 同算法
 * （电脑选设备、下发 remote_mic_invite 时用它指代目标手机）。用于前台 inbox SSE 邀请通道的
 * device 定向过滤：SSE 是用户级广播，多设备/多手机都会收到同一帧，只有 hash 对得上的那台该弹卡片。
 * 非 iOS（无 APNs token）/ 尚未注册 → 返回 null（收到带 hash 的邀请即静默丢弃，本机不是目标）。
 * 每次现算：invite 罕见（用户手动发起）且此路径本机处于前台、token 早已缓存，无需缓存反被 token
 * rotation 弄脏。
 */
export async function getOwnApnsTokenHash(): Promise<string | null> {
  if (!isIOS || !FlopsPushModule) return null;
  const r = await getCachedDeviceToken();
  if (!r.ok) return null;
  const full = await sha256Hex(r.token);
  return full ? full.slice(0, 16) : null;
}

/**
 * 本 app 的 bundle identifier（= APNs topic）。dev build 是 com.xenotech.FlopsMobile.dev，
 * release 是 com.xenotech.FlopsMobile。注册 token 时随 payload 上报，后端据此逐条推。
 * 运行期不变，缓存一次即可。拿不到（非 iOS / 原生异常）返回 undefined，让后端 fallback 到默认 topic。
 */
let cachedApnsTopic: string | undefined;
export async function getApnsTopic(): Promise<string | undefined> {
  if (cachedApnsTopic) return cachedApnsTopic;
  if (!FlopsPushModule) return undefined;
  try {
    const r = await FlopsPushModule.getBundleIdentifier();
    cachedApnsTopic = r?.bundleId || undefined;
    return cachedApnsTopic;
  } catch {
    return undefined;
  }
}

/**
 * 本机设备身份（展示名 + identifierForVendor）：注册 token 时随 payload 上报，供电脑端 mic 菜单
 * 区分/去重多台手机。
 * - deviceName：iOS 16+ 无授权时是机型名（如「iPhone」），仅作展示名的基底；真正区分 dev/prod
 *   由 PushTokenLifecycle 折进 env/build 标记。
 * - identifierForVendor：同机 dev/prod 双 build 共享，后端 /phones 按它把同一台物理机折成一条。
 * 运行期不变，缓存一次即可。非 iOS / 原生未重编（老二进制无 getDeviceInfo）→ 返回空串，
 * 后端据「无 identifier_for_vendor」保持旧行为不去重。
 */
export type DeviceIdentity = { deviceName: string; identifierForVendor: string };

/**
 * 电脑端 mic 菜单展示名（iOS）：机型全名（getDeviceInfo 现返回如「iPhone 16 Pro Max」），空则兜底泛称
 * 「iPhone」。beacon（在线）与 APNs token（可唤醒）两条上报路径共用它 —— 保证同一台机在两种状态下
 * 展示名一致（历史上 token 侧曾额外折进 · dev/prod 后缀，导致两态不一致；现统一去掉，靠机型全名 +
 * 后端 identifierForVendor 去重即可辨识）。
 * dev build（com.flopsmobile.dev）与 release 是两个独立 install，会各自上报一条 presence；给 dev 的
 * 展示名统一加「 (DEV)」后缀，一眼区分同机的两条记录（beacon / token 两路都过这里，仍保持一致）。
 */
export function iosDisplayName(rawDeviceName: string): string {
  const name = (rawDeviceName || '').trim() || 'iPhone';
  return __DEV__ ? `${name} (DEV)` : name;
}

let cachedDeviceIdentity: DeviceIdentity | undefined;
export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  if (cachedDeviceIdentity) return cachedDeviceIdentity;
  if (!FlopsPushModule || typeof FlopsPushModule.getDeviceInfo !== 'function') {
    return { deviceName: '', identifierForVendor: '' };
  }
  try {
    const r = await FlopsPushModule.getDeviceInfo();
    cachedDeviceIdentity = {
      deviceName: r?.deviceName || '',
      identifierForVendor: r?.identifierForVendor || '',
    };
    return cachedDeviceIdentity;
  } catch {
    return { deviceName: '', identifierForVendor: '' };
  }
}

export function addApnsTokenListener(cb: (e: ApnsTokenEvent) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener('onAPNsToken', (e: ApnsTokenEvent) => cb(e));
  return () => sub.remove();
}

export function addApnsErrorListener(cb: (e: ApnsErrorEvent) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener('onAPNsRegisterError', (e: ApnsErrorEvent) => cb(e));
  return () => sub.remove();
}

/** 用户点开通知（热启动 / 后台→前台）时回流；冷启动场景见 getPendingApnsDeepLink。 */
export function addApnsDeepLinkListener(
  cb: (payload: ApnsDeepLinkPayload) => void,
): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener('onAPNsDeepLink', (payload: ApnsDeepLinkPayload) => {
    if (payload && typeof payload === 'object') cb(payload);
  });
  return () => sub.remove();
}

/** 冷启动时调用一次：把 RN bridge 起来之前的通知点击事件拉走（拉走后原生侧清空缓存）。 */
export async function getPendingApnsDeepLink(): Promise<ApnsDeepLinkPayload | null> {
  if (!FlopsPushModule) return null;
  try {
    const r = await FlopsPushModule.getPendingDeepLink();
    return r?.payload ?? null;
  } catch {
    return null;
  }
}
