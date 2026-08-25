/**
 * 全局对话列表 + inbox SSE 保活单例。
 *
 * 背景：TodayScreen / ProjectScreen / DrawerContent 之前各自 `listConversations(session)`
 * 拉全量对话（3 次重复 fetch + 3 次重复 title 解密），各自维护本地 state，且 inbox SSE 绑在
 * TodayScreen 的 useEffect 上——页面卸载就断、无重连、丢弃 sidebar_refresh。
 *
 * 这里把「一份 convList + 一个 inbox SSE 单例」提到 SessionProvider 直下常驻：
 * - convList 全局唯一，mount 时 load（先吃本地快照 → 首帧即有内容，再拉网络对账）。
 * - runningMap / unreadMap 由 inbox SSE 增量维护（对齐旧 TodayScreen 语义）。
 * - inbox SSE：断线指数退避重连（照抄 flowbase TableSocket：1s→30s cap，收到数据即复位）；
 *   AppState active=重连 + catchup fetch，background=abort + 清 backoff 定时器（照抄 BeaconReporter）。
 * - sidebar_refresh → 静默 loadConvs（自己 echo 的 refresh 按 client_instance_id 跳过）。
 *
 * 服务端分页（2026-08）：convList 不再是「该用户全部会话」，而是 updated_at DESC 的**前 N 页**。
 * 起因是全量拉 920 条 = 1.4MB 明文 + 服务端几十 MB JSON，而今日页只画 10 行。
 * - loadConvs 拉第一页（replace 语义）；loadMoreConversations 拉下一页（append 语义，按 id 去重）。
 * - 刷新（下拉 / AppState catchup / sidebar_refresh）重拉「当前已加载的窗口大小」而非固定一页，
 *   否则用户滚了 5 页后一次静默刷新会把列表缩回 1 页。
 * - 项目页要的是「某项目下**全部**会话」，跟这条分页主流不是一个集合，所以单独按 project 走
 *   服务端过滤（?flowtask_project_id=）缓存在 projectConvsRef/projectConvs 里，见
 *   useProjectConversations —— 不塞进 convList，避免把老会话插进分页主流搞乱顺序与 offset。
 *
 * 本地快照秒开（2026-08）：冷启动第一帧就把上次的列表画出来，不再 await 存储。
 * - 快照在 bundle eval 时预读进内存（utils/conversationSnapshot），session 落地时**渲染期**
 *   同步 seed（不是 effect —— effect 在 commit 之后跑，今日页会先画一帧空列表/菊花）。
 * - 落盘走防抖：convList / runningMap / unreadMap 任一变化后 800ms 写一次最终态，
 *   所以列表刷新、乐观增删、SSE 改 running/unread 全都自动进快照，无需逐处手写。
 * - 失效：登出清；user_id 对不上不认；>24h 仍显示但首屏立刻强制刷新；网络回来整窗替换即对账。
 *
 * 消费方通过 hooks 零加载即用：useConversations / useProjectConversations /
 * useRunningConvMap / useUnreadConvMap，以及 actions refreshConversations /
 * loadMoreConversations / refreshProjectConversations /
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
import {
  CONV_LIST_PAGE_SIZE,
  listConversations,
  runInboxStream,
  mintChildKConvDirect,
  type ConversationListItem,
} from '../api';
import { useSession } from './SessionContext';
import { getOrCreateClientInstanceId } from '../utils/clientInstanceId';
import { notifyRemoteMicBye, notifyRemoteMicInvite } from '../utils/remoteMicInviteBus';
import { notifyConversationAccessRequest } from '../utils/conversationAccessBus';
import {
  buildSnapshot,
  clearSnapshot,
  ensureSnapshot,
  isSnapshotStale,
  readSnapshotSync,
  schedulePersistSnapshot,
  type ConversationSnapshot,
} from '../utils/conversationSnapshot';

const DEDUPE_MS = 2000;
const BACKOFF_START = 1000;
const BACKOFF_MAX = 30_000;
/** 刷新时重拉「当前已加载窗口」的条数上限（= 服务端单次 limit 上限）。滚过这个量的用户，
 *  刷新只重拉前 200 条，再往下的靠继续上滑重新分页取回（列表会自愈，不会缺行）。 */
const REFRESH_WINDOW_MAX = 200;

type BoolMap = Record<string, boolean>;
/** conversationId → { taskId: true }。存 id 集合而不是布尔：一个会话可能同时跑多个后台任务，
 *  粗粒度布尔会在其中一个结束时把整条会话的转圈误灭（服务端注释里点名的坑）。 */
type TaskIdMap = Record<string, Record<string, true>>;

type LoadOpts = {
  silent?: boolean;
  force?: boolean;
  /** 分页窗口回到第一页（只给下拉刷新用）。静默刷新不传，否则滚了 5 页会被缩回 20 条。 */
  reset?: boolean;
};

type ConversationContextValue = {
  convList: ConversationListItem[];
  runningMap: BoolMap;
  unreadMap: BoolMap;
  /** 会话是否有后台任务在跑（agent 未跑但任务还在跑的那种）。与 runningMap 独立，UI 取或。 */
  bgTaskRunningMap: BoolMap;
  loading: boolean;
  error: string | null;
  streamConnected: boolean;
  /** 本账号的首次列表请求已跑完（成功/失败都算） */
  everLoaded: boolean;
  /** 服务端在已加载页之后还有更多会话（今日页据此决定滚到底要不要继续拉） */
  hasMoreConversations: boolean;
  /** 正在拉下一页（并发触发的 onEndReached 由它挡住） */
  loadingMoreConversations: boolean;
  /** 重新拉列表。默认保持「当前已加载窗口」的大小；`reset` = 回到第一页（下拉刷新用）。 */
  refreshConversations: (opts?: { reset?: boolean }) => Promise<void>;
  /** 拉下一页并**追加**到 convList 尾部（按 id 去重）。没有更多 / 正在拉 时是 no-op。 */
  loadMoreConversations: () => Promise<void>;
  addConversationOptimistic: (conv: ConversationListItem) => void;
  removeConversationOptimistic: (id: string) => void;
  /** 某项目下的全部会话（服务端过滤，独立于分页主流）。 */
  projectConvs: Record<string, ConversationListItem[]>;
  projectConvsLoading: Record<string, boolean>;
  loadProjectConversations: (projectId: string, force?: boolean) => Promise<void>;
  /** 声明「当前正打开着的对话」（ChatScreen 获焦时上报、失焦清 null）。用于未读闪点守卫：见下。 */
  setActiveConversation: (id: string | null) => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

/** 对话行「点击守卫」：菜单（原生 UIMenu / 自绘 popover）打开或刚关 <300ms 内，抑制行的按下高亮 + 点击。
 *  为什么单独一个 context（而非塞进上面那个大 value）：这里的 value 必须是**恒定引用**（refs + 稳定
 *  回调，identity 永不变），这样 ConversationRow 消费它不会随 convList/SSE 每次更新而重渲染。
 *  为什么必须 ref + 实时函数（而非 render 快照 prop）：iOS 原生 UIMenu 在 RN 视图树之外，它 dismiss
 *  那一下 touch 会穿透回底层 Pressable；而 ref 变更不触发 re-render，UIMenu 开→关→穿透全程没有渲染，
 *  render 时求值的 suppress 永远是滞后快照。ConversationRow 必须在 Pressable 的 style callback 里
 *  **实时**调用 isRowTapSuppressed() 读当前 ref 值，才能在按下那一刻正确压住高亮、消除闪烁。 */
type RowTapGuardValue = {
  /** 菜单开合上报：true=打开，false=关闭（关闭时记录时间戳，起 300ms 抑制窗）。 */
  setMenuOpen: (open: boolean) => void;
  /** 实时判定是否应吞掉这次行点击/高亮。必须在触摸发生的那一刻调用（读 ref 现值）。 */
  isRowTapSuppressed: () => boolean;
};
const RowTapGuardContext = createContext<RowTapGuardValue | null>(null);
/** 无 Provider 时的安全默认：从不抑制（让 ConversationRow 在任意上下文/测试里都能独立渲染）。 */
const NOOP_ROW_TAP_GUARD: RowTapGuardValue = {
  setMenuOpen: () => {},
  isRowTapSuppressed: () => false,
};

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

/** inbox_snapshot.tasks（`{cid: [taskId, ...]}`）→ `{cid: {taskId: true}}`。
 *  空数组 / 非法项直接丢掉，保证「有 key 就一定有在跑的任务」。 */
function snapshotToTaskIds(obj: unknown): TaskIdMap {
  if (!obj || typeof obj !== 'object') return {};
  const out: TaskIdMap = {};
  for (const [cid, tids] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(tids)) continue;
    const ids: Record<string, true> = {};
    tids.forEach((t) => {
      const s = String(t ?? '').trim();
      if (s) ids[s] = true;
    });
    if (Object.keys(ids).length > 0) out[String(cid)] = ids;
  }
  return out;
}

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const [convList, setConvList] = useState<ConversationListItem[]>([]);
  const [runningMap, setRunningMap] = useState<BoolMap>({});
  const [unreadMap, setUnreadMap] = useState<BoolMap>({});
  /** 「有后台任务在跑」的会话 → 任务 id 集合。**只由 inbox SSE 维护**：
   *  GET /api/conversations 的行投影里根本没有后台任务字段（server.py 的 _project），
   *  所以列表刷新既补不出它、也绝不能清它 —— mergeFlag 那套 running/unread 语义不碰这份。 */
  const [bgTaskIdsByConv, setBgTaskIdsByConv] = useState<TaskIdMap>({});
  const [loading, setLoading] = useState(false);
  /** 本账号的首次列表请求是否已跑完（成功/失败都算）。loading 初始是 false、要等 effect 里
   *  loadConvs 起步才变 true，只看 loading 的话首帧会先闪一下「暂无历史对话」空态。 */
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  /** 项目页数据源：projectId → 该项目下全部会话（服务端 ?flowtask_project_id= 过滤） */
  const [projectConvs, setProjectConvs] = useState<Record<string, ConversationListItem[]>>({});
  const [projectConvsLoading, setProjectConvsLoading] = useState<Record<string, boolean>>({});

  const lastLoadRef = useRef<number>(0);
  const localInstanceIdRef = useRef<string | null>(null);
  /** 已从服务端分页取回的条数 = 下一页的 offset。**不能**用 convList.length 代替：
   *  乐观新增 / 删除会让两者脱钩，offset 一错就整段跳页。 */
  const pagedCountRef = useRef(0);
  /** loadMore 的并发闸（state 更新是异步的，onEndReached 连发两次会同 offset 拉两遍） */
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(false);
  /** projectConvs 的同步读镜像：loadProjectConversations 要在闭包里判「这个项目拉过没」，
   *  用 state 会读到旧快照，导致每次 mount 都重拉一遍。 */
  const projectConvsRef = useRef<Record<string, ConversationListItem[]>>({});
  useEffect(() => {
    projectConvsRef.current = projectConvs;
  }, [projectConvs]);
  /** 正在拉的 projectId 集合（同 id 并发去重） */
  const projectLoadingRef = useRef<Set<string>>(new Set());

  /* 行点击守卫的两个 ref + 恒定引用的 value（见 RowTapGuardContext 注释）。 */
  const menuOpenRef = useRef(false);
  const menuClosedAtRef = useRef(0);
  const rowTapGuard = useMemo<RowTapGuardValue>(
    () => ({
      setMenuOpen: (open: boolean) => {
        menuOpenRef.current = open;
        if (!open) menuClosedAtRef.current = Date.now();
      },
      isRowTapSuppressed: () =>
        menuOpenRef.current || Date.now() - menuClosedAtRef.current < 300,
    }),
    [],
  );

  /** 当前正打开着的对话 id（ChatScreen 上报）。SSE handler 用 ref 同步读，清点 effect 用 state 触发。
   *  根因见 conversation_unread 守卫处：「正看着的对话即已读」，收到它的 unread=true 直接吞掉，
   *  修掉「完成瞬间蓝点亮一下又灭」的闪点（对齐 FlopsDesktop 的活动会话守卫）。 */
  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  /** WP3 eager-mint 去重：同一条子对话别因 SSE 重连补帧而重复 mint。 */
  const mintedChildrenRef = useRef<Set<string>>(new Set());
  const activeConversationIdRef = useRef<string | null>(null);
  const setActiveConversation = useCallback((id: string | null) => {
    const norm = id ? String(id) : null;
    activeConversationIdRef.current = norm;
    setActiveConversationIdState(norm);
  }, []);

  useEffect(() => {
    getOrCreateClientInstanceId()
      .then((id) => {
        localInstanceIdRef.current = id;
      })
      .catch(() => {});
  }, []);

  /** 拉第一页（replace 语义）。刷新时窗口不缩水：重拉「已加载过多少条」而非固定一页，
   *  否则滚了 5 页之后来一次 sidebar_refresh，列表会当场缩回 20 条。 */
  const loadConvs = useCallback(
    async (opts: LoadOpts = {}) => {
      if (!session) return;
      const { silent = false, force = false, reset = false } = opts;
      const now = Date.now();
      // dedupe：2s 内重复 loadConvs 跳过（force 例外，用于下拉刷新 / AppState catchup）
      if (!force && lastLoadRef.current && now - lastLoadRef.current < DEDUPE_MS) return;
      lastLoadRef.current = now;
      if (!silent) setLoading(true);
      const want = reset
        ? CONV_LIST_PAGE_SIZE
        : Math.min(Math.max(pagedCountRef.current, CONV_LIST_PAGE_SIZE), REFRESH_WINDOW_MAX);
      try {
        const { conversations, hasMore } = await listConversations(session, {
          limit: want,
          offset: 0,
        });
        const rows = conversations ?? [];
        pagedCountRef.current = rows.length;
        hasMoreRef.current = hasMore;
        setHasMoreConversations(hasMore);
        setConvList(rows);
        setRunningMap((prev) => mergeFlag(prev, rows, 'chat_v2_running'));
        setUnreadMap((prev) => mergeFlag(prev, rows, 'chat_v2_unread'));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载对话列表失败');
        // 失败不清列表：离线/弱网时保留快照 seed 的那份，比空屏有用
      } finally {
        if (!silent) setLoading(false);
        // 失败也算「跑过一次」：否则拉不动时列表位置会永远停在骨架上
        setEverLoaded(true);
      }
    },
    [session]
  );

  /** 拉下一页并追加到尾部。offset 走 pagedCountRef（服务端口径），去重按 id ——
   *  翻页途中有会话被更新上浮时 offset 分页会跨页重复，去重后顺序仍是 updated_at DESC。 */
  const loadMoreConversations = useCallback(async () => {
    if (!session) return;
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMoreConversations(true);
    const offset = pagedCountRef.current;
    try {
      const { conversations, hasMore } = await listConversations(session, {
        limit: CONV_LIST_PAGE_SIZE,
        offset,
      });
      const rows = conversations ?? [];
      // offset 按「请求回来的条数」推进，而不是去重后的条数——服务端口径是行数，
      // 用去重后的数会让下一页重复读同一段。
      pagedCountRef.current = offset + rows.length;
      hasMoreRef.current = hasMore;
      setHasMoreConversations(hasMore);
      if (rows.length > 0) {
        setConvList((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          const fresh = rows.filter((c) => !seen.has(c.id));
          if (fresh.length === 0) return prev;
          return [...prev, ...fresh];
        });
        setRunningMap((prev) => mergeFlag(prev, rows, 'chat_v2_running'));
        setUnreadMap((prev) => mergeFlag(prev, rows, 'chat_v2_unread'));
      }
    } catch {
      // 静默失败：保留已加载的页，用户可再次上滑重试
    } finally {
      loadingMoreRef.current = false;
      setLoadingMoreConversations(false);
    }
  }, [session]);

  /** 某项目下的全部会话：服务端 ?flowtask_project_id= 过滤，独立缓存。
   *  不分页——单个项目的会话数是「几十条」量级，跟全量 900 条不是一个问题。 */
  const loadProjectConversations = useCallback(
    async (projectId: string, force = false) => {
      if (!session || !projectId) return;
      if (!force && projectConvsRef.current[projectId]) return;
      // 同一 projectId 的并发请求只放一个（项目页里多个组件同时消费同一个 hook）
      if (projectLoadingRef.current.has(projectId)) return;
      projectLoadingRef.current.add(projectId);
      setProjectConvsLoading((prev) => ({ ...prev, [projectId]: true }));
      try {
        const { conversations } = await listConversations(session, {
          flowtaskProjectId: projectId,
        });
        const rows = conversations ?? [];
        setProjectConvs((prev) => ({ ...prev, [projectId]: rows }));
        setRunningMap((prev) => mergeFlag(prev, rows, 'chat_v2_running'));
        setUnreadMap((prev) => mergeFlag(prev, rows, 'chat_v2_unread'));
      } catch {
        // 静默失败：保留上次的项目会话（下拉刷新可重试）
      } finally {
        projectLoadingRef.current.delete(projectId);
        setProjectConvsLoading((prev) => ({ ...prev, [projectId]: false }));
      }
    },
    [session]
  );

  // loadConvs 通过 ref 给 SSE effect 用，避免把它塞进 [session] effect 依赖导致反复重连
  const loadConvsRef = useRef(loadConvs);
  useEffect(() => {
    loadConvsRef.current = loadConvs;
  }, [loadConvs]);

  /* 三份 state 的同步镜像：快照落盘要在定时器里读「此刻的最终态」，用 state 会读到旧闭包。 */
  const convListRef = useRef(convList);
  const runningMapRef = useRef(runningMap);
  const unreadMapRef = useRef(unreadMap);
  convListRef.current = convList;
  runningMapRef.current = runningMap;
  unreadMapRef.current = unreadMap;

  /* ---- 本地快照：渲染期同步 seed（不是 effect）。见文件头「本地快照秒开」。 ----
   * 为什么在 render 里 setState：session 落地那一次 render 里，本 Provider 和它下面的今日页
   * 是同一个 commit；放 effect 里就晚一帧——用户先看到空列表/菊花再看到内容，正是要消掉的那下。
   * React 允许组件在自己的 render 期更新自己的 state（会就地重跑本组件、再渲染子树），
   * seededForUserRef 保证只发生一次、不会循环。 */
  const seededForUserRef = useRef<string | null>(null);
  const applySnapshot = useCallback((snap: ConversationSnapshot) => {
    setConvList(snap.rows);
    setRunningMap(snap.running);
    setUnreadMap(snap.unread);
    // 快照不是「服务端分页取回的」，但冷启动那次刷新要按它的行数重拉，
    // 否则 40 行的列表会在网络回来时缩成 20 行（可见的抖一下）。
    pagedCountRef.current = snap.rows.length;
  }, []);
  if (session && seededForUserRef.current !== session.user_id) {
    const prevUserId = seededForUserRef.current;
    seededForUserRef.current = session.user_id;
    const snap = readSnapshotSync(session.user_id);
    if (snap && snap.rows.length > 0) {
      applySnapshot(snap);
    } else {
      // 换账号：分页游标必须跟着换，否则新账号的首页会按上个账号的窗口大小拉；
      // 上个账号的行也当场清掉，别让它们挂到新账号名下（正常登出已清，这里兜直接切号）。
      pagedCountRef.current = 0;
      if (prevUserId) {
        setConvList([]);
        setRunningMap({});
        setUnreadMap({});
      }
    }
  }

  /** 登录态变化：先吃本地快照（同步已在上面做了，这里兜异步）→ 拉网络对账。登出则清空。 */
  useEffect(() => {
    if (!session) {
      seededForUserRef.current = null;
      setConvList([]);
      setRunningMap({});
      setUnreadMap({});
      setBgTaskIdsByConv({});
      setProjectConvs({});
      setProjectConvsLoading({});
      setError(null);
      setEverLoaded(false);
      lastLoadRef.current = 0;
      pagedCountRef.current = 0;
      hasMoreRef.current = false;
      setHasMoreConversations(false);
      // 登出清快照：key 全局共用，避免下个账号登录时首帧闪一下上个账号的对话标题
      clearSnapshot();
      return;
    }
    let cancelled = false;
    lastLoadRef.current = 0;
    hasMoreRef.current = false;
    // 换账号：新账号的首屏要重新走骨架，别继承上一个账号的「已加载过」
    setEverLoaded(false);
    // 后台任务集合是上个账号的，清掉等新账号的 inbox_snapshot 重新种
    setBgTaskIdsByConv({});
    setProjectConvs({});
    setProjectConvsLoading({});
    const userId = session.user_id;
    (async () => {
      // 同步 seed 没赶上（预热读还没回来）时的兜底：等预热完再补一次。
      const snap = await ensureSnapshot(userId);
      if (cancelled) return;
      // 手上已经有行了（同步 seed 成功，或网络先回来了）就别再用快照盖一遍
      if (snap && snap.rows.length > 0 && convListRef.current.length === 0) {
        applySnapshot(snap);
      }
      if (cancelled) return;
      // 快照陈旧（>24h）：照样先显示，但这次刷新绕过 dedupe 立刻打网络
      loadConvs({ force: isSnapshotStale(snap) });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /* ---- 快照落盘：列表 / running / unread 任一变化后防抖写一次最终态。 ----
   * 集中在这一处，所以列表刷新、分页追加、乐观增删、SSE 增量全都自动进快照，不必逐处手写 persist。 */
  useEffect(() => {
    if (!session) return;
    if (convList.length === 0) return; // 空列表不写：登出/切号途中的中间态别把好快照抹了
    const userId = session.user_id;
    schedulePersistSnapshot(() =>
      buildSnapshot(userId, convListRef.current, runningMapRef.current, unreadMapRef.current)
    );
  }, [session, convList, runningMap, unreadMap]);

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
        // 后台任务运行集种子：msg.tasks = { cid: [taskId, ...] }。快照即权威 —— 服务端是对
        // 该用户**全部**对话做的全量扫描（server.py _inbox_snapshot_conv_pairs 传 only_conv_ids=None），
        // 所以整表替换、缺省即清空：断线期间跑完的任务靠重连这一帧收尾，不会残留 ⏳。
        setBgTaskIdsByConv(snapshotToTaskIds(msg.tasks));
        return;
      }
      if (type === 'task_status' && msg.conversation_id != null) {
        /* 后台任务级实时状态（与 conversation_run 互补：那个是「agent 在跑」，这个是
         * 「agent 未跑但后台任务还在跑」）。按 task_id 精确增删 —— 存集合而不是布尔，
         * 否则一个会话里多个任务、先结束的那个就会把整条会话的转圈误灭。 */
        const id = String(msg.conversation_id).trim();
        const taskId = String(msg.task_id ?? '').trim();
        const status = String(msg.status ?? '').toLowerCase();
        if (!id || !taskId) return;
        setBgTaskIdsByConv((prev) => {
          const cur = { ...(prev[id] ?? {}) };
          if (status === 'running') cur[taskId] = true;
          else delete cur[taskId];
          const next = { ...prev };
          if (Object.keys(cur).length > 0) next[id] = cur;
          else delete next[id];
          return next;
        });
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
          // 「正打开着的对话即已读」：本端刚跑完、或别端跑完而我正开着它，收到的 unread=true 直接吞掉。
          // 否则会先亮蓝点、再被 ChatScreen 打开对话触发的 mark-read 广播（unread=false）灭掉 → 闪一下。
          // 服务端仍会因打开对话 GET 而清 chat_v2_unread，收敛一致；这里只把视觉/本地态提前收口。
          if (msg.unread && id !== activeConversationIdRef.current) next[id] = true;
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
      if (type === 'conversation_access_request' && typeof msg.request_id === 'string' && msg.request_id) {
        /* WP3 档 B：agent 想读一条它无权解的加密对话，服务端来问用户。发总线让根级
           ConversationAccessRequestOverlay 弹卡片（发起方对话未必开着，不能挂在 ChatScreen）。 */
        notifyConversationAccessRequest({
          requestId: msg.request_id,
          requesterConversationId:
            typeof msg.requester_conversation_id === 'string' ? msg.requester_conversation_id : '',
          targetConversationId:
            typeof msg.target_conversation_id === 'string' ? msg.target_conversation_id : '',
          reason: typeof msg.reason === 'string' ? msg.reason : '',
        });
        return;
      }
      if (
        type === 'subagent_child_spawned' &&
        typeof msg.child_conversation_id === 'string' &&
        msg.child_conversation_id
      ) {
        /* WP3 eager-mint：服务端刚 spawn 一条加密子对话，趁本端此刻手里有父对话的 K_conv，
           立刻把它 mint 成 direct。纯后台、静默，失败不打扰用户（打开子对话时还会再自愈一次）。 */
        const childId = msg.child_conversation_id;
        if (!mintedChildrenRef.current.has(childId)) {
          mintedChildrenRef.current.add(childId);
          void mintChildKConvDirect(session, childId).then((ok) => {
            if (!ok) mintedChildrenRef.current.delete(childId); // 允许下次事件重试
          });
        }
        return;
      }
      if (type === 'remote_mic_invite' && typeof msg.invite_id === 'string' && msg.invite_id) {
        // 跨设备语音输入邀请（inbox SSE 定向通道）：目标设备在线时服务端把邀请经这条 SSE 下发。
        // 用户级广播 —— 账户下每台设备都会收到；target_device_id（新，beacon device_id）标出电脑
        // 选中的目标设备，总线按它做 device 定向过滤（非目标机静默丢弃；phone_token_hash 兜旧路径），
        // 再按 invite_id 去重、由 RemoteMicInviteOverlay 验证并弹应用内确认卡片
        notifyRemoteMicInvite({
          inviteId: msg.invite_id,
          desktopName: typeof msg.desktop_name === 'string' ? msg.desktop_name : undefined,
          desktopDeviceId: typeof msg.desktop_device_id === 'string' ? msg.desktop_device_id : undefined,
          targetDeviceId: typeof msg.target_device_id === 'string' ? msg.target_device_id : undefined,
          phoneTokenHash: typeof msg.phone_token_hash === 'string' ? msg.phone_token_hash : undefined,
        });
        return;
      }
      if (type === 'remote_dictation') {
        // 远程听写通道是用户级广播：识别帧（begin/result/done）给电脑消费，手机吞掉；
        // 连接级 event=bye（电脑主动断开）发到总线，RemoteMicScreen 按 invite_id 就地结束
        if (msg.event === 'bye' && typeof msg.invite_id === 'string' && msg.invite_id) {
          notifyRemoteMicBye(msg.invite_id);
        }
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
      } else if (status === 'background') {
        // 切后台：abort 当前流 + 清退避定时器（省电，且避免后台 socket 被系统杀无声重试）
        clearReconnect();
        if (ac) {
          ac.abort();
          ac = null;
        }
        setStreamConnected(false);
      }
      /* 'inactive' 是 iOS 瞬时态（底部上滑进 App Switcher 预览 / 控制中心 / 通知横幅 / 来电），
       * app 仍在前台、网络照跑。不 abort —— 否则每次上滑预览都要掐断 inbox SSE 再重连一次。
       * 对齐 BeaconReporter 的处理；真离开时紧跟的 'background' 才收尾。 */
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

  /** 活动会话未读兜底清点：只要「正打开着的对话」出现在 unreadMap 里就地灭点。
   *  覆盖 SSE 守卫吞不掉的入口——inbox_snapshot 整表 / loadConvs 的 mergeFlag（列表 chat_v2_unread）
   *  可能把它重新点亮；以及打开一个本就未读的对话时的即时本地灭点（打开对话的 GET 会让服务端清
   *  chat_v2_unread + 广播 unread=False，这里先于往返把本地态收口）。 */
  useEffect(() => {
    if (!activeConversationId) return;
    setUnreadMap((prev) => {
      if (!prev[activeConversationId]) return prev;
      const next = { ...prev };
      delete next[activeConversationId];
      return next;
    });
  }, [activeConversationId, unreadMap]);

  const refreshConversations = useCallback(
    async (opts: { reset?: boolean } = {}) => {
      await loadConvs({ force: true, reset: opts.reset });
    },
    [loadConvs]
  );

  const addConversationOptimistic = useCallback((conv: ConversationListItem) => {
    // 本地多出一条（服务端还没算进分页口径）→ 下一页 offset 跟着 +1，
    // 否则会把服务端第 N 条重读一遍（去重后表现为「上滑一次没长出新行」）。
    if (!convListRef.current.some((c) => c.id === conv.id)) {
      pagedCountRef.current += 1;
    }
    setConvList((prev) => {
      if (prev.some((c) => c.id === conv.id)) return prev;
      return [conv, ...prev];
    });
  }, []);

  const removeConversationOptimistic = useCallback((id: string) => {
    // 服务端也少了一条 → offset 回退 1，否则下一页会跳过一条（漏行）。
    // 放 updater 外面按 ref 判：updater 可能被 React 重复调用，游标不能在里面改。
    if (convListRef.current.some((c) => c.id === id)) {
      pagedCountRef.current = Math.max(0, pagedCountRef.current - 1);
    }
    setConvList((prev) => {
      if (!prev.some((c) => c.id === id)) return prev;
      return prev.filter((c) => c.id !== id);
    });
    setProjectConvs((prev) => {
      let touched = false;
      const next: Record<string, ConversationListItem[]> = {};
      for (const [pid, rows] of Object.entries(prev)) {
        const kept = rows.filter((c) => c.id !== id);
        if (kept.length !== rows.length) touched = true;
        next[pid] = kept;
      }
      return touched ? next : prev;
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
  }, []);

  /** `{cid: {taskId: true}}` → `{cid: true}`，给行渲染直接用（有 key 即有在跑的任务）。 */
  const bgTaskRunningMap = useMemo<BoolMap>(() => {
    const out: BoolMap = {};
    for (const [cid, ids] of Object.entries(bgTaskIdsByConv)) {
      if (ids && Object.keys(ids).length > 0) out[cid] = true;
    }
    return out;
  }, [bgTaskIdsByConv]);

  const value: ConversationContextValue = {
    convList,
    runningMap,
    unreadMap,
    bgTaskRunningMap,
    loading,
    error,
    streamConnected,
    everLoaded,
    hasMoreConversations,
    loadingMoreConversations,
    refreshConversations,
    loadMoreConversations,
    addConversationOptimistic,
    removeConversationOptimistic,
    projectConvs,
    projectConvsLoading,
    loadProjectConversations,
    setActiveConversation,
  };

  return (
    <ConversationContext.Provider value={value}>
      <RowTapGuardContext.Provider value={rowTapGuard}>{children}</RowTapGuardContext.Provider>
    </ConversationContext.Provider>
  );
}

/** 对话行点击守卫：菜单开合上报 + 实时抑制判定。value 恒定引用，消费不会随列表更新重渲染。
 *  无 Provider 时返回 no-op 默认（从不抑制）。 */
export function useRowTapGuard(): RowTapGuardValue {
  return useContext(RowTapGuardContext) ?? NOOP_ROW_TAP_GUARD;
}

function useConversationContext(): ConversationContextValue {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('useConversationContext must be used within ConversationProvider');
  return ctx;
}

/** 全局对话列表：updated_at DESC 的**已加载页**（不是全量，见文件头分页说明）。
 *  想要更多用 useConversationPaging().loadMore。消费方自行 slice / filter。 */
export function useConversations(): ConversationListItem[] {
  return useConversationContext().convList;
}

/** 服务端分页状态 + 拉下一页（今日页 onEndReached 用）。 */
export function useConversationPaging(): {
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
} {
  const { hasMoreConversations, loadingMoreConversations, loadMoreConversations } =
    useConversationContext();
  return {
    hasMore: hasMoreConversations,
    loadingMore: loadingMoreConversations,
    loadMore: loadMoreConversations,
  };
}

/** 某项目下的**全部**对话（服务端 ?flowtask_project_id= 过滤，首次消费时自动拉）。
 *  为什么不复用 convList 过滤：convList 现在只有前几页，项目里更老的会话不在里面。 */
export function useProjectConversations(projectId: string): ConversationListItem[] {
  const { projectConvs, loadProjectConversations } = useConversationContext();
  useEffect(() => {
    if (projectId) void loadProjectConversations(projectId);
  }, [projectId, loadProjectConversations]);
  return useMemo(() => projectConvs[projectId] ?? [], [projectConvs, projectId]);
}

/** 某项目会话的加载态 + 强制重拉（项目页下拉刷新用）。 */
export function useProjectConversationsStatus(projectId: string): {
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const { projectConvsLoading, loadProjectConversations } = useConversationContext();
  const refresh = useCallback(
    () => loadProjectConversations(projectId, true),
    [loadProjectConversations, projectId]
  );
  return { loading: Boolean(projectConvsLoading[projectId]), refresh };
}

/** 「进行中」状态 map（conversationId → true）。 */
export function useRunningConvMap(): BoolMap {
  return useConversationContext().runningMap;
}

/** 「未读」状态 map（conversationId → true）。 */
export function useUnreadConvMap(): BoolMap {
  return useConversationContext().unreadMap;
}

/** 「有后台任务在跑」map（conversationId → true）。
 *  与 useRunningConvMap 分开两份：前者是 chat_v2 agent 在跑（服务端列表字段 + conversation_run 事件），
 *  这份是 agent 没跑但后台任务还在跑（只有 inbox SSE 的 inbox_snapshot.tasks / task_status 才有）。
 *  行渲染时取或——Desktop 的 tab ⏳ 就是这么判的（FlopsDesktop index.js panelRunningTasksById）。 */
export function useBgTaskRunningConvMap(): BoolMap {
  return useConversationContext().bgTaskRunningMap;
}

/** 上报「当前正打开着的对话」（ChatScreen 获焦调 setActiveConversation(id)、失焦调 null）。
 *  用于未读闪点守卫：正看着的对话不点未读蓝点。 */
export function useSetActiveConversation(): (id: string | null) => void {
  return useConversationContext().setActiveConversation;
}

/** 列表加载态 / 错误态 / SSE 连接态。 */
export function useConversationsStatus(): {
  loading: boolean;
  error: string | null;
  streamConnected: boolean;
  /** 首次列表请求还没跑完（含还没起步）。列表为空时用它决定画骨架还是画空态。 */
  pending: boolean;
} {
  const { loading, error, streamConnected, everLoaded } = useConversationContext();
  return { loading, error, streamConnected, pending: loading || !everLoaded };
}

/** actions：刷新 / 分页 / 乐观增删（避免整表重拉）。 */
export function useConversationActions(): Pick<
  ConversationContextValue,
  | 'refreshConversations'
  | 'loadMoreConversations'
  | 'loadProjectConversations'
  | 'addConversationOptimistic'
  | 'removeConversationOptimistic'
> {
  const {
    refreshConversations,
    loadMoreConversations,
    loadProjectConversations,
    addConversationOptimistic,
    removeConversationOptimistic,
  } = useConversationContext();
  return {
    refreshConversations,
    loadMoreConversations,
    loadProjectConversations,
    addConversationOptimistic,
    removeConversationOptimistic,
  };
}
