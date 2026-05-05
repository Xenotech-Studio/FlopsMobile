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

type FlopsPushModuleType = {
  requestPermission(): Promise<{ granted: boolean; registered: boolean }>;
  getAuthorizationStatus(): Promise<{ status: string }>;
  getDeviceToken(): Promise<{ token: string; env: 'sandbox' | 'production' }>;
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

export async function getApnsAuthorizationStatus(): Promise<string> {
  if (!FlopsPushModule) return 'unsupported';
  const r = await FlopsPushModule.getAuthorizationStatus();
  return r.status;
}

export async function getCachedDeviceToken(): Promise<ApnsTokenEvent | null> {
  if (!FlopsPushModule) return null;
  try {
    return await FlopsPushModule.getDeviceToken();
  } catch {
    return null;
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
