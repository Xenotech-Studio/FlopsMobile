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
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  useAnimatedReaction,
  runOnJS,
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

/** 流程图画布捏合缩放范围 */
const MIN_FLOW_SCALE = 0.35;
const MAX_FLOW_SCALE = 3.5;

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
  const scale = Math.min(MAX_FLOW_SCALE, Math.max(MIN_FLOW_SCALE, sRaw));
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
};

/** 与 Web `FlowChart.css` --flow-chore-region-fill / `EditableNode.css` .chore-area-unified 一致 */
const CHORE_REGION_FILL_LIGHT = 'rgba(120, 120, 130, 0.16)';
const CHORE_REGION_FILL_DARK = 'rgba(100, 100, 110, 0.18)';

export function TaskFlowChartView({
  tasks,
  topInset = 0,
  bottomInset = 0,
  insidePager = false,
}: TaskFlowChartViewProps) {
  const { colors, isDark } = useAppTheme();
  const choreRegionFill = isDark ? CHORE_REGION_FILL_DARK : CHORE_REGION_FILL_LIGHT;
  /** 与 Web 画布边线浅色 #b1b1b7、深色 #3e3e3e 一致 */
  const choreRegionStroke = isDark ? '#3e3e3e' : WEB.edge;
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
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

  const [model, setModel] = useState<FlowChartBuiltModel>(() => emptyFlowModel());
  const [isBuilding, setIsBuilding] = useState(false);
  /** 世界坐标下当前视口（含边距）；与 Svg viewBox 同源。null 表示尚未同步，先渲染全部节点避免闪空 */
  const [visibleWorldRect, setVisibleWorldRect] = useState<WorldRect | null>(null);
  const visibleRectQuantizedKeyRef = useRef('');

  const { svgW, svgH, edgesDraw, nodesDraw, choreRegionsDraw, chartError } = model;

  /** 每次图构建完成且视口已量好：自动「缩小到能看见全图」并居中 */
  useEffect(() => {
    if (isBuilding || chartError || svgW <= 0 || svgH <= 0 || viewport.w <= 0 || viewport.h <= 0) {
      return;
    }
    const { scale: s, translateX: tx, translateY: ty } = fitFlowChartToViewport(
      viewport.w,
      viewport.h,
      svgW,
      svgH
    );
    scale.value = s;
    translateX.value = tx;
    translateY.value = ty;
    visibleRectQuantizedKeyRef.current = '';
  }, [
    isBuilding,
    chartError,
    svgW,
    svgH,
    viewport.w,
    viewport.h,
    scale,
    translateX,
    translateY,
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

  useEffect(() => {
    canvasW.value = svgW;
    canvasH.value = svgH;
  }, [svgW, svgH, canvasW, canvasH]);

  useEffect(() => {
    vpW.value = viewport.w;
    vpH.value = viewport.h;
  }, [viewport.w, viewport.h, vpW, vpH]);

  useEffect(() => {
    visibleRectQuantizedKeyRef.current = '';
  }, [nodesDraw, edgesDraw]);

  const publishVisibleWorldRect = useCallback(
    (minX: number, minY: number, vw: number, vh: number, s: number) => {
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
      setVisibleWorldRect({
        minX: minX - marginWorld,
        minY: minY - marginWorld,
        maxX: maxX + marginWorld,
        maxY: maxY + marginWorld,
      });
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
      };
    },
    (curr) => {
      if (curr.vw <= 0 || curr.vh <= 0) return;
      runOnJS(publishVisibleWorldRect)(curr.minX, curr.minY, curr.vw, curr.vh, curr.s);
    },
    [publishVisibleWorldRect]
  );

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

  const applyClamp = useCallback(() => {
    const vw = viewport.w;
    const vh = viewport.h;
    if (vw <= 0 || vh <= 0) return;
    const s = scale.value;
    const c = clampFlowCanvasPan(translateX.value, translateY.value, vw, vh, svgW * s, svgH * s);
    translateX.value = c.x;
    translateY.value = c.y;
  }, [viewport.w, viewport.h, svgW, svgH, translateX, translateY, scale]);

  useEffect(() => {
    applyClamp();
  }, [applyClamp, svgW, svgH]);

  const flowGestures = useMemo(() => {
    let pan = Gesture.Pan()
      .maxPointers(1);
    if (insidePager) {
      /* 纵向占优才激活、横向直接判失败 —— 横划于是落到走马灯手上，用户划得出这一页。 */
      pan = pan.activeOffsetY([-10, 10]).failOffsetX([-16, 16]);
    }
    pan = pan
      .onStart(() => {
        startPanX.value = translateX.value;
        startPanY.value = translateY.value;
      })
      .onUpdate((e) => {
        translateX.value = startPanX.value + e.translationX;
        translateY.value = startPanY.value + e.translationY;
      })
      .onEnd(() => {
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
      });

    const pinch = Gesture.Pinch()
      .onStart((e) => {
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
        if (s2 < MIN_FLOW_SCALE) s2 = MIN_FLOW_SCALE;
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
      });

    return Gesture.Simultaneous(pan, pinch);
    /* insidePager 要列进来：它决定 pan 的激活条件，换了就得重建手势。其余捕获的都是
       shared value / worklet 常量，本来就稳定。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable shared refs
  }, [insidePager]);

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
      setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
    },
    []
  );

  if (tasks.length === 0) {
    return (
      <View
        style={[
          styles.empty,
          { paddingTop: topInset, paddingBottom: bottomInset, backgroundColor: colors.chatScreenBackground },
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
        style={[styles.root, { paddingTop: topInset, paddingBottom: bottomInset, backgroundColor: colors.chatScreenBackground }]}
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
        style={[styles.root, { paddingTop: topInset, paddingBottom: bottomInset, backgroundColor: colors.chatScreenBackground }]}
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
        <Text
          style={[styles.hint, { backgroundColor: colors.surfaceMuted, color: colors.textMuted }]}
          numberOfLines={2}
        >
          与网页版相同布局 · 单指拖动 · 双指捏合缩放
        </Text>
      </View>
    );
  }

  const patternId = 'flowDots';
  const slotW = Math.max(1, viewport.w);
  const slotH = Math.max(1, viewport.h);

  return (
    <View style={[styles.root, { paddingTop: topInset, paddingBottom: bottomInset, backgroundColor: colors.chatScreenBackground }]}>
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
            <SvgRect x={0} y={0} width={svgW} height={svgH} fill={colors.chatScreenBackground} />
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
      <Text
        style={[styles.hint, { backgroundColor: colors.surfaceMuted, color: colors.textMuted }]}
        numberOfLines={1}
      >
        与网页版相同布局 · 单指拖动 · 双指捏合缩放
      </Text>
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
  hint: {
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 6,
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
