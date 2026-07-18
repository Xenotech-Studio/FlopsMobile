/**
 * useMyApplets —— 「我的小应用」本地持久化（AsyncStorage）。
 *
 * 用户在 AppletScreen 底部 sheet 里「添加到我的小应用」的条目存这里；MiniAppListScreen 读它渲染
 * grid。key = `my_applets`，value = MyApplet[]（按 addedAt 倒序，新加的在前）。
 *
 * 用模块级共享缓存 + 订阅：所有 hook 实例共享同一份内存态，任一处 add/remove 立即同步到其它挂载中
 * 的组件（列表页与 sheet 不会各拿一份、看到脏数据）。AsyncStorage 只做落盘，内存态先行更新。
 */
import { useCallback, useEffect, useReducer } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type MyApplet = {
  appId: string;
  baseId: string;
  /** 展示名（可选；缺省时 UI 用 appId 首字符占位） */
  name?: string;
  /** 添加时间戳（ms），用于排序 */
  addedAt: number;
};

const STORAGE_KEY = 'my_applets';

// 模块级共享态：null = 尚未从磁盘读入。
let _cache: MyApplet[] | null = null;
let _loading = false;
const _listeners = new Set<() => void>();

function _notify(): void {
  _listeners.forEach((fn) => fn());
}

async function _ensureLoaded(): Promise<void> {
  if (_cache !== null || _loading) return;
  _loading = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    _cache = Array.isArray(parsed) ? (parsed as MyApplet[]) : [];
  } catch {
    _cache = [];
  } finally {
    _loading = false;
    _notify();
  }
}

async function _persist(next: MyApplet[]): Promise<void> {
  _cache = next;
  _notify(); // 内存态先行，UI 即时更新
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 落盘失败：本次会话内存态仍有效，仅可能重启后丢失，静默处理 */
  }
}

export type UseMyApplets = {
  applets: MyApplet[];
  /** 首次磁盘读入完成前为 true */
  loading: boolean;
  has: (appId: string) => boolean;
  /** 幂等：已存在同 appId 则不重复添加 */
  add: (a: Omit<MyApplet, 'addedAt'>) => Promise<void>;
  remove: (appId: string) => Promise<void>;
  /** 强制重新从磁盘读入（一般不需要；共享缓存已保证同步） */
  reload: () => Promise<void>;
};

export function useMyApplets(): UseMyApplets {
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    _listeners.add(force);
    _ensureLoaded().catch(() => {});
    return () => {
      _listeners.delete(force);
    };
  }, []);

  const has = useCallback((appId: string) => (_cache ?? []).some((a) => a.appId === appId), []);

  const add = useCallback(async (a: Omit<MyApplet, 'addedAt'>) => {
    const list = _cache ?? [];
    if (list.some((x) => x.appId === a.appId)) return; // 幂等
    await _persist([{ ...a, addedAt: Date.now() }, ...list]);
  }, []);

  const remove = useCallback(async (appId: string) => {
    await _persist((_cache ?? []).filter((x) => x.appId !== appId));
  }, []);

  const reload = useCallback(async () => {
    _cache = null;
    await _ensureLoaded();
  }, []);

  return {
    applets: _cache ?? [],
    loading: _cache === null,
    has,
    add,
    remove,
    reload,
  };
}
