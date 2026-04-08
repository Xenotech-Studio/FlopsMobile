/**
 * 与 FlowTask Web `src/apis/edgeStateUtils.js` + `taskUtils.jsx` applyChoreLayoutToNodes 对齐：
 * chore 子节点竖向堆叠高度、灰框外接矩形、排序与筛选。
 */
import type { TaskItem } from '../taskApi';
import { TASK_TYPE_CHORE_AREA } from './taskChoreRegion';

export const FLOW_NODE_WIDTH = 150;

export const CHORE_VERTICAL_GAP = 10;
export const CHORE_ALT_OFFSET = 14;
export const CHORE_REGION_PAD = 8;
export const CHORE_REGION_HANDLE_STRIP = 22;
export const CHORE_REGION_TOP_STRIP = 44;
export const CHORE_REGION_BOTTOM_STRIP = 22;
export const CHORE_REGION_HIDDEN_HINT_STRIP = 18;

export const DEFAULT_CHORE_ZONE_TITLE = '杂项';
export const CHORE_SORT_ORDER = 'order';
export const CHORE_SORT_CREATED = 'created';
export const CHORE_SORT_DDL = 'ddl';
export const CHORE_SORT_DIR_ASC = 'asc';
export const CHORE_SORT_DIR_DESC = 'desc';
export const CHORE_FILTER_ALL = 'all';
export const CHORE_FILTER_HIDE_DONE = 'hide_done';
export const CHORE_FILTER_HIDE_WEEK_DONE = 'hide_week_done';
export const CHORE_FILTER_HIDE_MONTH_DONE = 'hide_month_done';

export const DEFAULT_CHORE_OFFSET = { x: 75, y: 108 };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseIsoTs(s: unknown): number | null {
  if (s == null || s === '') return null;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : null;
}

export function taskTypeIsChoreArea(task: TaskItem | null | undefined): boolean {
  return task?.type === TASK_TYPE_CHORE_AREA;
}

export function taskTypeMilestoneLike(taskOrType: TaskItem | string | null | undefined): boolean {
  const type = typeof taskOrType === 'string' ? taskOrType : taskOrType?.type;
  return type === 'milestone' || type === TASK_TYPE_CHORE_AREA;
}

export function normalizeChoreZonePrefs(parentTask: TaskItem | null | undefined) {
  const z =
    parentTask?.choreZone && typeof parentTask.choreZone === 'object'
      ? (parentTask.choreZone as Record<string, unknown>)
      : {};
  const fromZone = typeof z.title === 'string' && z.title.trim() ? z.title.trim() : '';
  const fromTask =
    typeof parentTask?.title === 'string' && parentTask.title.trim() ? parentTask.title.trim() : '';
  const title = fromZone || fromTask || DEFAULT_CHORE_ZONE_TITLE;
  const sort =
    z.sort === CHORE_SORT_CREATED || z.sort === CHORE_SORT_DDL ? z.sort : CHORE_SORT_ORDER;
  const filter =
    z.filter === CHORE_FILTER_HIDE_DONE ||
    z.filter === CHORE_FILTER_HIDE_WEEK_DONE ||
    z.filter === CHORE_FILTER_HIDE_MONTH_DONE
      ? z.filter
      : CHORE_FILTER_ALL;
  const sortDirCreated =
    z.sortDirCreated === CHORE_SORT_DIR_ASC ? CHORE_SORT_DIR_ASC : CHORE_SORT_DIR_DESC;
  const sortDirDdl = z.sortDirDdl === CHORE_SORT_DIR_ASC ? CHORE_SORT_DIR_ASC : CHORE_SORT_DIR_DESC;
  return { title, sort, filter, sortDirCreated, sortDirDdl };
}

export function taskPassesChoreFilter(task: TaskItem, filter: string): boolean {
  if (!task || filter === CHORE_FILTER_ALL) return true;
  if (filter === CHORE_FILTER_HIDE_DONE) return !task.done;
  if (filter === CHORE_FILTER_HIDE_WEEK_DONE) {
    if (!task.done) return true;
    const ct = parseIsoTs(task.completed_time);
    if (ct == null) return false;
    return Date.now() - ct < 7 * MS_PER_DAY;
  }
  if (filter === CHORE_FILTER_HIDE_MONTH_DONE) {
    if (!task.done) return true;
    const ct = parseIsoTs(task.completed_time);
    if (ct == null) return false;
    return Date.now() - ct < 30 * MS_PER_DAY;
  }
  return true;
}

export function normalizeEdgeStateValue(raw: unknown): { kind: string; meta: Record<string, unknown> } {
  if (raw == null) return { kind: 'normal', meta: {} };
  if (typeof raw === 'string') {
    if (raw === 'remote') return { kind: 'remote', meta: {} };
    return { kind: 'normal', meta: {} };
  }
  if (typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string') {
    const { type, ...rest } = raw as { type: string } & Record<string, unknown>;
    if (type === 'remote') return { kind: 'remote', meta: rest };
    if (type === 'chore') return { kind: 'chore', meta: rest };
    return { kind: type, meta: rest };
  }
  return { kind: 'normal', meta: {} };
}

export function edgeStateIsChore(raw: unknown): boolean {
  return normalizeEdgeStateValue(raw).kind === 'chore';
}

export function extractChorePayload(
  raw: unknown
): { order: number; offset: { x: number; y: number } } | null {
  const n = normalizeEdgeStateValue(raw);
  if (n.kind !== 'chore') return null;
  const order = Number.isFinite(n.meta.order as number) ? (n.meta.order as number) : 1e9;
  const ox = (n.meta.offset as { x?: unknown; y?: unknown } | undefined)?.x;
  const oy = (n.meta.offset as { x?: unknown; y?: unknown } | undefined)?.y;
  const offset =
    typeof ox === 'number' && typeof oy === 'number'
      ? { x: ox, y: oy }
      : { ...DEFAULT_CHORE_OFFSET };
  return { order, offset };
}

function parseChoreZoneStoredOffset(z: unknown): { x: number; y: number } | null {
  if (!z || typeof z !== 'object') return null;
  const o = z as { offset?: { x?: unknown; y?: unknown } };
  const ox = o.offset?.x;
  const oy = o.offset?.y;
  if (typeof ox === 'number' && typeof oy === 'number' && Number.isFinite(ox) && Number.isFinite(oy)) {
    return { x: ox, y: oy };
  }
  return null;
}

function pickModeOffset(samples: { x: number; y: number }[]): { x: number; y: number } {
  if (!samples.length) return { ...DEFAULT_CHORE_OFFSET };
  const key = (o: { x: number; y: number }) =>
    `${Math.round(o.x * 10) / 10},${Math.round(o.y * 10) / 10}`;
  const counts = new Map<string, number>();
  for (const o of samples) {
    const k = key(o);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bestKey: string | null = null;
  let bestC = -1;
  for (const [k, c] of counts) {
    if (c > bestC) {
      bestC = c;
      bestKey = k;
    }
  }
  if (!bestKey) return { ...DEFAULT_CHORE_OFFSET };
  const [xs, ys] = bestKey.split(',').map(Number);
  return { x: xs, y: ys };
}

export function getChoreRegionModeOffset(parentTask: TaskItem): { x: number; y: number } {
  const cz = parentTask.choreZone as { unifiedBody?: unknown; offset?: unknown } | undefined;
  if (taskTypeIsChoreArea(parentTask) && cz?.unifiedBody) {
    const z = parentTask.choreZone && typeof parentTask.choreZone === 'object' ? parentTask.choreZone : {};
    const fromZone = parseChoreZoneStoredOffset(z);
    return fromZone ? { ...fromZone } : { x: 0, y: 0 };
  }
  const z = parentTask?.choreZone && typeof parentTask.choreZone === 'object' ? parentTask.choreZone : {};
  const fromZone = parseChoreZoneStoredOffset(z);
  if (fromZone) return { ...fromZone };

  const es = parentTask?.childrenEdgeState || {};
  const ids = (parentTask?.childrenId || [])
    .map(String)
    .filter((cid) => edgeStateIsChore((es as Record<string, unknown>)[cid]));
  const samples = ids
    .map((cid) => extractChorePayload((es as Record<string, unknown>)[cid])?.offset)
    .filter(
      (o): o is { x: number; y: number } =>
        !!o &&
        typeof o.x === 'number' &&
        typeof o.y === 'number' &&
        Number.isFinite(o.x) &&
        Number.isFinite(o.y)
    );
  if (samples.length > 0) return pickModeOffset(samples);
  return { ...DEFAULT_CHORE_OFFSET };
}

/**
 * 与 EditableNode 一致的节点卡片高度估算（flow 坐标）。
 */
export function estimateFlowNodeBodyHeight(task: TaskItem | Record<string, unknown>): number {
  const t = task as TaskItem;
  if (taskTypeIsChoreArea(t)) {
    return computeChoreRegionOuterHeight([], 0);
  }
  const fontSize = Number((t as { fontSize?: unknown }).fontSize) || 14;
  const lineHeightPx = fontSize * 1.5;
  const padSide = Math.max(0, (40 - fontSize) / 2);
  const textInnerW = Math.max(48, FLOW_NODE_WIDTH - 2 - 2 * padSide);
  const avgCharPx = fontSize * 0.58;
  const title = String(t?.title ?? '');
  const cjkRe = /[\u3000-\u9fff\uac00-\ud7af]/;
  const charsPerLineForSegment = (segment: string) =>
    cjkRe.test(segment)
      ? Math.max(6, Math.floor(textInnerW / fontSize))
      : Math.max(8, Math.floor(textInnerW / avgCharPx));

  const countLogicalLines = (text: string) => {
    if (!text) return 1;
    return text.split('\n').reduce((acc, segment) => {
      if (segment.length === 0) return acc + 1;
      const cpl = charsPerLineForSegment(segment);
      return acc + Math.max(1, Math.ceil(segment.length / cpl));
    }, 0);
  };

  const lines = countLogicalLines(title);
  const padV = 40 - fontSize;
  const baseline = Math.max(52, padV + 2 + lineHeightPx);
  let h = baseline + Math.max(0, lines - 1) * lineHeightPx;

  const milestoneLike = taskTypeMilestoneLike(t);
  if (milestoneLike && t?.collapsible) {
    h += 34;
  } else if (milestoneLike && t?.icon) {
    h += 6;
  }

  return Math.round(h);
}

export function sumChoreStackHeights(choreTasks: TaskItem[], gap = CHORE_VERTICAL_GAP): number {
  if (!choreTasks?.length) return 0;
  const heights = choreTasks.map((x) => estimateFlowNodeBodyHeight(x));
  const n = heights.length;
  return heights.reduce((a, b) => a + b, 0) + Math.max(0, n - 1) * gap;
}

export function getChoreRegionOuterWidth(): number {
  return FLOW_NODE_WIDTH + 2 * CHORE_REGION_PAD + 2 * CHORE_ALT_OFFSET + 2 * CHORE_REGION_HANDLE_STRIP;
}

export function computeChoreRegionOuterHeight(
  choreChildTasks: TaskItem[],
  hiddenChoreCount = 0
): number {
  const innerH =
    Array.isArray(choreChildTasks) && choreChildTasks.length > 0
      ? sumChoreStackHeights(choreChildTasks)
      : estimateFlowNodeBodyHeight({});
  const hintStrip =
    typeof hiddenChoreCount === 'number' && hiddenChoreCount > 0
      ? CHORE_REGION_HIDDEN_HINT_STRIP
      : 0;
  return (
    CHORE_REGION_PAD * 2 +
    innerH +
    CHORE_REGION_TOP_STRIP +
    hintStrip +
    CHORE_REGION_BOTTOM_STRIP
  );
}

export function computeChoreRegionRect(
  parentPos: { x: number; y: number },
  modeOffset: { x: number; y: number },
  choreChildTasks: TaskItem[],
  hiddenChoreCount = 0
) {
  const w = getChoreRegionOuterWidth();
  const h = computeChoreRegionOuterHeight(choreChildTasks, hiddenChoreCount);
  const left = parentPos.x + modeOffset.x;
  const top = parentPos.y + modeOffset.y;
  return { left, top, right: left + w, bottom: top + h, width: w, height: h };
}

export function getChoreDisplayOrderedItems(parentTask: TaskItem, taskMap: Map<string, TaskItem>) {
  const es = parentTask?.childrenEdgeState || {};
  const ids = (parentTask?.childrenId || [])
    .map(String)
    .filter((cid) => edgeStateIsChore((es as Record<string, unknown>)[cid]));

  const prefs = normalizeChoreZonePrefs(parentTask);
  const items = ids.map((childId) => ({
    childId,
    order: extractChorePayload((es as Record<string, unknown>)[childId])?.order ?? 1e9,
    task: taskMap.get(String(childId)),
  }));

  items.sort((a, b) => {
    if (prefs.sort === CHORE_SORT_CREATED) {
      const ka = parseIsoTs(a.task?.createddatetime);
      const kb = parseIsoTs(b.task?.createddatetime);
      const sa = ka == null ? Number.POSITIVE_INFINITY : ka;
      const sb = kb == null ? Number.POSITIVE_INFINITY : kb;
      if (sa !== sb) {
        const cmp = sa < sb ? -1 : 1;
        return prefs.sortDirCreated === CHORE_SORT_DIR_DESC ? -cmp : cmp;
      }
    } else if (prefs.sort === CHORE_SORT_DDL) {
      const ka = parseIsoTs(a.task?.enddatetime);
      const kb = parseIsoTs(b.task?.enddatetime);
      const sa = ka == null ? Number.POSITIVE_INFINITY : ka;
      const sb = kb == null ? Number.POSITIVE_INFINITY : kb;
      if (sa !== sb) {
        const cmp = sa < sb ? -1 : 1;
        return prefs.sortDirDdl === CHORE_SORT_DIR_DESC ? -cmp : cmp;
      }
    } else if (a.order !== b.order) {
      return a.order - b.order;
    }
    return String(a.childId).localeCompare(String(b.childId), undefined, { numeric: true });
  });

  const orderedVisible: { childId: string; task: TaskItem }[] = [];
  const hiddenIds: string[] = [];
  for (const it of items) {
    if (!it.task) continue;
    if (taskPassesChoreFilter(it.task, prefs.filter))
      orderedVisible.push({ childId: it.childId, task: it.task });
    else hiddenIds.push(it.childId);
  }
  return { orderedVisible, hiddenIds };
}

function cmpUnicode(a: string, b: string, ignoreCase = true): number {
  const na = a.normalize('NFC');
  const nb = b.normalize('NFC');
  const sa = ignoreCase ? na.toLowerCase() : na;
  const sb = ignoreCase ? nb.toLowerCase() : nb;
  const len = Math.min(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const ca = sa.codePointAt(i)!;
    const cb = sb.codePointAt(i)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (ca > 0xffff) i++;
  }
  return sa.length === sb.length ? 0 : sa.length < sb.length ? -1 : 1;
}

const normalizeId = (id: string | null | undefined): string | null =>
  id == null ? null : String(id);

export type ChoreLayoutGraphNode = {
  id: string;
  position: { x: number; y: number };
  task: TaskItem;
  parents: string[];
  children: string[];
  activePrimaryParentId: string | null;
  hidden?: boolean;
};

/**
 * 列吸附 / DAG 之后调用：按 chore 边覆盖子节点坐标，并标记筛选隐藏子节点（与 Web 一致）。
 */
export function applyChoreLayoutToFlowGraph(
  nodes: ChoreLayoutGraphNode[],
  taskMap: Map<string, TaskItem>,
  childToParents: Map<string, string[]>,
  /** 可折叠里程碑已折叠时的后代 id（与 `hiddenNodeIdsForCollapsedMilestones` 一致）：不参与竖条堆叠 */
  milestoneHidden: Set<string>
): void {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const n of nodes) {
    const id = String(n.id);
    const parents = childToParents.get(id) || [];
    const task = taskMap.get(id);
    const explicit = normalizeId(task?.primaryParentId ?? null);
    const primary =
      explicit && parents.includes(explicit) ? explicit : parents.length ? minStrChore(parents) : null;
    if (!primary) continue;
    const parentTask = taskMap.get(String(primary));
    const raw = parentTask?.childrenEdgeState?.[id];
    if (edgeStateIsChore(raw)) {
      n.hidden = false;
    }
  }

  const resolvePrimary = (taskId: string): string | null => {
    const id = String(taskId);
    const task = taskMap.get(id);
    if (!task) return null;
    const parents = childToParents.get(id) || [];
    const explicit = normalizeId(task.primaryParentId ?? null);
    if (explicit && parents.includes(explicit)) return explicit;
    return parents.length ? minStrChore(parents) : null;
  };

  const groups = new Map<string, { childId: string; order: number; offset: { x: number; y: number } }[]>();
  for (const n of nodes) {
    const p = resolvePrimary(n.id);
    if (!p) continue;
    const parentTask = taskMap.get(p);
    if (!parentTask?.childrenEdgeState) continue;
    const raw = parentTask.childrenEdgeState[n.id];
    if (!edgeStateIsChore(raw)) continue;
    const payload = extractChorePayload(raw);
    if (!payload) continue;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push({ childId: n.id, order: payload.order, offset: payload.offset });
  }

  for (const [, list] of groups) {
    list.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return cmpUnicode(String(a.childId), String(b.childId), true);
    });
  }

  const OFF_X = 10000;

  for (const [parentId] of groups) {
    const parentNode = nodeById.get(parentId);
    if (!parentNode) continue;
    const parentTask = taskMap.get(String(parentId));
    if (!parentTask) continue;
    const modeOffset = getChoreRegionModeOffset(parentTask);
    const wOuter = getChoreRegionOuterWidth();
    const anchorX = parentNode.position.x + modeOffset.x + wOuter / 2;
    const anchorY = parentNode.position.y + modeOffset.y;
    let yCursor = anchorY + CHORE_REGION_PAD + CHORE_REGION_TOP_STRIP;

    const { orderedVisible, hiddenIds } = getChoreDisplayOrderedItems(parentTask, taskMap);

    let layoutIndex = 0;
    let parkK = 0;
    orderedVisible.forEach((entry) => {
      const childNode = nodeById.get(entry.childId);
      if (!childNode) return;
      if (milestoneHidden.has(entry.childId)) {
        childNode.position = {
          x: parentNode.position.x + OFF_X,
          y: parentNode.position.y + parkK * 8,
        };
        parkK += 1;
        return;
      }
      const tk = entry.task;
      const nodeH = estimateFlowNodeBodyHeight(tk || {});
      const centerShift = layoutIndex % 2 === 0 ? -CHORE_ALT_OFFSET : CHORE_ALT_OFFSET;
      const topLeftX = anchorX + centerShift - FLOW_NODE_WIDTH / 2;
      const topLeftY = yCursor;
      childNode.hidden = false;
      childNode.position = { x: topLeftX, y: topLeftY };
      yCursor += nodeH + CHORE_VERTICAL_GAP;
      layoutIndex += 1;
    });

    hiddenIds.forEach((hid, j) => {
      const childNode = nodeById.get(hid);
      if (!childNode) return;
      childNode.hidden = true;
      const topLeftX = parentNode.position.x + OFF_X;
      const topLeftY = parentNode.position.y + j * 8;
      childNode.position = { x: topLeftX, y: topLeftY };
    });
  }
}

function minStrChore(list: string[]): string | null {
  if (list.length === 0) return null;
  let m = list[0];
  for (let i = 1; i < list.length; i++) {
    if (cmpUnicode(list[i], m) < 0) m = list[i];
  }
  return m;
}
