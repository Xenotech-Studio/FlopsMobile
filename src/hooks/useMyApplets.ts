/**
 * useMyApplets —— 「我的小应用」在线偏好（服务端，跨设备同步）。
 *
 * 用户在 AppletScreen 底部 sheet 里「添加到我的小应用」的条目通过
 * GET/PUT /api/user/me/my-applets 持久化到服务端 Redis（按 user_id
 * 隔离），iOS / Android / Desktop 共享同一份列表。
 *
 * 用模块级共享缓存 + 订阅：所有 hook 实例共享同一份内存态，任一处
 * add/remove 立即同步到其它挂载中的组件。服务端只做落盘，内存态先行更新。
 */
import { useCallback, useEffect, useReducer } from 'react';
import { useSession } from '../context/SessionContext';

export type MyApplet = {
  appId: string;
  baseId: string;
  /** 添加时间戳（ms），用于排序 */
  addedAt: number;
};

// 模块级共享态：null = 尚未从服务端读入。
let _cache: MyApplet[] | null = null;
const _listeners = new Set<() => void>();

function _notify(): void {
  _listeners.forEach((fn) => fn());
}

async function _fetchFromServer(
  serverBaseUrl: string,
  accessToken: string,
): Promise<MyApplet[]> {
  const url = `${serverBaseUrl}api/user/me/my-applets`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`my-applets fetch failed: ${res.status}`);
  }
  const data = await res.json();
  const list = Array.isArray(data?.my_applets) ? (data.my_applets as MyApplet[]) : [];
  return list;
}

let _loadingPromise: Promise<void> | null = null;

/** 确保模块级缓存已加载（首次调用触发服务端 fetch，后续复用）。 */
function _ensureLoaded(): Promise<void> {
  if (!_loadingPromise) {
    const p = _fetchFromServer(_pendingServerUrl!, _pendingToken!).then(
      (list: MyApplet[]) => { _cache = list; },
    );
    _loadingPromise = p.catch(() => {}).finally(() => {
      _notify();
      _loadingPromise = null;
    });
  }
  return _loadingPromise;
}

/** 暂存最近一次 _ensureLoaded 用的鉴权参数 */
let _pendingServerUrl: string | null = null;
let _pendingToken: string | null = null;

async function _persist(next: MyApplet[], serverUrl: string, token: string): Promise<void> {
  _cache = next;
  _notify(); // 内存态先行，UI 即时更新
  const url = `${serverUrl}api/user/me/my-applets`;
  await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ my_applets: next }),
  });
}

export type UseMyApplets = {
  applets: MyApplet[];
  /** 首次服务端读入完成前为 true */
  loading: boolean;
  has: (appId: string) => boolean;
  /** 幂等：已存在同 appId 则不重复添加 */
  add: (a: Omit<MyApplet, 'addedAt'>) => Promise<void>;
  remove: (appId: string) => Promise<void>;
  /** 强制重新从服务端读入 */
  reload: () => Promise<void>;
};

export function useMyApplets(): UseMyApplets {
  const { session } = useSession();
  const [, force] = useReducer((x: number) => x + 1, 0);

  const serverUrl = session?.server_base_url ?? null;
  const token = session?.access_token ?? null;

  useEffect(() => {
    _listeners.add(force);
    return () => {
      _listeners.delete(force);
    };
  }, []);

  // session 就绪 + 缓存未加载 → 拉取
  useEffect(() => {
    if (!serverUrl || !token) return;
    if (_cache !== null) return; // 已加载
    _pendingServerUrl = serverUrl;
    _pendingToken = token;
    _ensureLoaded();
  }, [serverUrl, token]);

  const has = useCallback((appId: string) => (_cache ?? []).some((a) => a.appId === appId), []);

  const add = useCallback(async (a: Omit<MyApplet, 'addedAt'>) => {
    if (!serverUrl || !token) return;
    const list = _cache ?? [];
    if (list.some((x) => x.appId === a.appId)) return; // 幂等
    await _persist([{ ...a, addedAt: Date.now() }, ...list], serverUrl, token);
  }, [serverUrl, token]);

  const remove = useCallback(async (appId: string) => {
    if (!serverUrl || !token) return;
    await _persist((_cache ?? []).filter((x) => x.appId !== appId), serverUrl, token);
  }, [serverUrl, token]);

  const reload = useCallback(async () => {
    if (!serverUrl || !token) return;
    _cache = null;
    _pendingServerUrl = serverUrl;
    _pendingToken = token;
    await _ensureLoaded();
  }, [serverUrl, token]);

  return {
    applets: _cache ?? [],
    loading: _cache === null,
    has,
    add,
    remove,
    reload,
  };
}
