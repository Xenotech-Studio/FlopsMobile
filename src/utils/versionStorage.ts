import AsyncStorage from '@react-native-async-storage/async-storage';

const LAST_LAUNCHED_VERSION_KEY = '@FlopsMobile/lastLaunchedVersion';

/**
 * 解析版本号为数字数组以便比较（如 "1.2.3" -> [1, 2, 3]）
 */
function parseVersion(version: string): number[] {
  const parts = (version || '0').trim().split('.');
  return parts.map((p) => {
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/**
 * 比较两个版本号。
 * @returns 1 表示 current > previous（升级），-1 表示 current < previous（降级），0 表示相同
 */
export function compareVersions(current: string, previous: string): 1 | -1 | 0 {
  const a = parseVersion(current);
  const b = parseVersion(previous);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export async function getLastLaunchedVersion(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_LAUNCHED_VERSION_KEY);
}

export async function setLastLaunchedVersion(version: string): Promise<void> {
  await AsyncStorage.setItem(LAST_LAUNCHED_VERSION_KEY, version.trim());
}
