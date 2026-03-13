/**
 * Android 应用更新 API（与 Flops 服务端 /api/android-update 对齐）
 * 用于检查更新、获取版本列表；下载使用返回的 url 或重定向地址。
 */
import { fetchWithDebugLog } from '../utils/httpDebugLog';

export type AndroidLatestRelease = {
  version: string;
  filename: string;
  url: string;
  size: number;
  release_date: string;
};

export type AndroidReleaseItem = {
  version: string;
  filename?: string;
  size?: number;
  uploaded_at?: string;
  release_date?: string;
  published?: boolean;
};

function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * 获取当前已发布的最新版本信息（用于检查更新）
 */
export async function getLatest(baseUrl: string): Promise<AndroidLatestRelease | null> {
  const url = buildUrl(baseUrl, '/api/android-update/latest');
  try {
    const res = await fetchWithDebugLog(url);
    if (!res.ok) return null;
    const data = (await res.json()) as AndroidLatestRelease;
    return data;
  } catch {
    return null;
  }
}

/**
 * 获取已发布版本列表（历史版本，用于展示）
 */
export async function getReleases(baseUrl: string): Promise<AndroidReleaseItem[]> {
  const url = buildUrl(baseUrl, '/api/android-update/releases');
  try {
    const res = await fetchWithDebugLog(url);
    if (!res.ok) return [];
    const data = (await res.json()) as AndroidReleaseItem[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * 比较版本号，返回 1 表示 a > b，-1 表示 a < b，0 表示相等
 */
export function compareVersions(a: string, b: string): number {
  const toParts = (v: string) =>
    (v || '0')
      .trim()
      .split('.')
      .map((s) => parseInt(s, 10) || 0);
  const pa = toParts(a);
  const pb = toParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
