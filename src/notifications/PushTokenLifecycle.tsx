/**
 * APNs token 自动同步组件：
 *
 * - 仅 iOS 生效；放在 App 根（SessionProvider 内）即可。
 * - 仅当本地偏好 `push_enabled = true` 且 iOS 权限已授权时才工作；
 *   不会主动弹任何权限框或 UI（弹框由账户页 toggle 触发）。
 * - 启动 + 每次回前台：
 *   1. 读 `pushSettings.getPushEnabled()` + `getApnsAuthorizationStatus()`
 *   2. 若 toggle on 但 iOS 权限被用户在系统设置里关闭 → 把本地 toggle 也置 off，避免视觉错位
 *   3. 若 toggle on 且已授权 → 静默调 `registerSilently`（不弹框）+ 拉缓存 token 上报
 *   4. 监听 `onAPNsToken` 事件（Apple 偶尔 rotate token）→ 即时上报
 *
 * 主动权限申请由账户页「接收推送通知」toggle 触发，本组件只做被动同步。
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useSession } from '../context/SessionContext';
import { registerApnsToken } from '../api/push';
import {
  isApnsSupported,
  getApnsAuthorizationStatus,
  registerApnsSilently,
  getCachedDeviceToken,
  getApnsTopic,
  getDeviceIdentity,
  addApnsTokenListener,
} from './apnsClient';
import { getPushEnabled, setPushEnabled } from './pushSettings';

/**
 * 电脑端 mic 菜单展示名：设备名基底 + env/build 标记。
 * iOS 16+ 无 user-assigned-device-name 授权时 deviceName 只是机型名（如「iPhone」），同一台机上
 * dev + release 两个 build 会拿到两条 token / 两个展示名相同 —— 折进标记后成「iPhone · dev」/
 * 「iPhone · prod」互相可辨。env（sandbox/production）与 build（__DEV__）常一一对应（debug→sandbox /
 * release→production），一致时只显示 build；不一致（少见）时两个都带上。
 */
function buildDeviceLabel(baseName: string, env: 'sandbox' | 'production'): string {
  const base = (baseName || '').trim() || 'iPhone';
  const build = __DEV__ ? 'dev' : 'prod';
  const envShort = env === 'sandbox' ? 'dev' : 'prod';
  const tag = build === envShort ? build : `${build}/${envShort}`;
  return `${base} · ${tag}`;
}

export function PushTokenLifecycle(): null {
  const { session, serverBaseUrl } = useSession();
  const lastSyncedRef = useRef<string>('');

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (!isApnsSupported()) return;
    if (!session) return;

    let cancelled = false;

    const syncToken = async (token: string, env: 'sandbox' | 'production') => {
      const sig = `v2|${token}|${env}`;
      if (sig === lastSyncedRef.current) return;
      try {
        const topic = await getApnsTopic();
        const identity = await getDeviceIdentity();
        await registerApnsToken(serverBaseUrl, session.access_token, {
          device_token: token,
          env,
          topic,
          device_name: buildDeviceLabel(identity.deviceName, env),
          identifier_for_vendor: identity.identifierForVendor || undefined,
        });
        if (!cancelled) lastSyncedRef.current = sig;
      } catch (e) {
        if (__DEV__) console.warn('[PushTokenLifecycle] sync failed:', e);
      }
    };

    const tryRefresh = async () => {
      const enabled = await getPushEnabled();
      if (!enabled) return;
      const status = await getApnsAuthorizationStatus();
      // 用户在 iOS 系统设置里关掉了通知权限：本地 toggle 也跟着 off，避免 UI 状态错位。
      // 后端 token 不主动删（用户可能只是临时静音；下次 toggle on 时会重新上报覆盖）。
      if (status === 'denied') {
        await setPushEnabled(false);
        return;
      }
      if (status !== 'authorized' && status !== 'provisional' && status !== 'ephemeral') {
        return;
      }
      await registerApnsSilently().catch(() => {});
      const cached = await getCachedDeviceToken();
      if (cancelled) return;
      if (cached.ok) await syncToken(cached.token, cached.env);
    };

    const unsub = addApnsTokenListener((e) => {
      void syncToken(e.token, e.env);
    });

    void tryRefresh();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void tryRefresh();
    });

    return () => {
      cancelled = true;
      unsub();
      appStateSub.remove();
    };
  }, [session, serverBaseUrl]);

  return null;
}
