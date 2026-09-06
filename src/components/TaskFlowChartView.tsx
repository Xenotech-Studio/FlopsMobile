/**
 * 只读流程图：布局与 Web FlowTask convertTasksToGraph 一致；外观尽量对齐
 * EditableNode.css + FlowChart 点阵底 + CustomEdge 样式。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  ensureFlowViewports,
  flowViewportsReady,
  flushFlowViewports,
  readFlowViewport,
  saveFlowViewport,
} from '../utils/flowViewportStore';
import { normalizeServerUrl, DEFAULT_SERVER_URL } from '../config';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  useAnimatedReaction,
  runOnJS,
  runOnUI,
} from 'react-native-reanimated';
import Svg, { Path, Defs, Pattern, Rect as SvgRect, Circle, Text as SvgText } from 'react-native-svg';
import type { TaskItem } from '../taskApi';
import { useAppTheme } from '../context/ThemeContext';
import {
  convertTasksToGraph,
  getDescendantIds,
  hiddenNodeIdsForCollapsedMilestones,
  isEdgeChore,
  isEdgeRemote,
} from '../utils/convertTasksToGraph';
import {
  displayTitleForChoreLikeParent,
  taskTypeIsChoreLikeRegion,
  taskTypeIsPeriodicGroup,
} from '../utils/taskChoreRegion';
import {
  CHORE_REGION_PAD as CHORE_REGION_PAD_WEB,
  computeChoreRegionRect,
  estimateFlowNodeBodyHeight,
  computeChoreRegionOuterHeight,
  getChoreLikeDisplayOrderedItems,
  getChoreRegionModeOffset,
} from '../utils/choreFlowLayout';

/** 与 Web `EditableNode.css` `.editable-node` width */
export const FLOW_NODE_WIDTH = 150;
/** 无换行时的最小卡片高度（与 Web padding 公式一致） */

/**
 * 【临时调试】流程图诊断日志。
 *
 * RN 0.84 起 console.log 不再进 Metro 终端（"JavaScript logs have moved" → DevTools），
 * 真机排查时开发者拿不到。所以除了照常 console.log，再 fire-and-forget 发一份到服务端的
 * `/api/debug/mobile_log`，落成文件后可由 GET 读回。
 *
 * 只在 __DEV__ 下发；失败完全静默（诊断日志不该反过来影响被诊断的功能）。
 * **排查完请连同服务端那两个 debug 端点一起删掉。**
 */
/** 实例序号：同一时刻可能有多个流程图挂着（工作区一个、项目页一个），
 *  日志经独立 fetch 上报、时间戳还是服务端给的 —— 不带身份就会被误读成同一条链。 */
let flowInstanceSeq = 0;
export function nextFlowInstanceTag(): string {
  flowInstanceSeq += 1;
  return `#${flowInstanceSeq}`;
}

function flowLog(msg: string): void {
  if (!__DEV__) return;
  console.log(msg);
  try {
    /* 固定用默认网关：这条通道只在 __DEV__ 下走，且诊断的是布局几何、不涉及账号数据，
       不值得为它把 session 一路传进这个纯展示组件。 */
    const base = normalizeServerUrl(DEFAULT_SERVER_URL);
    void fetch(`${base}api/debug/mobile_log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [msg] }),
    }).catch(() => {});
  } catch {
    /* 静默 */
  }
}

const MIN_CARD_HEIGHT = 40;
const FONT_SIZE = 14;
const LINE_HEIGHT = 21; // 1.5em
const PAD_V = (40 - FONT_SIZE) / 2; // Web: calc((40px - 1em) / 2)
const MILESTONE_ICON_SLOT = 28; // 与 Web milestone-icon top≈-25 + 余量
/** Web `.milestone-collapse-btn`：marginTop 4 + 约 12px/1.4 行高 + padding */
const MILESTONE_COLLAPSE_HINT_EXTRA = 4 + 4 + Math.ceil(12 * 1.4);
const DOT_GAP = 12;
const DOT_R = 1;
const DOT_FILL = '#d4d4d8';

const PAD = 48;

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

/**
 * 流程图画布**捏合**缩放范围。MIN 只管手指捏合的下限（再小就糊得没法看），
 * **不该拿去钳「缩到全图」那次 fit** —— 见 FIT_MIN_SCALE。
 */
const MIN_FLOW_SCALE = 0.35;
const MAX_FLOW_SCALE = 3.5;
/**
 * fit（缩到全图）允许到的最小比例。
 *
 * 为什么不能复用 MIN_FLOW_SCALE：大图会被它顶住。实测一个 5153×3220 的项目在 402×266 的
 * 工作区里，真正的全图比例是 min(378/5153, 242/3220) ≈ 0.073，被 0.35 的下限顶上去之后
 * 内容宽 1804pt 塞进 402pt 视口 —— clampFlowCanvasPan 只好把它钉在左上角，屏幕上就是
 * 那张图的左上角一小块；而节点都在别处，于是**一个都不在视口里**，看起来完全空白
 * （裁剪日志里 visibleNodes=0/142 就是这么来的，裁剪本身没算错）。
 * 宁可小到看不清也要先让人看见全貌 —— 看不清可以捏合放大，空白则无从下手。
 */
const FIT_MIN_SCALE = 0.02;

/** Web `:root` 浅色（`FlowTask/src/index.css`） */
const WEB = {
  text: '#333333',
  edge: '#b1b1b7',
  surface: '#ffffff',
  pane: '#ffffff',
  doneFill: '#D9F5D6',
  doneStroke: '#62D256',
  doneReviewingFill: '#62D256',
  doneReviewingStroke: '#53B349',
  wastedFill: '#fff3cd',
  wastedStroke: '#D98C34',
  pendingFill: '#e0ebff',
  pendingStroke: '#3672f4',
  todoFill: '#fff3cd',
  todoStroke: '#D98C34',
  urgentFill: '#FFA53D',
  urgentStroke: '#ff9800',
  milestoneFill: '#e2e2e2',
  milestoneStroke: '#adadad',
  milestoneDoneFill: '#e6fde6',
  milestoneDoneStroke: '#b8eab8',
  delegationFill: '#ECE2FE',
  delegationStroke: '#935AF6',
  /** Web `--color-surface-secondary` / `--color-text-tertiary`：无序区节点与围框 */
  choreSurface: '#f8f9fa',
  choreBorder: '#9ca3af',
  choreLabel: '#888888',
  choreEdge: '#94a3b8',
};

const FONT_FAMILY = Platform.select({ ios: 'Arial', android: 'sans-serif', default: 'Arial' });

function taskMapById(tasks: TaskItem[]): Map<string, TaskItem> {
  return new Map(tasks.map((t) => [String(t.id), t]));
}

function hasUnfinishedChildren(task: TaskItem, byId: Map<string, TaskItem>): boolean {
  if (!task.childrenId?.length) return false;
  return task.childrenId.some((cid) => {
    const c = byId.get(String(cid));
    return c && !c.done;
  });
}

/** 与 Web `EditableNode` stateClass 一致；chore_area 对齐 Web 无序区节点 */
function getWebNodeColors(task: TaskItem, byId: Map<string, TaskItem>): { fill: string; stroke: string } {
  const dq = task.done_quality || 'reviewing';
  const pr = task.priority || 'default';

  if (taskTypeIsChoreLikeRegion(task)) {
    return { fill: WEB.choreSurface, stroke: WEB.choreBorder };
  }
  if (task.type === 'milestone') {
    return task.done
      ? { fill: WEB.milestoneDoneFill, stroke: WEB.milestoneDoneStroke }
      : { fill: WEB.milestoneFill, stroke: WEB.milestoneStroke };
  }
  if (task.type === 'delegation') {
    if (task.done) {
      if (dq === 'reviewing') return { fill: WEB.doneReviewingFill, stroke: WEB.doneReviewingStroke };
      if (dq === 'wasted') return { fill: WEB.wastedFill, stroke: WEB.wastedStroke };
      return { fill: WEB.doneFill, stroke: WEB.doneStroke };
    }
    return { fill: WEB.delegationFill, stroke: WEB.delegationStroke };
  }
  if (task.done) {
    if (dq === 'reviewing') return { fill: WEB.doneReviewingFill, stroke: WEB.doneReviewingStroke };
    if (dq === 'wasted') return { fill: WEB.wastedFill, stroke: WEB.wastedStroke };
    return { fill: WEB.doneFill, stroke: WEB.doneStroke };
  }
  if (hasUnfinishedChildren(task, byId) || pr === 'later') {
    return { fill: WEB.pendingFill, stroke: WEB.pendingStroke };
  }
  if (pr === 'now') return { fill: WEB.urgentFill, stroke: WEB.urgentStroke };
  return { fill: WEB.todoFill, stroke: WEB.todoStroke };
}

function milestoneIconChar(task: TaskItem): string | null {
  if (task.type !== 'milestone' || !task.icon) return null;
  const s = String(task.icon).trim();
  return s.length ? s : null;
}

/** 与 Web Handle bottom → top 一致的平滑贝塞尔 */
function bezierPathD(sx: number, sy: number, tx: number, ty: number): string {
  const dy = ty - sy;
  const offset = Math.max(Math.abs(dy) * 0.5, 40);
  const c1x = sx;
  const c1y = sy + offset;
  const c2x = tx;
  const c2y = ty - offset;
  return `M ${sx} ${sy} C ${c1x} ${c1y} ${c2x} ${c2y} ${tx} ${ty}`;
}

function clampFlowCanvasPan(
  tx: number,
  ty: number,
  vw: number,
  vh: number,
  cw: number,
  ch: number
): { x: number; y: number } {
  let nx = tx;
  let ny = ty;
  if (cw <= vw) nx = (vw - cw) / 2;
  else nx = Math.min(0, Math.max(vw - cw, tx));
  if (ch <= vh) ny = (vh - ch) / 2;
  else ny = Math.min(0, Math.max(vh - ch, ty));
  return { x: nx, y: ny };
}

function clampFlowCanvasPanWorklet(
  tx: number,
  ty: number,
  vw: number,
  vh: number,
  cw: number,
  ch: number
): { x: number; y: number } {
  'worklet';
  let nx = tx;
  let ny = ty;
  if (cw <= vw) nx = (vw - cw) / 2;
  else nx = Math.min(0, Math.max(vw - cw, tx));
  if (ch <= vh) ny = (vh - ch) / 2;
  else ny = Math.min(0, Math.max(vh - ch, ty));
  return { x: nx, y: ny };
}

/** 进入流程图 / 画布或视口变化：按视口 fit 整张图（尽可能缩小至全图可见），并用 clamp 规则居中 */
function fitFlowChartToViewport(
  viewportW: number,
  viewportH: number,
  canvasW: number,
  canvasH: number
): { scale: number; translateX: number; translateY: number } {
  if (viewportW <= 0 || viewportH <= 0 || canvasW <= 0 || canvasH <= 0) {
    return { scale: 1, translateX: 0, translateY: 0 };
  }
  const inset = 12;
  const vw = Math.max(1, viewportW - inset * 2);
  const vh = Math.max(1, viewportH - inset * 2);
  const sRaw = Math.min(vw / canvasW, vh / canvasH);
  /* 下限用 FIT_MIN_SCALE 而不是 MIN_FLOW_SCALE：后者是捏合下限，拿来钳 fit 会让大图
     根本缩不到全图（见 FIT_MIN_SCALE 的注释）。 */
  const scale = Math.min(MAX_FLOW_SCALE, Math.max(FIT_MIN_SCALE, sRaw));
  const cw = canvasW * scale;
  const ch = canvasH * scale;
  const c = clampFlowCanvasPan(0, 0, viewportW, viewportH, cw, ch);
  return { scale, translateX: c.x, translateY: c.y };
}

type NodeDraw = {
  id: string;
  x: number;
  y: number;
  cardH: number;
  fill: string;
  stroke: string;
  title: string;
  icon: string | null;
  isChoreArea: boolean;
  /** 可折叠里程碑且已折叠：后代数量，用于「N个已折叠」（与 Web EditableNode 一致） */
  milestoneCollapsedDescendantCount?: number;
};

/** 与节点卡片外沿一致（里程碑含图标占位） */
function nodeOuterBounds(n: NodeDraw): { minX: number; minY: number; maxX: number; maxY: number } {
  const top = n.y - (n.icon ? MILESTONE_ICON_SLOT : 0);
  let bottom = n.y + n.cardH;
  if (n.milestoneCollapsedDescendantCount != null) {
    bottom += MILESTONE_COLLAPSE_HINT_EXTRA;
  }
  return {
    minX: n.x,
    minY: top,
    maxX: n.x + FLOW_NODE_WIDTH,
    maxY: bottom,
  };
}

type WorldRect = { minX: number; minY: number; maxX: number; maxY: number };

function rectsOverlap(a: WorldRect, b: WorldRect): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/** 三次贝塞尔落在控制点凸包内，取四控制点 AABB 作保守包围盒，供视口裁剪（跨屏长线仍保留） */
function bezierPathBounds(sx: number, sy: number, tx: number, ty: number): WorldRect {
  const dy = ty - sy;
  const offset = Math.max(Math.abs(dy) * 0.5, 40);
  const c1x = sx;
  const c1y = sy + offset;
  const c2x = tx;
  const c2y = ty - offset;
  const pad = 3;
  return {
    minX: Math.min(sx, tx, c1x, c2x) - pad,
    maxX: Math.max(sx, tx, c1x, c2x) + pad,
    minY: Math.min(sy, ty, c1y, c2y) - pad,
    maxY: Math.max(sy, ty, c1y, c2y) + pad,
  };
}

type ChoreRegionDraw = {
  parentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  labelCx: number;
  labelBaselineY: number;
};

/** 与 Web `computeChoreRegionRect` + `getChoreLikeDisplayOrderedItems` 一致（chore / periodic_group） */
function buildChoreRegionDraws(
  nodes: NodeDraw[],
  byId: Map<string, TaskItem>,
  visibleNodeIds: Set<string>
): ChoreRegionDraw[] {
  const out: ChoreRegionDraw[] = [];
  for (const n of nodes) {
    const task = byId.get(n.id);
    if (!task || !taskTypeIsChoreLikeRegion(task)) continue;
    const modeOffset = getChoreRegionModeOffset(task);
    const { orderedVisible, hiddenIds } = getChoreLikeDisplayOrderedItems(task, byId);
    const choreTasks = orderedVisible
      .filter((x) => visibleNodeIds.has(x.childId))
      .map((x) => x.task);
    const includeHStagger = !taskTypeIsPeriodicGroup(task);
    const rect = computeChoreRegionRect(
      { x: n.x, y: n.y },
      modeOffset,
      choreTasks,
      hiddenIds.length,
      includeHStagger
    );
    const label = displayTitleForChoreLikeParent(task);
    const labelCx = rect.left + rect.width / 2;
    const labelBaselineY = rect.top + CHORE_REGION_PAD_WEB + 20;
    out.push({
      parentId: n.id,
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height,
      label,
      labelCx,
      labelBaselineY,
    });
  }
  return out;
}

function boundsOfCanvas(nodes: NodeDraw[]) {
  const vis = nodes.filter((n) => !n.isChoreArea);
  if (vis.length === 0) {
    return { minX: 0, minY: 0, maxX: FLOW_NODE_WIDTH, maxY: MIN_CARD_HEIGHT };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of vis) {
    const b = nodeOuterBounds(n);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

type EdgeDrawItem = {
  id: string;
  d: string;
  dashed: boolean;
  choreLink: boolean;
  bounds: WorldRect;
};

type FlowChartBuiltModel = {
  svgW: number;
  svgH: number;
  edgesDraw: EdgeDrawItem[];
  nodesDraw: NodeDraw[];
  choreRegionsDraw: ChoreRegionDraw[];
  chartError: string | null;
};

function emptyFlowModel(): FlowChartBuiltModel {
  return {
    svgW: Math.max(320, FLOW_NODE_WIDTH + PAD * 2),
    svgH: Math.max(200, MIN_CARD_HEIGHT + PAD * 2),
    edgesDraw: [],
    nodesDraw: [],
    choreRegionsDraw: [],
    chartError: null,
  };
}

/**
 * 纯函数：建图逻辑。**勿在 React render 同步路径调用**（应在 runAfterInteractions / rAF 里跑），
 * 否则与 reconcile 叠在一起易 ANR；栈溢出类错误 try/catch 也未必可靠。
 *
 * 任务数 / 世界尺寸不再硬性封顶：视口 Svg 已避免整图超大位图崩溃；超大项目仍可能因建图耗时、
 * 全量 Path/节点 View 数量导致卡顿或内存压力，属设备与数据规模问题。
 */
function buildFlowChartPayload(tasks: TaskItem[]): FlowChartBuiltModel {
  try {
    const byIdInner = taskMapById(tasks);
    const { nodes: rawNodes, edges: rawEdges } = convertTasksToGraph(tasks);
    const hidden = hiddenNodeIdsForCollapsedMilestones(tasks, rawNodes);
    const choreFilteredHidden = new Set(rawNodes.filter((n) => n.hidden).map((n) => n.id));
    const nodes = rawNodes.filter((n) => !hidden.has(n.id) && !n.hidden);
    const visibleIdSet = new Set(nodes.map((n) => n.id));
    const edges = rawEdges.filter(
      (e) =>
        !hidden.has(e.source) &&
        !hidden.has(e.target) &&
        !choreFilteredHidden.has(e.source) &&
        !choreFilteredHidden.has(e.target)
    );

    const heightById = new Map<string, number>();
    for (const n of nodes) {
      const t = n.task;
      if (taskTypeIsChoreLikeRegion(t)) {
        const cd = getChoreLikeDisplayOrderedItems(t, byIdInner);
        const choreTasksVisible = cd.orderedVisible
          .filter((x) => visibleIdSet.has(x.childId))
          .map((x) => x.task);
        heightById.set(n.id, computeChoreRegionOuterHeight(choreTasksVisible, cd.hiddenIds.length));
      } else {
        heightById.set(n.id, estimateFlowNodeBodyHeight(t));
      }
    }

    const nodesDrawInner: NodeDraw[] = nodes.map((n) => {
      const { fill, stroke } = getWebNodeColors(n.task, byIdInner);
      const isChoreArea = taskTypeIsChoreLikeRegion(n.task);
      const title = isChoreArea ? displayTitleForChoreLikeParent(n.task) : n.task.title || ' ';
      const t = n.task;
      const milestoneCollapsedDescendantCount =
        t.type === 'milestone' && t.collapsible && t.collapsed
          ? getDescendantIds(rawNodes, n.id).size
          : undefined;
      return {
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        cardH: heightById.get(n.id) ?? MIN_CARD_HEIGHT,
        fill,
        stroke,
        title,
        icon: milestoneIconChar(n.task),
        isChoreArea,
        milestoneCollapsedDescendantCount,
      };
    });

    const choreRegionsWorld = buildChoreRegionDraws(nodesDrawInner, byIdInner, visibleIdSet);
    const nodeBox = boundsOfCanvas(nodesDrawInner);
    let minX = nodeBox.minX;
    let minY = nodeBox.minY;
    let maxX = nodeBox.maxX;
    let maxY = nodeBox.maxY;
    for (const r of choreRegionsWorld) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }

    const ox = PAD - minX;
    const oy = PAD - minY;

    const shifted = nodesDrawInner.map((n) => ({ ...n, x: n.x + ox, y: n.y + oy }));
    const idToDraw = new Map(shifted.map((n) => [n.id, n]));

    const choreRegionsShifted: ChoreRegionDraw[] = choreRegionsWorld.map((r) => ({
      ...r,
      x: r.x + ox,
      y: r.y + oy,
      labelCx: r.labelCx + ox,
      labelBaselineY: r.labelBaselineY + oy,
    }));
    const choreRectByParentId = new Map(choreRegionsShifted.map((r) => [r.parentId, r]));

    const edgesDrawInner = edges
      .map((e) => {
        const pa = idToDraw.get(e.source);
        const ch = idToDraw.get(e.target);
        if (!pa || !ch) return null;
        const parentTask = byIdInner.get(e.source);
        if (parentTask && taskTypeIsChoreLikeRegion(parentTask) && isEdgeChore(parentTask, e.target)) {
          return null;
        }
        const srcRect = choreRectByParentId.get(e.source);
        const tgtRect = choreRectByParentId.get(e.target);
        const sx = srcRect ? srcRect.x + srcRect.w / 2 : pa.x + FLOW_NODE_WIDTH / 2;
        const sy = srcRect ? srcRect.y + srcRect.h : pa.y + pa.cardH;
        const tx = tgtRect ? tgtRect.x + tgtRect.w / 2 : ch.x + FLOW_NODE_WIDTH / 2;
        const ty = tgtRect ? tgtRect.y : ch.y;
        const dashed = isEdgeRemote(parentTask, e.target);
        const choreLink = isEdgeChore(parentTask, e.target);
        return {
          id: e.id,
          d: bezierPathD(sx, sy, tx, ty),
          dashed,
          choreLink,
          bounds: bezierPathBounds(sx, sy, tx, ty),
        };
      })
      .filter(Boolean) as EdgeDrawItem[];

    const svgWInner = Math.ceil(maxX - minX + PAD * 2);
    const svgHInner = Math.ceil(maxY - minY + PAD * 2);

    const svgW = Math.max(svgWInner, FLOW_NODE_WIDTH + PAD * 2);
    const svgH = Math.max(svgHInner, MIN_CARD_HEIGHT + PAD * 2);

    return {
      svgW,
      svgH,
      edgesDraw: edgesDrawInner,
      nodesDraw: shifted,
      choreRegionsDraw: choreRegionsShifted,
      chartError: null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (__DEV__) {
      console.error('[TaskFlowChartView] buildFlowChartPayload', e);
    }
    return { ...emptyFlowModel(), chartError: msg };
  }
}

export type TaskFlowChartViewProps = {
  tasks: TaskItem[];
  topInset?: number;
  /**
   * 底部被浮层盖住的高度。跟 topInset 同款做法（root 的 padding），于是量到的 panSlot
   * 就是**真正看得见**的那块，「缩到全图并居中」也居中在这块里。
   * 协同工作区要用：那儿底下压着聊天 sheet，不减掉的话图会居中到 sheet 后面去。
   */
  bottomInset?: number;
  /**
   * 放在横向翻页器（走马灯）里时置 true：把画布的**横向**拖拽让给翻页器。
   *
   * 不让的话手指横划会被画布的 Pan 吃掉 —— 用户**划不出这一页**，走马灯等于卡死在流程图上。
   * 代价是画布只能纵向拖；但进场就已经"缩到全图可见"，横向本来也没什么可拖的，
   * 真要看细节还有双指缩放，以及走马灯的圆点可以直接点着切页。
   */
  insidePager?: boolean;
  /**
   * 缓存视口（缩放 + 平移）的 key。有缓存就恢复、没有才「缩到全图」；不传 = 不缓存。
   *
   * **必须带上"哪个界面"，不能只用 projectId。** Desktop 那侧只用 projectId 是因为它同一
   * 时刻只有一块画布；移动端不是 —— 项目页和协同工作区可以**同时挂着**同一个项目的图，
   * 而两者的可视区差得远（整屏 402×874 vs 工作区那条带）。共用一个 key 的话两个实例会
   * 互相覆盖：A 存的视口被 B 读走、B 存的又被 A 读走，恢复出来的比例和平移都是给另一块
   * 画布算的 —— 真机上表现为"切回来一片空白"。
   */
  viewportCacheKey?: string;
  /**
   * 画布底色。默认聊天页画布色（ProjectScreen 的原样）；协同工作区传工作区底色
   * （drawerBackground），让流程图跟它所在的那层同色，不再是一块突兀的白板。
   */
  backgroundColor?: string;
};

/** 与 Web `FlowChart.css` --flow-chore-region-fill / `EditableNode.css` .chore-area-unified 一致 */
const CHORE_REGION_FILL_LIGHT = 'rgba(120, 120, 130, 0.16)';
const CHORE_REGION_FILL_DARK = 'rgba(100, 100, 110, 0.18)';

export function TaskFlowChartView({
  tasks,
  topInset = 0,
  bottomInset = 0,
  insidePager = false,
  viewportCacheKey,
  backgroundColor,
}: TaskFlowChartViewProps) {
  const { colors, isDark } = useAppTheme();
  const canvasBg = backgroundColor ?? colors.chatScreenBackground;
  /** 本实例的日志身份（见 nextFlowInstanceTag）。用 ref 读而不是解构成 const ——
   *  后者会被 exhaustive-deps 当成响应式值，逼所有日志所在的 hook 都加一条无意义依赖。 */
  const tagRef = useRef(nextFlowInstanceTag());
  const choreRegionFill = isDark ? CHORE_REGION_FILL_DARK : CHORE_REGION_FILL_LIGHT;
  /** 与 Web 画布边线浅色 #b1b1b7、深色 #3e3e3e 一致 */
  const choreRegionStroke = isDark ? '#3e3e3e' : WEB.edge;
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const win = useWindowDimensions();
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const startPanX = useSharedValue(0);
  const startPanY = useSharedValue(0);
  const pinchStartScale = useSharedValue(1);
  const pinchStartTx = useSharedValue(0);
  const pinchStartTy = useSharedValue(0);
  const pinchFocalX = useSharedValue(0);
  const pinchFocalY = useSharedValue(0);
  const vpW = useSharedValue(0);
  const vpH = useSharedValue(0);
  const canvasW = useSharedValue(0);
  const canvasH = useSharedValue(0);
  /**
   * 捏合能缩到的**下限**。常态是 MIN_FLOW_SCALE，但大图 fit 出来的比例可能比它还小 ——
   * 那就以 fit 为准，否则用户一捏合就被弹回 0.35、又回到"只看得见左上角"的状态。
   */
  const minPinchScale = useSharedValue(MIN_FLOW_SCALE);
  /**
   * 视口是否已被「恢复的缓存」或「用户手势」接管 —— 接管后**不再自动 fit**。
   *
   * 对齐 Desktop：它只在切项目且无缓存时 fitView，之后窗口怎么变都不再自动重排。
   * 我们这边 effViewport 会随 sheet 换档变化，不设这个闸的话每换一档就把用户调好的
   * 视口顶掉。反过来，在用户还没碰、也没恢复过之前保留自动 fit —— 首帧可能用的是
   * 窗口尺寸兜底值，等真实 onLayout 回来还得靠它再摆一次。
   */
  const viewportOwnedRef = useRef(false);
  /** 视口缓存预热完成的信号：预热没赶上首帧时，读到 null 会先走 fit；
   *  预热回来后 bump 一下让上面那条决策 effect 重跑，把缓存补上。 */
  const [viewportPrefsTick, setViewportPrefsTick] = useState(0);
  useEffect(() => {
    if (flowViewportsReady()) return;
    let cancelled = false;
    void ensureFlowViewports().then(() => {
      if (!cancelled) setViewportPrefsTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  /** 最后一次有效视口：卸载时用它落盘，不在 cleanup 里现读 shared value。 */
  const lastViewportRef = useRef<{ scale: number; tx: number; ty: number } | null>(null);

  /**
   * 【视口三元组一次性写到 UI 线程】—— 不要在 JS 线程上直接 `scale.value = ...`。
   *
   * Reanimated **4** 换掉了 shared value 在 JS 侧的语义
   * （node_modules/react-native-reanimated/src/mutables.ts → makeMutableNative）：
   *
   *   set value → scheduleOnUI(...)   // 异步**排队**，本 tick 不生效
   *   get value → runOnUISync(...)    // 同步**插队**，读的是 UI 线程此刻的值
   *
   * 两个后果，我们两个都踩到了：
   *
   * 1. JS 线程上「写完立刻读」必然读到写之前的值 —— 探针日志里那条
   *    `restore-applied readback scale=1 tx=41 ty=337` 就是这么来的，不是"另一个实例"。
   * 2. 更要命：任何「JS 线程读-改-写」都会拿**过期值**算出结果、再排到别人的写入
   *    后面，把刚恢复/fit 好的视口整个覆盖掉。applyClamp 原来就是这么干的，
   *    它把 restore 写的 (-1413.8, -1257.2) 换成了拿旧值 (41,337) 钳出来的 (0,0)
   *    —— 5153×3220 的图钉在左上角，屏幕上就是一片空白。
   *
   * 所以视口写入统一收进 UI 线程的一个 worklet：三个值原子落地（不会出现"scale 换了、
   * translate 还没换"的中间帧），也天然跟手势 / clamp 的写入排在同一条队列上。
   */
  const applyViewportOnUI = useCallback(
    (s: number, tx: number, ty: number, minScale: number, label: string) => {
      runOnUI(
        (nextScale: number, nextTx: number, nextTy: number, nextMin: number, tag: string) => {
          'worklet';
          scale.value = nextScale;
          translateX.value = nextTx;
          translateY.value = nextTy;
          minPinchScale.value = nextMin;
          if (tag) {
            /* 读回探针只能在 UI 线程做 —— JS 侧读不到刚排队的写入（见上）。 */
            runOnJS(flowLog)(
              `[flowchart]${tag} applied scale=${scale.value}` +
                ` tx=${translateX.value} ty=${translateY.value}`,
            );
          }
        },
      )(s, tx, ty, minScale, label);
    },
    [scale, translateX, translateY, minPinchScale],
  );

  /**
   * 【有效视口】panSlot 的 onLayout 是主来源；**量不到时用窗口尺寸减 inset 兜底**。
   *
   * 起因：协同工作区把这个组件放进了 PagerView 的懒挂载页里，真机上出现过 onLayout 没给出
   * 有效尺寸的情况 —— viewport 停在 {0,0}，于是下面 slotW/slotH 取 Math.max(1, 0) = 1，
   * Svg 只有 1×1 → **画布什么都画不出来，而 panSlot(flex:1) 和底部提示条照常占位**，
   * 看起来就是"一大片空白 + 一条提示"。fit 那条 effect 也因为 viewport<=0 直接早退，
   * 于是连 transform 都没算过。
   *
   * 兜底值只是估算（窗口高减去上下 inset），一旦真的 onLayout 回来会立刻被覆盖 —— fit 与
   * viewBox 都挂在这两个值上，会跟着重算。ProjectScreen 那边量得到，走不到兜底分支。
   */
  const effViewportW = viewport.w > 1 ? viewport.w : Math.max(1, win.width);
  /* 兜底**不减 inset**：9d07aab 之后 root 不再吃 padding、panSlot 是全出血的，实测回来
     就是整屏高（日志实证 measured=402x874）。减了的话下面 fit 会把 inset 再扣一遍，
     bandH 变负 → 钳成 1px → scale 掉到 FIT_MIN_SCALE(0.02)，画面看起来就是"飘了"。 */
  const effViewportH = viewport.h > 1 ? viewport.h : Math.max(1, win.height);

  const [model, setModel] = useState<FlowChartBuiltModel>(() => emptyFlowModel());
  const [isBuilding, setIsBuilding] = useState(false);
  /** 世界坐标下当前视口（含边距）；与 Svg viewBox 同源。null 表示尚未同步，先渲染全部节点避免闪空 */
  const [visibleWorldRect, setVisibleWorldRect] = useState<WorldRect | null>(null);
  const visibleRectQuantizedKeyRef = useRef('');

  const { svgW, svgH, edgesDraw, nodesDraw, choreRegionsDraw, chartError } = model;

  /** 每次图构建完成且视口已量好：自动「缩小到能看见全图」并居中 */
  useEffect(() => {
    if (isBuilding || chartError || svgW <= 0 || svgH <= 0 || effViewportW <= 0 || effViewportH <= 0) {
      return;
    }
    /**
     * **模型还没真建出来就不要 fit。** emptyFlowModel 给的是占位画布（320×200），
     * 拿它算出来的比例（378/320 = 1.18125）跟真实图（5153×3220 → 0.073）差十几倍，
     * 摆过去等于把视口钉在一个几百 pt 的小窗口里，真实节点一个都不在里面。
     * Desktop 的 FitViewOnLoad 有同款守卫（nodeCount>0 才 fitView，否则挂起等节点到位）。
     */
    if (nodesDraw.length === 0) return;
    /* 已被缓存恢复 / 用户手势接管：不再自动重排（见 viewportOwnedRef）。 */
    if (viewportOwnedRef.current) return;
    /**
     * **必须等 panSlot 真的量出来再做决策**，不能拿窗口兜底值凑合。
     *
     * 兜底值只是为了让 Svg 别退化成 1×1（画布空白那次的修法），它跟真实可视区可能差很多；
     * 拿它去 fit 会算出一个错的比例，拿它去校验缓存（showsNodes）还会**误判**：同一条缓存
     * 在 402x266 下算出来"看不见节点"、在真实的 402x874 下其实看得见，于是好端端的视口被
     * 当成坏值丢掉、改摆成全图 —— 用户感受就是"切回来视口飘了"。
     * 量到之前这条 effect 直接挂起，viewport 一到位它自己会重跑（effViewport 在依赖里）。
     */
    if (!(viewport.w > 1 && viewport.h > 1)) return;
    /**
     * 【恢复缓存 与 缩到全图 是同一个决策，必须在同一处做】
     *
     * 之前拆成两条 effect，靠先后顺序碰运气 —— 而 restore 因为也加了 nodesDraw 守卫而变晚，
     * 结果**总在 fit 之后跑、无条件把 fit 覆盖掉**（日志实证：fit 算出 0.067，18ms 后
     * restore 写回 1.18125）。缓存里但凡有一条坏值，正确的 fit 就永远出不来。
     *
     * 所以合成一处：先试缓存，**且缓存必须通过"这个视口里真的看得见节点"这条校验**，
     * 过不了就当没有、老老实实 fit。校验直接对着 nodesDraw 做相交测试，跟用户看到的
     * "有没有东西"完全同源 —— 不管坏值是怎么进来的（历史 bug、换了设备尺寸、图重排过），
     * 都能自愈，不用再靠换 storage key 去擦。
     * 合法的深度放大不会被误伤：那种视口里必然框着它放大的那个节点。
     */
    const cached = viewportCacheKey ? readFlowViewport(viewportCacheKey) : null;
    if (cached) {
      const m = 120 / (cached.scale < 0.0001 ? 0.0001 : cached.scale);
      const minX = -cached.tx / cached.scale;
      const minY = -cached.ty / cached.scale;
      const rect = {
        minX: minX - m,
        minY: minY - m,
        maxX: minX + effViewportW / cached.scale + m,
        maxY: minY + effViewportH / cached.scale + m,
      };
      const showsSomething = nodesDraw.some((n) => rectsOverlap(nodeOuterBounds(n), rect));
      if (__DEV__) {
        flowLog(
          `[flowchart]${tagRef.current} restore key=${viewportCacheKey} scale=${cached.scale}` +
            ` tx=${cached.tx} ty=${cached.ty} showsNodes=${showsSomething}`,
        );
      }
      if (showsSomething) {
        applyViewportOnUI(
          cached.scale,
          cached.tx,
          cached.ty,
          /* 恢复值可能低于捏合下限（大图），放宽下限否则一捏就被弹回去。 */
          Math.min(MIN_FLOW_SCALE, cached.scale),
          __DEV__ ? `${tagRef.current} restore` : '',
        );
        lastViewportRef.current = { scale: cached.scale, tx: cached.tx, ty: cached.ty };
        viewportOwnedRef.current = true;
        visibleRectQuantizedKeyRef.current = '';
        return;
      }
      /* 这条缓存看不见任何东西 —— 无论什么原因，都不如重新 fit。 */
    }
    /**
     * 【画布铺满、内容只在"看得见的那条带"里居中】
     *
     * root 不再吃 topInset/bottomInset —— 那会把 panSlot 连同背景一起缩掉，画布就在顶栏
     * 渐变和 sheet 上沿被切一刀。现在背景/点阵铺满整个组件，**只有 fit 按 inset 收窄**：
     * 在 (整宽, 整高 − 上下 inset) 里算居中，再把 ty 整体下移 topInset。
     * 于是内容落在 header 与 sheet 之间那条带子里，而画布本身一直延伸到它们后面 ——
     * 跟普通聊天页"消息滚到顶栏后面渐隐"是同一套观感。
     */
    const bandH = Math.max(1, effViewportH - topInset - bottomInset);
    const { scale: s, translateX: tx, translateY: tyBand } = fitFlowChartToViewport(
      effViewportW,
      bandH,
      svgW,
      svgH
    );
    const ty = tyBand + topInset;
    applyViewportOnUI(
      s,
      tx,
      ty,
      /* fit 比常规捏合下限还小（大图）时，把下限放宽到 fit —— 否则捏一下就弹回去。 */
      Math.min(MIN_FLOW_SCALE, s),
      __DEV__ ? `${tagRef.current} fit` : '',
    );
    visibleRectQuantizedKeyRef.current = '';
    /**
     * **fit 的结果不写缓存**，只更新 lastViewportRef。
     *
     * 缓存的语义是「用户上次把图调到哪儿」，自动算出来的 fit 不属于用户意图；而且写进去
     * 一旦算错（就像上面那次拿占位画布算出的 1.18125），下次挂载会被 restore 读回来并
     * 置 owned，把正确的 fit 永久挡掉 —— 实测正是这么白屏的。
     * 没有缓存的项目每次进来重新 fit 即可，本来就是期望行为。
     */
    lastViewportRef.current = { scale: s, tx, ty };
    if (__DEV__) {
      flowLog(`[flowchart]${tagRef.current} fit vp=${effViewportW}x${effViewportH} svg=${svgW}x${svgH}` +
          ` -> scale=${s} tx=${tx} ty=${ty}` +
          ` finite=${Number.isFinite(s) && Number.isFinite(tx) && Number.isFinite(ty)}`,
      );
    }
  }, [
    isBuilding,
    chartError,
    svgW,
    svgH,
    effViewportW,
    effViewportH,
    applyViewportOnUI,
    nodesDraw,
    viewportCacheKey,
    viewportPrefsTick,
    topInset,
    bottomInset,
    viewport.w,
    viewport.h,
  ]);

  useEffect(() => {
    if (tasks.length === 0) {
      setModel(emptyFlowModel());
      setIsBuilding(false);
      return;
    }

    setIsBuilding(true);
    let cancelled = false;
    let raf = 0;
    raf = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        const next = buildFlowChartPayload(tasks);
        if (!cancelled) {
          setModel(next);
          setIsBuilding(false);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (__DEV__) {
          console.error('[TaskFlowChartView] runAfterInteractions build threw', e);
        }
        if (!cancelled) {
          setModel({ ...emptyFlowModel(), chartError: msg });
          setIsBuilding(false);
        }
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [tasks]);


  /** 手势结束 / fit 落定后记一笔（worklet 侧经 runOnJS 调到这儿）。 */
  const commitViewport = useCallback(
    (sc: number, tx: number, ty: number) => {
      lastViewportRef.current = { scale: sc, tx, ty };
      viewportOwnedRef.current = true;
      if (viewportCacheKey) saveFlowViewport(viewportCacheKey, { scale: sc, tx, ty });
    },
    [viewportCacheKey],
  );

  /* 卸载（切走 / 换项目）时立刻落盘：别把最后一次调整留在防抖窗口里丢掉。
     用 lastViewportRef 而不是在 cleanup 里现读 shared value —— 与 Desktop 同一条教训
     （它那边卸载时 store.transform 已被重置，现读会把默认原点写盘覆盖正确视口）。 */
  useEffect(() => {
    const key = viewportCacheKey;
    return () => {
      const vp = lastViewportRef.current;
      if (key && vp) saveFlowViewport(key, vp);
      flushFlowViewports();
    };
  }, [viewportCacheKey]);

  useEffect(() => {
    canvasW.value = svgW;
    canvasH.value = svgH;
    if (__DEV__) flowLog(`[flowchart]${tagRef.current} canvas svgW=${svgW} svgH=${svgH}`);
  }, [svgW, svgH, canvasW, canvasH]);

  useEffect(() => {
    vpW.value = effViewportW;
    vpH.value = effViewportH;
    if (__DEV__) {
      flowLog(`[flowchart]${tagRef.current} effViewport w=${effViewportW} h=${effViewportH}` +
          ` (measured ${viewport.w}x${viewport.h}, win ${win.width}x${win.height},` +
          ` insets top=${topInset} bottom=${bottomInset})`,
      );
    }
  }, [effViewportW, effViewportH, vpW, vpH, viewport.w, viewport.h, win.width, win.height, topInset, bottomInset]);

  useEffect(() => {
    visibleRectQuantizedKeyRef.current = '';
  }, [nodesDraw, edgesDraw]);

  /* 诊断：裁剪矩形每次真正变化时打一条（已被 visibleRectQuantizedKeyRef 节流，不会刷屏）。 */
  const publishVisibleWorldRect = useCallback(
    (minX: number, minY: number, vw: number, vh: number, s: number, rawTx = 0, rawTy = 0) => {
      const safeS = s < 0.0001 ? 0.0001 : s;
      const marginWorld = 120 / safeS;
      const maxX = minX + vw;
      const maxY = minY + vh;
      const q = 20;
      const key = [
        Math.round(minX / q),
        Math.round(minY / q),
        Math.round(vw / q),
        Math.round(vh / q),
      ].join(',');
      if (key === visibleRectQuantizedKeyRef.current) return;
      visibleRectQuantizedKeyRef.current = key;
      const rect = {
        minX: minX - marginWorld,
        minY: minY - marginWorld,
        maxX: maxX + marginWorld,
        maxY: maxY + marginWorld,
      };
      if (__DEV__) {
        flowLog(`[flowchart]${tagRef.current} visibleRect x=[${Math.round(rect.minX)},${Math.round(rect.maxX)}]` +
            ` y=[${Math.round(rect.minY)},${Math.round(rect.maxY)}] scale=${s}` +
            ` rawTx=${Math.round(rawTx)} rawTy=${Math.round(rawTy)}`,
        );
      }
      setVisibleWorldRect(rect);
    },
    []
  );

  useAnimatedReaction(
    () => {
      const s = scale.value;
      const safe = s < 0.0001 ? 0.0001 : s;
      const w = vpW.value;
      const h = vpH.value;
      return {
        minX: -translateX.value / safe,
        minY: -translateY.value / safe,
        vw: w / safe,
        vh: h / safe,
        s: safe,
        rawTx: translateX.value,
        rawTy: translateY.value,
      };
    },
    (curr) => {
      if (curr.vw <= 0 || curr.vh <= 0) return;
      /* 探针：把 worklet 侧真正读到的原始 shared value 一并带出来 —— 判断到底是
         "反应式读到了旧值"还是"值真的被改回去了"。 */
      runOnJS(publishVisibleWorldRect)(curr.minX, curr.minY, curr.vw, curr.vh, curr.s, curr.rawTx, curr.rawTy);
    },
    [publishVisibleWorldRect]
  );

  useEffect(() => {
    if (!__DEV__) return;
    flowLog(`[flowchart]${tagRef.current} model tasks=${tasks.length} nodesDraw=${nodesDraw.length}` +
        ` edgesDraw=${edgesDraw.length} isBuilding=${isBuilding} chartError=${chartError ? 'YES' : 'no'}`,
    );
  }, [tasks.length, nodesDraw, edgesDraw, isBuilding, chartError]);

  const visibleCardNodes = useMemo(() => {
    const list = nodesDraw.filter((n) => !n.isChoreArea);
    if (!visibleWorldRect) return list;
    return list.filter((n) => rectsOverlap(nodeOuterBounds(n), visibleWorldRect));
  }, [nodesDraw, visibleWorldRect]);

  const visibleEdges = useMemo(() => {
    if (!visibleWorldRect) return edgesDraw;
    return edgesDraw.filter((e) => rectsOverlap(e.bounds, visibleWorldRect));
  }, [edgesDraw, visibleWorldRect]);

  const visibleChoreRegions = useMemo(() => {
    if (!visibleWorldRect) return choreRegionsDraw;
    return choreRegionsDraw.filter((r) =>
      rectsOverlap(
        { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h },
        visibleWorldRect
      )
    );
  }, [choreRegionsDraw, visibleWorldRect]);

  /* 诊断：最终真正画出去的规模（Svg 尺寸 + 裁剪前后的节点/连线数）。 */
  useEffect(() => {
    if (!__DEV__) return;
    flowLog(`[flowchart]${tagRef.current} draw slot=${Math.max(1, effViewportW)}x${Math.max(1, effViewportH)}` +
        ` visibleNodes=${visibleCardNodes.length}/${nodesDraw.length}` +
        ` visibleEdges=${visibleEdges.length}/${edgesDraw.length}` +
        ` rect=${visibleWorldRect ? 'set' : 'null'}`,
    );
  }, [
    effViewportW,
    effViewportH,
    visibleCardNodes.length,
    nodesDraw.length,
    visibleEdges.length,
    edgesDraw.length,
    visibleWorldRect,
  ]);

  /**
   * 画布/视口变化后把平移收回合法范围。**整个读-改-写都必须在 UI 线程做**（见
   * applyViewportOnUI 的说明）：这里原来是 JS 线程版本，读到的 translate 是上一轮的
   * 陈旧值，钳完再排队写回去 —— 正好覆盖掉同一次 commit 里 restore/fit 刚排的写入。
   * 搬到 UI 线程后它排在那些写入**之后**执行、读到的是新值，钳的就是恢复好的视口
   * （合法值钳完不变，等于无操作），不再互相打架。
   */
  const applyClamp = useCallback(() => {
    const vw = viewport.w;
    const vh = viewport.h;
    if (vw <= 0 || vh <= 0) return;
    runOnUI((w: number, h: number, cw: number, ch: number) => {
      'worklet';
      const s = scale.value;
      const c = clampFlowCanvasPanWorklet(translateX.value, translateY.value, w, h, cw * s, ch * s);
      translateX.value = c.x;
      translateY.value = c.y;
    })(vw, vh, svgW, svgH);
  }, [viewport.w, viewport.h, svgW, svgH, translateX, translateY, scale]);

  useEffect(() => {
    applyClamp();
  }, [applyClamp, svgW, svgH]);

  const flowGestures = useMemo(() => {
    /**
     * 【每个回调都显式标 'worklet'】它们全是纯 shared value 运算 + clampFlowCanvasPanWorklet
     * （本身也是 worklet），**没有一处碰 JS 线程**，所以正确修法是标 worklet，不是
     * runOnJS(true) —— 后者会把每帧的平移/缩放都甩回 JS 线程，手感直接废掉。
     *
     * 为什么非得显式标：Reanimated 的 babel 插件是**按语法形状**认手势回调的 ——
     * 得是从 `Gesture.Pan()` 起一路不断的链式调用。这里为了按 insidePager 决定要不要加
     * activeOffsetY/failOffsetX，把链拆成了 `let pan = ...; pan = pan.onStart(...)`，
     * 插件就认不出来、不再注入 'worklet'，真机于是报
     * "None of the callbacks in the gesture are worklets"。
     * 自己标上就跟插件识别与否解耦了，以后再怎么拆链都不会复发。
     */
    let pan = Gesture.Pan()
      .maxPointers(1);
    if (insidePager) {
      /* 纵向占优才激活、横向直接判失败 —— 横划于是落到走马灯手上，用户划得出这一页。 */
      pan = pan.activeOffsetY([-10, 10]).failOffsetX([-16, 16]);
    }
    pan = pan
      .onStart(() => {
        'worklet';
        startPanX.value = translateX.value;
        startPanY.value = translateY.value;
      })
      .onUpdate((e) => {
        'worklet';
        translateX.value = startPanX.value + e.translationX;
        translateY.value = startPanY.value + e.translationY;
      })
      .onEnd(() => {
        'worklet';
        const s = scale.value;
        const c = clampFlowCanvasPanWorklet(
          translateX.value,
          translateY.value,
          vpW.value,
          vpH.value,
          canvasW.value * s,
          canvasH.value * s
        );
        translateX.value = c.x;
        translateY.value = c.y;
        /* 落定即记账：手势结束才写，比逐帧存省得多，也正好是"用户满意的那一帧"。 */
        runOnJS(commitViewport)(s, c.x, c.y);
      });

    const pinch = Gesture.Pinch()
      .onStart((e) => {
        'worklet';
        pinchStartScale.value = scale.value;
        pinchStartTx.value = translateX.value;
        pinchStartTy.value = translateY.value;
        pinchFocalX.value = e.focalX;
        pinchFocalY.value = e.focalY;
      })
      .onUpdate((e) => {
        'worklet';
        const s0 = Math.max(pinchStartScale.value, 0.001);
        let s2 = s0 * e.scale;
        const sMin = minPinchScale.value;
        if (s2 < sMin) s2 = sMin;
        if (s2 > MAX_FLOW_SCALE) s2 = MAX_FLOW_SCALE;
        const fx = pinchFocalX.value;
        const fy = pinchFocalY.value;
        const t0x = pinchStartTx.value;
        const t0y = pinchStartTy.value;
        translateX.value = fx - (fx - t0x) * (s2 / s0);
        translateY.value = fy - (fy - t0y) * (s2 / s0);
        scale.value = s2;
      })
      .onEnd(() => {
        'worklet';
        const s = scale.value;
        const c = clampFlowCanvasPanWorklet(
          translateX.value,
          translateY.value,
          vpW.value,
          vpH.value,
          canvasW.value * s,
          canvasH.value * s
        );
        translateX.value = c.x;
        translateY.value = c.y;
        /* 落定即记账：手势结束才写，比逐帧存省得多，也正好是"用户满意的那一帧"。 */
        runOnJS(commitViewport)(s, c.x, c.y);
      });

    return Gesture.Simultaneous(pan, pinch);
    /* insidePager 要列进来：它决定 pan 的激活条件，换了就得重建手势。其余捕获的都是
       shared value / worklet 常量，本来就稳定。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable shared refs
  }, [insidePager, commitViewport]);

  const canvasStyle = useAnimatedStyle(() => ({
    transformOrigin: 'left top',
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  /**
   * 与节点层 `canvasStyle`（translate + scale）对齐：子 View 在父级坐标 (wx,wy) 下，Fabric/Reanimated 常见效果为
   * 屏幕像素 ≈ wx·s + tx（与「整图 Svg 一起被 transform」时一致）。据此推导 viewBox 左/上缘 = -tx/s、宽/高 = 视口/s。
   *
   * 若按 Android TransformHelper 的 transformOrigin 再减 (W/2)(1-s)，会与当前手势层实际矩阵不一致，捏合时节与点阵缩放会
   * 和节点错位。故不在这里做画布半宽修正。
   *
   * `align: xMinYMin` + `meet`：viewBox 与视口同宽高比时等价于左上角对齐，避免 xMidYMid 在浮点下引入额外偏移。
   * 原生 Svg 必须通过 minX/vbWidth 数值 + 非空 align 才会应用 viewBox 矩阵（见 SvgView.drawChildren）。
   */
  const animatedSvgViewBoxProps = useAnimatedProps(() => {
    const sc = scale.value;
    const safe = sc < 0.0001 ? 0.0001 : sc;
    const tx = translateX.value;
    const ty = translateY.value;
    const w = vpW.value;
    const h = vpH.value;
    if (w <= 0 || h <= 0) {
      return { minX: 0, minY: 0, vbWidth: 1, vbHeight: 1, align: 'xMinYMin', meetOrSlice: 0 };
    }
    const vx = -tx / safe;
    const vy = -ty / safe;
    const vw = w / safe;
    const vh = h / safe;
    return {
      minX: vx,
      minY: vy,
      vbWidth: vw,
      vbHeight: vh,
      align: 'xMinYMin',
      meetOrSlice: 0,
    };
  });

  const onCanvasLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = e.nativeEvent.layout;
      if (__DEV__) flowLog(`[flowchart]${tagRef.current} onLayout w=${width} h=${height}`);
      setViewport({ w: width, h: height });
    },
    []
  );

  if (tasks.length === 0) {
    return (
      <View
        style={[
          styles.empty,
          { backgroundColor: canvasBg },
        ]}
      >
        <Text style={[styles.emptyText, { color: colors.textMuted }]}>该项目暂无任务</Text>
      </View>
    );
  }

  /** 建图在 runAfterInteractions 中异步执行，避免与当前渲染帧/reconcile 叠在一起加重卡顿或异常路径 */
  if (isBuilding) {
    return (
      <View
        style={[styles.root, { backgroundColor: canvasBg }]}
      >
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  if (chartError) {
    return (
      <View
        style={[styles.root, { backgroundColor: canvasBg }]}
      >
        <View style={styles.chartErrorBox}>
          <Text style={[styles.chartErrorTitle, { color: colors.textPrimary }]}>流程图数据异常</Text>
          <Text style={[styles.chartErrorDetail, { color: colors.textSecondary }]} numberOfLines={10}>
            {chartError}
          </Text>
          <Text style={[styles.chartErrorHint, { color: colors.textMuted }]}>
            请切换到「列表」或「日历」后重试；若仅 Flow 异常，可稍后再试或到网页端查看。
          </Text>
        </View>
      </View>
    );
  }


  const patternId = 'flowDots';
  const slotW = Math.max(1, effViewportW);
  const slotH = Math.max(1, effViewportH);

  return (
    <View style={[styles.root, { backgroundColor: canvasBg }]}>
      <GestureDetector gesture={flowGestures}>
        <View style={styles.panSlot} onLayout={onCanvasLayout}>
          <AnimatedSvg
            animatedProps={animatedSvgViewBoxProps as object}
            width={slotW}
            height={slotH}
            style={styles.svgViewportLayer}
          >
            <Defs>
              <Pattern
                id={patternId}
                patternUnits="userSpaceOnUse"
                width={DOT_GAP}
                height={DOT_GAP}
              >
                <Circle
                  cx={DOT_GAP / 2}
                  cy={DOT_GAP / 2}
                  r={DOT_R}
                  fill={DOT_FILL}
                />
              </Pattern>
            </Defs>
            <SvgRect x={0} y={0} width={svgW} height={svgH} fill={canvasBg} />
            <SvgRect x={0} y={0} width={svgW} height={svgH} fill={`url(#${patternId})`} />
            {visibleChoreRegions.map((r) => (
              <React.Fragment key={`chore-region-${r.parentId}`}>
                <SvgRect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  rx={5}
                  ry={5}
                  fill={choreRegionFill}
                  stroke={choreRegionStroke}
                  strokeWidth={1}
                  strokeDasharray="6 4"
                />
                <SvgText
                  x={r.labelCx}
                  y={r.labelBaselineY}
                  fill={WEB.choreLabel}
                  fontSize={11}
                  fontFamily={FONT_FAMILY}
                  textAnchor="middle"
                >
                  {r.label}
                </SvgText>
              </React.Fragment>
            ))}
            {visibleEdges.map((e) => (
              <Path
                key={e.id}
                d={e.d}
                stroke={e.dashed ? WEB.edge : e.choreLink ? WEB.choreEdge : WEB.edge}
                strokeWidth={1}
                fill="none"
                strokeDasharray={e.dashed ? '5 5' : e.choreLink ? '4 6' : undefined}
              />
            ))}
          </AnimatedSvg>
          <Animated.View style={[styles.nodeCanvasLayer, canvasStyle, { width: svgW, height: svgH }]}>
            {visibleCardNodes.map((n) => (
                <View
                  key={n.id}
                  pointerEvents="none"
                  style={[
                    styles.nodeWrap,
                    {
                      left: n.x,
                      top: n.y - (n.icon ? MILESTONE_ICON_SLOT : 0),
                      width: FLOW_NODE_WIDTH,
                    },
                  ]}
                >
                  {n.icon ? (
                    <Text style={styles.milestoneIcon} numberOfLines={1}>
                      {n.icon}
                    </Text>
                  ) : null}
                  <View
                    style={[
                      styles.card,
                      {
                        minHeight: n.cardH,
                        backgroundColor: n.fill,
                        borderColor: n.stroke,
                      },
                    ]}
                  >
                    <Text style={styles.cardTitle} selectable={false}>
                      {n.title}
                    </Text>
                  </View>
                  {n.milestoneCollapsedDescendantCount != null ? (
                    <View style={styles.milestoneCollapseHint}>
                      <Text style={styles.milestoneCollapseHintText} numberOfLines={1}>
                        {n.milestoneCollapsedDescendantCount}个已折叠
                      </Text>
                    </View>
                  ) : null}
                </View>
              ))}
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  panSlot: { flex: 1, overflow: 'hidden', position: 'relative' },
  /** 与节点层对齐：仅占满视口，边线由 viewBox 映射世界坐标，避免整图光栅 */
  svgViewportLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  /** 与 Svg 同起点，保证 translate/scale 与 viewBox 一致 */
  nodeCanvasLayer: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 15 },
  chartErrorBox: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  chartErrorTitle: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 10,
  },
  chartErrorDetail: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 14,
  },
  chartErrorHint: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  nodeWrap: {
    position: 'absolute',
    alignItems: 'center',
  },
  milestoneIcon: {
    fontSize: 28,
    lineHeight: 32,
    height: MILESTONE_ICON_SLOT,
    textAlign: 'center',
    width: FLOW_NODE_WIDTH,
  },
  card: {
    width: FLOW_NODE_WIDTH,
    borderRadius: 5,
    borderWidth: 1,
    justifyContent: 'center',
    paddingVertical: PAD_V,
    paddingHorizontal: 6,
  },
  cardTitle: {
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    fontFamily: FONT_FAMILY,
    color: WEB.text,
    textAlign: 'center',
  },
  /** Web `.milestone-collapse-btn` 折叠态：黑底白字「N个已折叠」 */
  milestoneCollapseHint: {
    marginTop: 4,
    paddingVertical: 2,
    paddingHorizontal: 10,
    borderRadius: 4,
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: '#000',
    alignSelf: 'center',
    maxWidth: FLOW_NODE_WIDTH + 40,
  },
  milestoneCollapseHintText: {
    fontSize: 12,
    lineHeight: 17,
    color: '#fff',
    textAlign: 'center',
  },
});
