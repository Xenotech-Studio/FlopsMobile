/**
 * APNs token 自动同步组件：
 *
 * - 仅 iOS 生效；放在 App 根（SessionProvider 内）即可。
 * - 已有 session 时，如果 AppDelegate 已经拿到 token（缓存版本），
 *   后台静默上报一次；不会主动弹权限框（避免打扰）。
 * - 监听后续 token 刷新事件并即时同步。
 *
 * 主动权限申请由设置页「登记推送令牌（APNs）」按钮触发，本组件只做被动同步。
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useSession } from '../context/SessionContext';
import { registerApnsToken } from '../api/push';
import {
  isApnsSupported,
  getCachedDeviceToken,
  addApnsTokenListener,
} from './apnsClient';

export function PushTokenLifecycle(): null {
  const { session, serverBaseUrl } = useSession();
  const lastSyncedRef = useRef<string>('');

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (!isApnsSupported()) return;
    if (!session) return;

    let cancelled = false;

    const syncToken = async (token: string, env: 'sandbox' | 'production') => {
      const sig = `${token}|${env}`;
      if (sig === lastSyncedRef.current) return;
      try {
        await registerApnsToken(serverBaseUrl, session.access_token, {
          device_token: token,
          env,
        });
        if (!cancelled) lastSyncedRef.current = sig;
      } catch (e) {
        if (__DEV__) console.warn('[PushTokenLifecycle] sync failed:', e);
      }
    };

    void getCachedDeviceToken().then((cached) => {
      if (!cached || cancelled) return;
      void syncToken(cached.token, cached.env);
    });

    const unsub = addApnsTokenListener((e) => {
      void syncToken(e.token, e.env);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [session, serverBaseUrl]);

  return null;
}
