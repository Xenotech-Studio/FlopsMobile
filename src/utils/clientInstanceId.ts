/**
 * 与 FlowTask Web `mutationMeta.js` 的 client_instance_id 对齐：稳定实例 ID，用于 WS 与协作过滤。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const KEY = '@FlopsMobile/flowtask_client_instance_id';

let memoryCached: string | null = null;
let pending: Promise<string> | null = null;

function generateClientInstanceId(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  /* UUID v4 variant bits */
  // eslint-disable-next-line no-bitwise -- RFC 4122 version/variant fields
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // eslint-disable-next-line no-bitwise
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getOrCreateClientInstanceId(): Promise<string> {
  if (memoryCached) return Promise.resolve(memoryCached);
  if (pending) return pending;
  pending = (async () => {
    try {
      const existing = await AsyncStorage.getItem(KEY);
      const id = existing ?? generateClientInstanceId();
      if (!existing) await AsyncStorage.setItem(KEY, id);
      memoryCached = id;
      return id;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/**
 * 设备信标（beacon）身份：`{platform}_{clientInstanceId}`，四端统一格式（见 backend/routers/beacon.py）。
 * 复用已持久化的 clientInstanceId 作 uuid 段 —— 不新铸一份，避免同一 install 出现两个身份。
 * dev / prod 是两个独立 install（各自的 AsyncStorage），会得到不同 device_id；presence 上报已在
 * BeaconReporter 里对 __DEV__ 整段跳过（dev 版不进设备目录），故同机双 build 不再重复留记录。
 */
export async function getBeaconDeviceId(): Promise<string> {
  const cid = await getOrCreateClientInstanceId();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  return `${platform}_${cid}`;
}
