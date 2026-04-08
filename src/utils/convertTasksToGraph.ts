/**
 * 任务列表 → 流程图节点/边：与 FlowTask Web `src/apis/taskUtils.jsx` 的 convertTasksToGraph 对齐。
 * 若相对坐标塌缩（全堆在同一点），则套用 DAG 分层备用布局，避免移动端只看到一坨节点。
 */
import type { TaskItem } from '../taskApi';
import { applyChoreLayoutToFlowGraph } from './choreFlowLayout';

/** 与 Web 节点卡片尺寸一致，用于备用分层间距 */
const LAYOUT_W = 150;
const LAYOUT_H = 100;
const LAYOUT_GAP_X = 48;
const LAYOUT_GAP_Y = 40;

function readRelPos(task: TaskItem): { x: number; y: number } {
  const rp = task.relPos as { x?: unknown; y?: unknown } | null | undefined;
  if (!rp || typeof rp !== 'object') return { x: 0, y: 0 };
  const x = Number(rp.x);
  const y = Number(rp.y);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

/**
 * 仅当所有节点四舍五入后落在同一点时才视为塌缩（避免误伤「竖条/窄列」等合法布局）。
 */
function positionsCollapsed(nodes: FlowGraphNode[]): boolean {
  if (nodes.length <= 1) return false;
  const keys = new Set(nodes.map((n) => `${Math.round(n.position.x)}_${Math.round(n.position.y)}`));
  return keys.size === 1;
}

/** 与 Web FlowChart `SNAP_THRESHOLD` 一致 */
const SNAP_THRESHOLD = 10;

/**
 * 列吸附每轮约 O(n²)，全量项目数百节点 × 多轮会在 RN 主线程卡死 → 看门狗杀进程。
 * 超过此数量跳过吸附，仅用 relPos 递归结果（结构仍正确，列可能与 Web 略有偏差）。
 */
const MAX_NODES_FOR_COLUMN_SNAP = 280;

/** 节点多时每轮次数必须少；小图可略多轮以贴近 Web */
const SNAP_PASSES_SMALL = 18;
const SNAP_PASSES_TINY = 10;

/**
 * Web 在拖动/同步子树时用：
 *   child.x = getSnappedX(parent, nodes) + relPos.x
 *   child.y = parent.position.y + relPos.y
 * 纯递归 parent.position + relPos 与列对齐后的画布不一致；这里多轮松弛逼近网页最终几何。
 */
function getSnappedXForFlowNode(
  node: FlowGraphNode,
  nodeList: FlowGraphNode[],
  byId: Map<string, FlowGraphNode>,
  threshold: number
): number {
  let snapX = node.position.x;
  let minDx = threshold + 1;
  const ny = node.position.y;
  const nx = node.position.x;
  for (const anchor of nodeList) {
    if (anchor.id === node.id) continue;
    if (ny <= anchor.position.y) continue;
    const dx = Math.abs(nx - anchor.position.x);
    if (dx < minDx) {
      minDx = dx;
      snapX = anchor.position.x;
    }
  }
  for (const childId of node.children) {
    const childNode = byId.get(childId);
    if (!childNode || childNode.parents.length <= 1) continue;
    const dx = Math.abs(nx - childNode.position.x);
    if (dx < minDx) {
      minDx = dx;
      snapX = childNode.position.x;
    }
  }
  return snapX;
}

/** 沿主父链 BFS 深度，用于每轮按层处理（与 Web 子树同步顺序一致） */
function computePrimaryTreeDepth(nodes: FlowGraphNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (n.parents.length === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  if (queue.length === 0) {
    for (const n of nodes) depth.set(n.id, 0);
    return depth;
  }
  while (queue.length) {
    const id = queue.shift()!;
    const n = byId.get(id);
    if (!n) continue;
    const d = depth.get(id)!;
    for (const cid of n.children) {
      const child = byId.get(cid);
      if (!child) continue;
      if (String(child.activePrimaryParentId ?? '') !== id) continue;
      const next = d + 1;
      if (!depth.has(cid) || depth.get(cid)! > next) {
        depth.set(cid, next);
        queue.push(cid);
      }
    }
  }
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, 0);
  }
  return depth;
}

function applyWebColumnSnap(nodes: FlowGraphNode[], threshold: number, maxPasses: number): void {
  if (nodes.length === 0) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = computePrimaryTreeDepth(nodes);
  /** 主父深度 + id 排序即可；每轮按 y 重排成本高且对收敛非必须 */
  const sortedTemplate = [...nodes].sort((a, b) => {
    const da = depth.get(a.id) ?? 0;
    const db = depth.get(b.id) ?? 0;
    if (da !== db) return da - db;
    return cmpUnicode(a.id, b.id);
  });

  for (let pass = 0; pass < maxPasses; pass++) {
    let maxDelta = 0;
    for (const n of sortedTemplate) {
      const rp = readRelPos(n.task);
      const primary = n.activePrimaryParentId;
      const prevX = n.position.x;
      const prevY = n.position.y;
      if (!primary || !byId.has(primary)) {
        const nx = getSnappedXForFlowNode(n, nodes, byId, threshold);
        n.position = { x: nx, y: n.position.y };
      } else {
        const parent = byId.get(primary)!;
        n.position = {
          x: getSnappedXForFlowNode(parent, nodes, byId, threshold) + rp.x,
          y: parent.position.y + rp.y,
        };
      }
      maxDelta = Math.max(maxDelta, Math.abs(n.position.x - prevX), Math.abs(n.position.y - prevY));
    }
    if (maxDelta < 0.5) break;
  }
}

/**
 * 按 DAG 最长父链分层，层内按 id 排序铺排；不替代 Web 上有效的 relPos，仅在塌缩时启用。
 */
function applyDAGLayerLayout(nodes: FlowGraphNode[]): void {
  if (nodes.length === 0) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, 0);

  const maxIter = Math.max(nodes.length * 3, 8);
  for (let i = 0; i < maxIter; i++) {
    let changed = false;
    for (const n of nodes) {
      let d = 0;
      if (n.parents.length > 0) {
        const pd: number[] = [];
        for (const pid of n.parents) {
          if (!byId.has(pid)) continue;
          const v = depth.get(pid);
          if (v !== undefined) pd.push(v);
        }
        if (pd.length > 0) d = Math.max(...pd) + 1;
      }
      const prev = depth.get(n.id)!;
      if (d > prev) {
        depth.set(n.id, d);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byLevel = new Map<number, FlowGraphNode[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byLevel.has(d)) byLevel.set(d, []);
    byLevel.get(d)!.push(n);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const d of levels) {
    const row = byLevel.get(d)!;
    row.sort((a, b) => cmpUnicode(a.id, b.id));
    row.forEach((n, i) => {
      n.position = {
        x: i * (LAYOUT_W + LAYOUT_GAP_X),
        y: d * (LAYOUT_H + LAYOUT_GAP_Y),
      };
    });
  }
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

export function minStr(list: string[]): string | null {
  if (list.length === 0) return null;
  let m = list[0];
  for (let i = 1; i < list.length; i++) {
    if (cmpUnicode(list[i], m) < 0) m = list[i];
  }
  return m;
}

const normalizeId = (id: string | null | undefined): string | null =>
  id == null ? null : String(id);

export interface FlowGraphNode {
  id: string;
  position: { x: number; y: number };
  parents: string[];
  children: string[];
  activePrimaryParentId: string | null;
  task: TaskItem;
  /** chore 区筛选隐藏（与 Web Flow node.hidden 一致） */
  hidden?: boolean;
}

export interface FlowGraphEdge {
  id: string;
  source: string;
  target: string;
}

export function convertTasksToGraph(tasks: TaskItem[]): {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
} {
  const taskMap = new Map(tasks.map((t) => [String(t.id), t]));

  const childToParents = new Map<string, string[]>();
  tasks.forEach((t) => {
    const pid = String(t.id);
    (t.childrenId || []).map(String).forEach((cId) => {
      if (!childToParents.has(cId)) childToParents.set(cId, []);
      childToParents.get(cId)!.push(pid);
    });
  });

  const cache = new Map<string, FlowGraphNode>();
  const nodes: FlowGraphNode[] = [];
  const visited = new Set<string>();

  const makeNode = (rawId: string | number): FlowGraphNode | null => {
    const id = String(rawId);
    if (cache.has(id)) return cache.get(id)!;

    const task = taskMap.get(id);
    if (!task) return null;

    if (visited.has(id)) {
      console.warn(`检测到循环引用: ${id}, 任务: ${task.title}`);
      return null;
    }
    visited.add(id);

    const parents = childToParents.get(id) || [];
    const explicitPrimary = normalizeId(task.primaryParentId ?? null);
    const primary =
      explicitPrimary && parents.includes(explicitPrimary)
        ? explicitPrimary
        : parents.length
          ? minStr(parents)
          : null;

    const rp = readRelPos(task);
    let position: { x: number; y: number };
    if (primary !== null) {
      const pNode = makeNode(primary);
      if (pNode) {
        position = {
          x: pNode.position.x + rp.x,
          y: pNode.position.y + rp.y,
        };
      } else {
        position = { ...rp };
      }
    } else {
      position = { ...rp };
    }

    const node: FlowGraphNode = {
      id,
      position,
      parents,
      children: (task.childrenId || []).map(String),
      activePrimaryParentId: primary,
      task,
    };

    cache.set(id, node);
    nodes.push(node);
    return node;
  };

  tasks.forEach((t) => {
    makeNode(t.id);
  });

  const edges: FlowGraphEdge[] = tasks.flatMap((t) =>
    (t.childrenId || []).map((cId) => ({
      id: `e${t.id}-${cId}`,
      source: String(t.id),
      target: String(cId),
    }))
  );

  // 与 Web FlowChart 列对齐（大图跳过，避免 O(n²) 卡死 RN）
  if (nodes.length <= MAX_NODES_FOR_COLUMN_SNAP) {
    const passes = nodes.length <= 120 ? SNAP_PASSES_SMALL : SNAP_PASSES_TINY;
    applyWebColumnSnap(nodes, SNAP_THRESHOLD, passes);
  }

  if (positionsCollapsed(nodes)) {
    applyDAGLayerLayout(nodes);
  }

  const milestoneHidden = hiddenNodeIdsForCollapsedMilestones(tasks, nodes);
  applyChoreLayoutToFlowGraph(nodes, taskMap, childToParents, milestoneHidden);

  return { nodes, edges };
}

/** 沿 children 展开后代 id（与 Web FlowChart getDescendantIds 一致） */
export function getDescendantIds(nodes: Pick<FlowGraphNode, 'id' | 'children'>[], rootId: string): Set<string> {
  const idMap = new Map(nodes.map((n) => [n.id, n]));
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = idMap.get(id);
    if (!node || !node.children?.length) continue;
    for (const cid of node.children) {
      if (!result.has(cid)) {
        result.add(cid);
        stack.push(cid);
      }
    }
  }
  return result;
}

/** 可折叠里程碑折叠时隐藏其后代（与 Web FlowChart 一致） */
export function hiddenNodeIdsForCollapsedMilestones(
  tasks: TaskItem[],
  graphNodes: FlowGraphNode[]
): Set<string> {
  const hidden = new Set<string>();
  tasks.forEach((t) => {
    if (t.type === 'milestone' && t.collapsible && t.collapsed) {
      getDescendantIds(graphNodes, String(t.id)).forEach((id) => hidden.add(id));
    }
  });
  return hidden;
}

export function isEdgeRemote(parentTask: TaskItem | undefined, childId: string): boolean {
  const st = parentTask?.childrenEdgeState?.[childId];
  return st === 'remote';
}

/** 无序投放边（chore）：与 Web childrenEdgeState `{ type: 'chore', ... }` 一致 */
export function isEdgeChore(parentTask: TaskItem | undefined, childId: string): boolean {
  const raw = parentTask?.childrenEdgeState?.[String(childId)];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return (raw as { type?: unknown }).type === 'chore';
}
