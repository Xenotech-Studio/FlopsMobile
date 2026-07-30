/**
 * 设备信标（beacon）上报 API（与 backend/routers/beacon.py 对齐）。
 *
 * 「有 session 即上报」的设备级在线目录，**独立于推送**：前台/可达时周期性 ping 刷新一条带 TTL
 * 的记录，转后台/退出时 leave。喂养 remote_mic 的 /phones（Android 由此进列表）。
 * APNs 推送抑制也读这份设备级 presence（旧的用户级 /api/push/apns/presence 已删）。
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

export type BeaconPlatform = 'ios' | 'android' | 'desktop' | 'web';

export type BeaconPingPayload = {
  device_id: string;
  platform: BeaconPlatform;
  device_name?: string;
  state?: string; // foreground | background（信息位，不参与在线判定）
  identifier_for_vendor?: string; // iOS：同机 dev/prod 去重
  app_version?: string;
};

/** 心跳 + 登记（幂等）。失败不致命：TTL 到期后服务端记录自动过期 == 离线。 */
export async function beaconPing(
  baseUrl: string,
  accessToken: string,
  payload: BeaconPingPayload,
): Promise<void> {
  await fetchWithDebugLog(buildUrl(baseUrl, '/api/beacon/ping'), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(payload),
  }).catch(() => {
    /* 上报失败不致命 */
  });
}

/** 干净下线（转后台 / 登出）。失败不致命：不 leave 也会在 ~75s 后 TTL 过期。 */
export async function beaconLeave(
  baseUrl: string,
  accessToken: string,
  deviceId: string,
): Promise<void> {
  await fetchWithDebugLog(buildUrl(baseUrl, '/api/beacon/leave'), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ device_id: deviceId }),
  }).catch(() => {
    /* 下线失败不致命 */
  });
}
