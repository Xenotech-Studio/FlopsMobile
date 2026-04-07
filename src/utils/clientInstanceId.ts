/**
 * 与 FlowTask Web `mutationMeta.js` 的 client_instance_id 对齐：稳定实例 ID，用于 WS 与协作过滤。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

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
