/**
 * 任务/项目本地快照：冷启动首帧**同步**喂给 TaskContext，让今日页一开就有任务行，
 * 不用先看一屏骨架再等网络。做法与 utils/conversationSnapshot 同源，差异见下。
 *
 * 时序（为什么同步读得到）：本模块在 bundle eval 时就把快照读排进 AsyncStorage 队列，
 * 而 TaskProvider 挂载在 App.tsx 的 `session ? ...` 分支里 —— 也就是要等 SessionProvider
 * 那次 `AsyncStorage.getItem(session)` 回来之后才第一次 render。原生侧是串行队列、先进先出，
 * 我们排在 session 那次读**之前**，所以 TaskProvider 首次 render 时快照必然已在内存。
 * 抢不到的话就退化成老行为（今日页画骨架），不额外兜异步——那只会跟网络加载抢着写列表。
 *
 * 存什么：**窄快照**。TaskItem 本体很胖（description / childrenId / relPos / choreZone /
 * periodicZone / childrenEdgeState 全是给项目页画布用的），全量存下来光 JSON.parse 就要在
 * 首帧上花掉十几毫秒，正好抵消秒开。这里只留「今日过滤 + 排序 + 任务行渲染 + 完成动作」
 * 用得到的字段（见 SnapshotTaskRow），读出来时把 TaskItem 结构性必填字段补上安全默认值，
 * 保证任何消费方拿到的都是形状完整的 TaskItem，不会因为少字段而崩。
 * 代价：项目页画布 / 任务详情正文这类深层内容在网络列表回来之前是空的（一般 < 1s），
 * 到货后整表替换即自愈。
 *
 * 顺序：写入时把 todayTasks 排在最前面 —— 万一条数超过 SNAPSHOT_MAX_TASKS 被截断，
 * 保证被丢掉的一定不是今日页要画的那些。tasks 数组本身无序语义，重排安全。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Project, TaskItem } from '../taskApi';

const SNAPSHOT_KEY = '@FlopsMobile/taskSnapshot.v1';
/** 旧缓存：只写不读的两份裸数组（全量 TaskItem / Project）。启动时清掉，别白占空间。 */
const LEGACY_KEYS = ['@FlopsMobile/cachedTasks', '@FlopsMobile/cachedProjects'];

/** 快照最多存多少条任务。今日页一般十来条，多出来的是给项目页/日历页兜底用的。 */
export const SNAPSHOT_MAX_TASKS = 300;

/** 超过这个年龄仍然显示（离线时有总比没有强），但首屏会立刻强制刷新。 */
export const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

/** 落盘防抖：勾选/拖动/乐观更新都会连着改 tasks，攒一下再写。 */
const PERSIST_DEBOUNCE_MS = 800;

/** 快照里的窄任务行。字段取舍见文件头。 */
type SnapshotTaskRow = {
  id: string;
  /** getTaskColor 要（milestone / delegation 走不同配色） */
  type: string;
  project_id: string;
  title: string;
  done: boolean;
  ismine: boolean;
  /** 以下都可空：今日过滤 / 排序 / 时间标签 / 完成态配色要用 */
  done_quality?: string | null;
  doing?: boolean | null;
  priority?: string | null;
  completed_time?: string | null;
  startdatetime?: string | null;
  enddatetime?: string | null;
  note?: string | null;
};

/** 快照里的窄项目行：任务行副标题要项目名，完成动作要验收阶段开关。 */
type SnapshotProjectRow = {
  id: string;
  name?: string | null;
  skip_acceptance_phase?: boolean | null;
  has_acceptance_phase?: boolean | null;
};

export type TaskSnapshot = {
  v: 1;
  userId: string;
  /** 写入时间（Date.now()），用于判陈旧 */
  savedAt: number;
  tasks: SnapshotTaskRow[];
  projects: SnapshotProjectRow[];
};

/** 内存镜像：预热读完 / 每次写入后都更新，渲染期同步读的就是它。 */
let memo: TaskSnapshot | null = null;

const pickTask = (t: TaskItem): SnapshotTaskRow => ({
  id: t.id,
  type: t.type,
  project_id: t.project_id,
  title: t.title,
  done: t.done,
  ismine: t.ismine,
  done_quality: t.done_quality ?? null,
  doing: t.doing ?? null,
  priority: t.priority ?? null,
  completed_time: t.completed_time ?? null,
  startdatetime: t.startdatetime ?? null,
  enddatetime: t.enddatetime ?? null,
  note: t.note ?? null,
});

const pickProject = (p: Project): SnapshotProjectRow => ({
  id: p.id,
  name: p.name ?? null,
  skip_acceptance_phase: p.skip_acceptance_phase ?? null,
  has_acceptance_phase: p.has_acceptance_phase ?? null,
});

/** 窄行 → 形状完整的 TaskItem：没存的结构性字段补安全默认值（数组/坐标不能是 undefined，
 *  否则项目页画布那边 `task.relPos.x` 之类会直接崩）。 */
function toTaskItem(row: SnapshotTaskRow): TaskItem {
  return {
    ...row,
    description: '',
    childrenId: [],
    relPos: { x: 0, y: 0 },
    createddatetime: '',
    lastediteddatetime: '',
    done_quality: row.done_quality ?? undefined,
    doing: row.doing ?? undefined,
    priority: row.priority ?? undefined,
    completed_time: row.completed_time ?? undefined,
    startdatetime: row.startdatetime ?? undefined,
    enddatetime: row.enddatetime ?? undefined,
    note: row.note ?? undefined,
  };
}

function parse(raw: string | null): TaskSnapshot | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as TaskSnapshot;
    if (!obj || obj.v !== 1 || typeof obj.userId !== 'string' || !Array.isArray(obj.tasks)) {
      return null;
    }
    return {
      v: 1,
      userId: obj.userId,
      savedAt: typeof obj.savedAt === 'number' ? obj.savedAt : 0,
      tasks: obj.tasks,
      projects: Array.isArray(obj.projects) ? obj.projects : [],
    };
  } catch {
    return null;
  }
}

/** 预热：模块 import 时就发起（**不要**挪进组件/effect 里，那就晚了，见文件头）。
 *  内部自己吞异常，所以这里不会有 unhandled rejection。 */
async function warmup(): Promise<void> {
  try {
    memo = parse(await AsyncStorage.getItem(SNAPSHOT_KEY));
  } catch {
    memo = null;
  }
  LEGACY_KEYS.forEach((k) => AsyncStorage.removeItem(k).catch(() => {}));
}
warmup();

/** 同步读快照并还原成可直接进 state 的形状；user 不匹配（换账号）或还没预热完则 null。 */
export function readTaskSnapshotSync(
  userId: string
): { tasks: TaskItem[]; projects: Project[]; stale: boolean } | null {
  if (!memo || !userId || memo.userId !== userId) return null;
  return {
    tasks: memo.tasks.map(toTaskItem),
    projects: memo.projects.map((p) => ({ ...p })),
    stale: Date.now() - memo.savedAt > SNAPSHOT_STALE_MS,
  };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pending: (() => TaskSnapshot | null) | null = null;

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
 * 防抖落盘。传的是 **builder** 而非现成对象：定时器到点时才去取最新的 tasks/projects，
 * 这样窗口内连来的多次变更（整表刷新 + 一串乐观更新）只写一次、且写的是最终态。
 */
export function schedulePersistTaskSnapshot(build: () => TaskSnapshot | null): void {
  pending = build;
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
}

/** 组装快照：今日任务排在最前（截断时先丢的一定不是今日的），按 id 去重后截到上限。 */
export function buildTaskSnapshot(
  userId: string,
  tasks: TaskItem[],
  todayTasks: TaskItem[],
  projects: Project[]
): TaskSnapshot {
  const seen = new Set<string>();
  const ordered: SnapshotTaskRow[] = [];
  for (const t of [...todayTasks, ...tasks]) {
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    ordered.push(pickTask(t));
    if (ordered.length >= SNAPSHOT_MAX_TASKS) break;
  }
  return {
    v: 1,
    userId,
    savedAt: Date.now(),
    tasks: ordered,
    projects: projects.map(pickProject),
  };
}

/** 登出 / 换账号：清快照（key 全局共用，留着会让下个账号首帧闪一下上个账号的任务）。 */
export function clearTaskSnapshot(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pending = null;
  memo = null;
  AsyncStorage.removeItem(SNAPSHOT_KEY).catch(() => {});
}
