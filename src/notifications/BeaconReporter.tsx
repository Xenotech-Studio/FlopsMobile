/**
 * 设备信标（beacon）上报 —— AppState → 服务端设备级在线目录。**四端统一系统的移动端。**
 *
 * 与 PresenceReporter 的区别：
 * - PresenceReporter：**iOS 专用**、**用户级** foreground/background，只为压 APNs 推送。保留不动。
 * - BeaconReporter：**iOS + Android 都跑**、**设备级**（device_id = {platform}_{clientInstanceId}），
 *   独立于推送。喂养 remote_mic 的 /phones —— Android 因此首次进设备列表。
 *
 * 行为：
 * - 有 session 即上报（不依赖推送权限 / APNs）。
 * - 前台：立即 ping{state:foreground} + 每 30s 心跳（服务端记录 TTL 75s，2.5 拍容差）。
 * - 转后台 / inactive：**leave**（移动端后台即丢 inbox SSE → 不再 SSE 可达，立刻从在线集合消失；
 *   iOS 仍可经 APNs 唤醒，Android 则从 /phones 消失 —— 诚实反映不可达）。
 * - 登出 / 卸载：leave。
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { useSession } from '../context/SessionContext';
import { beaconPing, beaconLeave, type BeaconPlatform } from '../api/beacon';
import { getBeaconDeviceId } from '../utils/clientInstanceId';
import { getDeviceIdentity } from './apnsClient';

const HEARTBEAT_MS = 30 * 1000;

type BeaconIdentity = {
  deviceId: string;
  platform: BeaconPlatform;
  deviceName: string;
  idfv: string;
};

/** Android 设备名：零依赖走 Platform.constants（Brand + Model，如「Google Pixel 7」）。 */
function androidDeviceName(): string {
  const c = (Platform.constants || {}) as { Model?: string; Brand?: string };
  const model = (c.Model || '').trim();
  const brand = (c.Brand || '').trim();
  if (model && brand && !model.toLowerCase().startsWith(brand.toLowerCase())) {
    return `${brand} ${model}`;
  }
  return model || brand || 'Android';
}

async function resolveIdentity(): Promise<BeaconIdentity> {
  const deviceId = await getBeaconDeviceId();
  if (Platform.OS === 'ios') {
    const id = await getDeviceIdentity();
    return {
      deviceId,
      platform: 'ios',
      deviceName: (id.deviceName || '').trim() || 'iPhone',
      idfv: id.identifierForVendor || '',
    };
  }
  return { deviceId, platform: 'android', deviceName: androidDeviceName(), idfv: '' };
}

export function BeaconReporter(): null {
  const { session, serverBaseUrl } = useSession();
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const identityRef = useRef<BeaconIdentity | null>(null);

  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    const stopHeartbeat = () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };

    const ensureIdentity = async (): Promise<BeaconIdentity | null> => {
      if (identityRef.current) return identityRef.current;
      const ident = await resolveIdentity();
      if (cancelled) return null;
      identityRef.current = ident;
      return ident;
    };

    const ping = async (state: 'foreground' | 'background') => {
      const ident = await ensureIdentity();
      if (!ident || cancelled) return;
      void beaconPing(serverBaseUrl, session.access_token, {
        device_id: ident.deviceId,
        platform: ident.platform,
        device_name: ident.deviceName,
        state,
        identifier_for_vendor: ident.idfv || undefined,
      });
    };

    // 下线不受 cancelled 拦（cleanup 时也要发出去）：用已缓存身份即时 leave；缓存缺失才解析一次。
    const leave = async () => {
      const ident = identityRef.current || (await resolveIdentity().catch(() => null));
      if (!ident) return;
      void beaconLeave(serverBaseUrl, session.access_token, ident.deviceId);
    };

    const apply = (status: AppStateStatus) => {
      if (status === 'active') {
        void ping('foreground');
        stopHeartbeat();
        heartbeatRef.current = setInterval(() => {
          void ping('foreground');
        }, HEARTBEAT_MS);
      } else {
        stopHeartbeat();
        void leave();
      }
    };

    apply(AppState.currentState);
    const sub = AppState.addEventListener('change', apply);

    return () => {
      cancelled = true;
      stopHeartbeat();
      sub.remove();
      void leave();
    };
  }, [session, serverBaseUrl]);

  return null;
}
