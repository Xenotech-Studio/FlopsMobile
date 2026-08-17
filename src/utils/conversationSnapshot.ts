/**
 * 会话列表本地快照：冷启动首帧**同步**喂给 ConversationContext，让今日页/抽屉一开就有内容，
 * 不再是「空列表 + 菊花 → 网络回来才长出行」。
 *
 * 为什么不是 MMKV：真正需要的不是「任意时刻可同步读」，而是「首帧渲染那一刻内存里已有数据」。
 * App 的首帧本来就 gate 在 SessionProvider 恢复 session 的那次 AsyncStorage 读上
 * （App.tsx: isLoading → 全屏 ActivityIndicator），而 AsyncStorage 的原生侧是串行队列
 * （iOS methodQueue / Android SerialExecutor），先排队的先回。所以：
 *
 *   bundle eval（本模块 import）就把快照读排进队列  →  React 首次 render  →
 *   SessionProvider effect 排 session 读（排在我们后面）  →  session 到手、isLoading=false
 *
 * session 落地那一刻快照必然已在内存（`memo`），ConversationProvider 在**渲染期**同步读它即可，
 * 等价于 Web 侧栏 `useState(() => localStorage...)` 的秒开效果，却不必引入 MMKV +
 * react-native-nitro-modules 这一整套原生依赖（新 pod = 全平台重新出包）。
 * 队列万一没赶上（首帧极快 / 冷启动 IO 抖动），`ensureSnapshot()` 兜异步路径，退化成旧行为。
 *
 * 存的是「最近一次成功的列表响应」的窄快照：行（标题已是本地解密后的明文，跟旧缓存一致——
 * 密文要解需要 K_user，那是异步的，就没法同步 seed 了）+ running/unread 快照 + 时间戳 + user_id。
 * user_id 用来防串号：换账号时旧快照直接不认。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ConversationListItem } from '../api';

const SNAPSHOT_KEY = '@FlopsMobile/convSnapshot.v1';
/** 旧版缓存（裸数组，无 user_id / 时间戳）。启动时清掉，避免留一份没人读的死数据。 */
const LEGACY_KEY = '@FlopsMobile/cachedConversations';

/** 快照最多存多少行。首屏只画 10 行、服务端一页 20 行——存 40 够「首帧 + 滚两屏」都不见白，
 *  同时让冷启动那次刷新（按快照行数重拉，见 ConversationContext.loadConvs）不至于变成大请求。 */
export const SNAPSHOT_MAX_ROWS = 40;

/** 超过这个年龄的快照仍然显示（离线/弱网时有总比没有强），但首屏会立刻强制后台刷新。 */
export const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

/** 快照落盘防抖：SSE 改 running/unread 是高频事件，攒一下再写。 */
const PERSIST_DEBOUNCE_MS = 800;

type BoolMap = Record<string, boolean>;

export type ConversationSnapshot = {
  v: 1;
  userId: string;
  /** 写入时间（Date.now()），用于判陈旧 */
  savedAt: number;
  rows: ConversationListItem[];
  running: BoolMap;
  unread: BoolMap;
};

/** 内存镜像：预热读完 / 每次写入后都更新，渲染期同步读的就是它。 */
let memo: ConversationSnapshot | null = null;

function parse(raw: string | null): ConversationSnapshot | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as ConversationSnapshot;
    if (!obj || obj.v !== 1 || typeof obj.userId !== 'string' || !Array.isArray(obj.rows)) {
      return null;
    }
    return {
      v: 1,
      userId: obj.userId,
      savedAt: typeof obj.savedAt === 'number' ? obj.savedAt : 0,
      rows: obj.rows,
      running: obj.running && typeof obj.running === 'object' ? obj.running : {},
      unread: obj.unread && typeof obj.unread === 'object' ? obj.unread : {},
    };
  } catch {
    return null;
  }
}

/** 预热：模块 import 时就发起（**不要**挪进组件/effect 里，那就晚了，见文件头）。 */
const warmup: Promise<void> = (async () => {
  try {
    memo = parse(await AsyncStorage.getItem(SNAPSHOT_KEY));
  } catch {
    memo = null;
  }
  AsyncStorage.removeItem(LEGACY_KEY).catch(() => {});
})();

/** 同步读快照；user 不匹配（换账号）或还没预热完则返回 null。 */
export function readSnapshotSync(userId: string): ConversationSnapshot | null {
  if (!memo || !userId || memo.userId !== userId) return null;
  return memo;
}

/** 异步兜底：等预热读完再取一次（同步路径没赶上时用）。 */
export async function ensureSnapshot(userId: string): Promise<ConversationSnapshot | null> {
  try {
    await warmup;
  } catch {
    /* ignore */
  }
  return readSnapshotSync(userId);
}

/** 快照是否已陈旧（>24h）。陈旧仍然显示，但调用方应立刻强制刷新。 */
export function isSnapshotStale(snap: ConversationSnapshot | null): boolean {
  if (!snap) return true;
  return Date.now() - snap.savedAt > SNAPSHOT_STALE_MS;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pending: (() => ConversationSnapshot | null) | null = null;

function flushPersist() {
  persistTimer = null;
  const build = pending;
  pending = null;
  if (!build) return;
  const snap = build();
  if (!snap) return;
  memo = snap;
  AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap)).catch(() => {});
}

/**
 * 防抖落盘。传的是 **builder** 而非现成对象：定时器到点时才去取最新的 rows/maps，
 * 这样窗口内连来的多次变更（列表刷新 + 一串 SSE 帧）只写一次、且写的是最终态。
 */
export function schedulePersistSnapshot(build: () => ConversationSnapshot | null): void {
  pending = build;
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
}

/** 组装快照：行截到 SNAPSHOT_MAX_ROWS，两个 map 只留这些行的 true 项（别让 map 无限长）。 */
export function buildSnapshot(
  userId: string,
  rows: ConversationListItem[],
  running: BoolMap,
  unread: BoolMap
): ConversationSnapshot {
  const kept = rows.slice(0, SNAPSHOT_MAX_ROWS);
  const pickFlags = (src: BoolMap): BoolMap => {
    const out: BoolMap = {};
    kept.forEach((c) => {
      if (src[c.id]) out[c.id] = true;
    });
    return out;
  };
  return {
    v: 1,
    userId,
    savedAt: Date.now(),
    rows: kept,
    running: pickFlags(running),
    unread: pickFlags(unread),
  };
}

/** 登出 / 换账号：清快照（key 全局共用，留着会让下个账号首帧闪一下上个账号的标题）。 */
export function clearSnapshot(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pending = null;
  memo = null;
  AsyncStorage.removeItem(SNAPSHOT_KEY).catch(() => {});
}
