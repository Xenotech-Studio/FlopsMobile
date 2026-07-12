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
  getPendingDeepLink(): Promise<{ payload: ApnsDeepLinkPayload | null }>;
};

/** push_event 注入到 APNs payload 里的字段（除 aps 之外）。 */
export type ApnsDeepLinkKind = 'need_confirm' | 'turn_done' | 'turn_failed';
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
