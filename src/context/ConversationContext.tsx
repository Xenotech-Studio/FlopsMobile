/**
 * 全局对话列表 + inbox SSE 保活单例。
 *
 * 背景：TodayScreen / ProjectScreen / DrawerContent 之前各自 `listConversations(session)`
 * 拉全量对话（3 次重复 fetch + 3 次重复 title 解密），各自维护本地 state，且 inbox SSE 绑在
 * TodayScreen 的 useEffect 上——页面卸载就断、无重连、丢弃 sidebar_refresh。
 *
 * 这里把「一份 convList + 一个 inbox SSE 单例」提到 SessionProvider 直下常驻：
 * - convList 全局唯一，mount 时 load（先吃 AsyncStorage 缓存 → 零加载即用，再拉网络）。
 * - runningMap / unreadMap 由 inbox SSE 增量维护（对齐旧 TodayScreen 语义）。
 * - inbox SSE：断线指数退避重连（照抄 flowbase TableSocket：1s→30s cap，收到数据即复位）；
 *   AppState active=重连 + catchup fetch，background=abort + 清 backoff 定时器（照抄 PresenceReporter）。
 * - sidebar_refresh → 静默 loadConvs（自己 echo 的 refresh 按 client_instance_id 跳过）。
 *
 * 消费方通过 hooks 零加载即用：useConversations / useProjectConversations /
 * useRunningConvMap / useUnreadConvMap，以及 actions refreshConversations /
 * addConversationOptimistic / removeConversationOptimistic。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { listConversations, runInboxStream, type ConversationListItem } from '../api';
import { useSession } from './SessionContext';
import { getOrCreateClientInstanceId } from '../utils/clientInstanceId';

const CACHED_CONVS_KEY = '@FlopsMobile/cachedConversations';
const DEDUPE_MS = 2000;
const BACKOFF_START = 1000;
const BACKOFF_MAX = 30_000;

type BoolMap = Record<string, boolean>;

type LoadOpts = { silent?: boolean; force?: boolean };

type ConversationContextValue = {
  convList: ConversationListItem[];
  runningMap: BoolMap;
  unreadMap: BoolMap;
  loading: boolean;
  error: string | null;
  streamConnected: boolean;
  refreshConversations: () => Promise<void>;
  addConversationOptimistic: (conv: ConversationListItem) => void;
  removeConversationOptimistic: (id: string) => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

/** 把列表项自带的 chat_v2_running / chat_v2_unread 合并进现有 map（保留 SSE 增量、不整表清空）。 */
function mergeFlag(prev: BoolMap, rows: ConversationListItem[], key: 'chat_v2_running' | 'chat_v2_unread'): BoolMap {
  const next = { ...prev };
  rows.forEach((c) => {
    if (Object.prototype.hasOwnProperty.call(c, key)) {
      if ((c as ConversationListItem)[key]) next[c.id] = true;
      else delete next[c.id];
    }
  });
  return next;
}

/** inbox_snapshot 的整表对象 → 只保留 true 项的 BoolMap。 */
function snapshotToMap(obj: unknown): BoolMap {
  if (!obj || typeof obj !== 'object') return {};
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).filter(([, v]) => v === true)
  ) as BoolMap;
}

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const [convList, setConvList] = useState<ConversationListItem[]>([]);
  const [runningMap, setRunningMap] = useState<BoolMap>({});
  const [unreadMap, setUnreadMap] = useState<BoolMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);

  const lastLoadRef = useRef<number>(0);
  const localInstanceIdRef = useRef<string | null>(null);

  useEffect(() => {
    getOrCreateClientInstanceId()
      .then((id) => {
        localInstanceIdRef.current = id;
      })
      .catch(() => {});
  }, []);

  const persist = useCallback((rows: ConversationListItem[]) => {
    AsyncStorage.setItem(CACHED_CONVS_KEY, JSON.stringify(rows)).catch(() => {});
  }, []);

  const loadConvs = useCallback(
    async (opts: LoadOpts = {}) => {
      if (!session) return;
      const { silent = false, force = false } = opts;
      const now = Date.now();
      // dedupe：2s 内重复 loadConvs 跳过（force 例外，用于下拉刷新 / AppState catchup）
      if (!force && lastLoadRef.current && now - lastLoadRef.current < DEDUPE_MS) return;
      lastLoadRef.current = now;
      if (!silent) setLoading(true);
      try {
        const { conversations } = await listConversations(session);
        const rows = conversations ?? [];
        setConvList(rows);
        setRunningMap((prev) => mergeFlag(prev, rows, 'chat_v2_running'));
        setUnreadMap((prev) => mergeFlag(prev, rows, 'chat_v2_unread'));
        setError(null);
        persist(rows);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载对话列表失败');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [session, persist]
  );

  // loadConvs 通过 ref 给 SSE effect 用，避免把它塞进 [session] effect 依赖导致反复重连
  const loadConvsRef = useRef(loadConvs);
  useEffect(() => {
    loadConvsRef.current = loadConvs;
  }, [loadConvs]);

  /** 登录态变化：清缓存态 → 先吃本地缓存（零加载即用）→ 拉网络。登出则清空。 */
  useEffect(() => {
    if (!session) {
      setConvList([]);
      setRunningMap({});
      setUnreadMap({});
      setError(null);
      lastLoadRef.current = 0;
      // 登出清缓存：缓存 key 全局共用，避免下个账号登录时短暂看到上一个账号的对话标题
      AsyncStorage.removeItem(CACHED_CONVS_KEY).catch(() => {});
      return;
    }
    let cancelled = false;
    lastLoadRef.current = 0;
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(CACHED_CONVS_KEY);
        if (!cancelled && cached) {
          const rows = JSON.parse(cached) as ConversationListItem[];
          if (Array.isArray(rows)) {
            setConvList((prev) => (prev.length === 0 ? rows : prev));
          }
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) loadConvs();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /** inbox SSE 单例：保活 + 断线退避重连 + AppState 前后台适配。 */
  useEffect(() => {
    if (!session) return undefined;

    let stopped = false;
    let ac: AbortController | null = null;
    let backoff = BACKOFF_START;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      if (AppState.currentState !== 'active') return;
      const delay = backoff;
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startStream();
      }, delay);
    };

    const handleMsg = (msg: Record<string, unknown>) => {
      if (stopped) return;
      // 收到任意帧即视为连上：复位退避、标连接（SSE 无 hello，用首帧对齐 TableSocket 的握手复位）
      backoff = BACKOFF_START;
      setStreamConnected(true);
      const type = msg.type;

      if (type === 'inbox_snapshot') {
        if (msg.running && typeof msg.running === 'object') {
          setRunningMap(snapshotToMap(msg.running));
        }
        if (Object.prototype.hasOwnProperty.call(msg, 'unread') && msg.unread && typeof msg.unread === 'object') {
          setUnreadMap(snapshotToMap(msg.unread));
        }
        return;
      }
      if (type === 'conversation_run' && msg.conversation_id != null) {
        const id = String(msg.conversation_id);
        setRunningMap((prev) => {
          const next = { ...prev };
          if (msg.running) next[id] = true;
          else delete next[id];
          return next;
        });
        return;
      }
      if (type === 'conversation_unread' && msg.conversation_id != null) {
        const id = String(msg.conversation_id);
        setUnreadMap((prev) => {
          const next = { ...prev };
          if (msg.unread) next[id] = true;
          else delete next[id];
          return next;
        });
        return;
      }
      if (type === 'sidebar_refresh') {
        // 自己 echo 的 refresh 跳过（本机刚做过的改动，convList 已本地更新过）
        const origin = msg.origin_client_instance_id;
        if (origin && localInstanceIdRef.current && origin === localInstanceIdRef.current) return;
        loadConvsRef.current({ silent: true });
        return;
      }
    };

    const startStream = () => {
      if (stopped || ac) return;
      if (AppState.currentState !== 'active') return;
      const localAc = new AbortController();
      ac = localAc;
      runInboxStream(session, localAc.signal, handleMsg)
        .then(() => {
          // server 关流 → 视为断线，退避重连
          if (ac === localAc) ac = null;
          setStreamConnected(false);
          scheduleReconnect();
        })
        .catch((e: unknown) => {
          if (ac === localAc) ac = null;
          setStreamConnected(false);
          const name = e && typeof e === 'object' && 'name' in e ? (e as { name?: string }).name : '';
          if (name === 'AbortError') return; // 主动 abort（后台 / 卸载），不重连
          scheduleReconnect();
        });
    };

    const onAppState = (status: AppStateStatus) => {
      if (status === 'active') {
        // 回前台：复位退避、重连、并 catchup 拉一次列表（补齐后台期间漏掉的 sidebar_refresh）
        clearReconnect();
        backoff = BACKOFF_START;
        startStream();
        loadConvsRef.current({ silent: true, force: true });
      } else {
        // 切后台：abort 当前流 + 清退避定时器（省电，且避免后台 socket 被系统杀无声重试）
        clearReconnect();
        if (ac) {
          ac.abort();
          ac = null;
        }
        setStreamConnected(false);
      }
    };

    const sub = AppState.addEventListener('change', onAppState);
    if (AppState.currentState === 'active') startStream();

    return () => {
      stopped = true;
      clearReconnect();
      if (ac) ac.abort();
      ac = null;
      sub.remove();
    };
  }, [session]);

  const refreshConversations = useCallback(async () => {
    await loadConvs({ force: true });
  }, [loadConvs]);

  const addConversationOptimistic = useCallback(
    (conv: ConversationListItem) => {
      setConvList((prev) => {
        if (prev.some((c) => c.id === conv.id)) return prev;
        const next = [conv, ...prev];
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const removeConversationOptimistic = useCallback(
    (id: string) => {
      setConvList((prev) => {
        const next = prev.filter((c) => c.id !== id);
        persist(next);
        return next;
      });
      setRunningMap((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setUnreadMap((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [persist]
  );

  const value: ConversationContextValue = {
    convList,
    runningMap,
    unreadMap,
    loading,
    error,
    streamConnected,
    refreshConversations,
    addConversationOptimistic,
    removeConversationOptimistic,
  };

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

function useConversationContext(): ConversationContextValue {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('useConversationContext must be used within ConversationProvider');
  return ctx;
}

/** 全局对话列表（全量，消费方自行 slice / filter）。 */
export function useConversations(): ConversationListItem[] {
  return useConversationContext().convList;
}

/** 某项目下的对话（按 flowtask_project_id 过滤，与 Web ConversationList 语义一致）。 */
export function useProjectConversations(projectId: string): ConversationListItem[] {
  const { convList } = useConversationContext();
  return useMemo(
    () => convList.filter((c) => c.flowtask_project_id === projectId),
    [convList, projectId]
  );
}

/** 「进行中」状态 map（conversationId → true）。 */
export function useRunningConvMap(): BoolMap {
  return useConversationContext().runningMap;
}

/** 「未读」状态 map（conversationId → true）。 */
export function useUnreadConvMap(): BoolMap {
  return useConversationContext().unreadMap;
}

/** 列表加载态 / 错误态 / SSE 连接态。 */
export function useConversationsStatus(): { loading: boolean; error: string | null; streamConnected: boolean } {
  const { loading, error, streamConnected } = useConversationContext();
  return { loading, error, streamConnected };
}

/** actions：刷新 / 乐观增删（避免整表重拉）。 */
export function useConversationActions(): Pick<
  ConversationContextValue,
  'refreshConversations' | 'addConversationOptimistic' | 'removeConversationOptimistic'
> {
  const { refreshConversations, addConversationOptimistic, removeConversationOptimistic } =
    useConversationContext();
  return { refreshConversations, addConversationOptimistic, removeConversationOptimistic };
}
