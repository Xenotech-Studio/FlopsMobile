/**
 * WorkspaceBody —— 协同工作模式下的**页面主体**（工作区）。
 *
 * 协同模式的形态是「工作区占页面主体 + 聊天消息区落进底部 sheet」，所以这里画的是
 * agent 正在操作的那个东西本身，不是聊天。四个 mode 铺成**一条走马灯**：
 *  - cowriter：每篇打开着的 FlowDoc 一页，走 DocBodyView 只读渲染；
 *  - coplanner：每个打开着的 FlowTask 项目一页（复用项目页的 TaskFlowChartView 画流程图，
 *    只读；进场自动缩到全图并居中，可双指缩放、任意方向拖）；
 *  - cocoder / cobrowser：各一页占位（服务端 layout 只给 active_mode，没有对象数据），
 *    内容显示暂不支持，但页面在序列里 —— 桌面端切过去时手机端跟着停到占位页，能划回文档。
 *
 * 贴在 sheet 顶沿的胶囊指示器 = 当前页展开成「图标 + 名字」，其余收成小圆点（可点直达）。
 *
 * 【翻页手势】翻页轨道是**自绘**的（不是 PagerView，理由见下面 trackX 那段），所以两条路
 * 跑的是同一份 worklet、手感一模一样：
 *  - 拖底部那条指示器 —— **所有页都生效**，内容 1:1 跟着手指平移，松手吸附最近页；
 *  - 整幅横滑 —— 除 coplanner 外都生效。流程图整幅都是可拖可捏的画布，整幅横滑跟它抢
 *    同一个方向，抢赢了是误翻页、抢输了画布拖不动，所以那一页只留指示器那条路。
 *
 * 边界：**只读**（不编辑文档内容），但切换是**双向**的：
 *  - 服务端换焦点（agent 又改了另一篇 / 桌面端切了 mode）→ 本地跟随 (activeMode, activeId)
 *    二元组跳过去（useFollowedSelection）；
 *  - 用户横滑 / 拖指示器 / 点圆点 → 先本地切显示，再经 onSelectTab 回写服务端（ChatScreen
 *    发的 POST /cowriter_layout），于是桌面端下次加载会话时停在同一处、手机端重开也驻留。
 * 早期版本刻意"纯本地不回写"，怕抢桌面端焦点；后来明确了：**用户主动划**就是明确的切换
 * 意图，该回写；要避免的只是"被动跟随也回写"那种回弹。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import LinearGradient from 'react-native-linear-gradient';
import { getFlowDocItemName, getFlowDocTree, type FlowDocTreeItem } from '../../api';
import { fetchTasks, type TaskItem } from '../../taskApi';
import { useSession } from '../../context/SessionContext';
import { useTask } from '../../context/TaskContext';
import { useAppTheme } from '../../context/ThemeContext';
import { collabWorkspaceFadeGradient, type AppColors } from '../../theme/appColors';
import { shadowSoft, shadowToggleThumb } from '../../theme/shadows';
import { docsTreeStore } from '../docs/docsTreeStore';
import { DocBodyView } from '../docs/DocBodyView';
import { TaskFlowChartView } from '../../components/TaskFlowChartView';
import {
  activeCollabTabKey,
  collabTabs,
  type CollabLayoutState,
  type CollabTabRef,
  type MobileCollabMode,
} from '../../utils/collabLayout';

export type WorkspaceBodyProps = {
  layout: CollabLayoutState;
  /**
   * 工作区里任何一次触摸开始时调一下（调用方用来收键盘）。
   *
   * 实现挂在根 View 的 **onStartShouldSetResponderCapture** 上：它在捕获阶段被逐层问到，
   * 我们只是搭个便车看一眼、**恒返回 false**（不认领 responder），所以事件继续往下走 ——
   * 指示器的点按与横拖、文档里的可点元素、画布的拖拽缩放全都照常拿到这次触摸。
   * 不用 onTouchStartCapture 是因为 RN 的 ViewProps 类型里压根没有它（消息区那处同样写法
   * 至今在 tsc 基线里挂着一条 TS2769），而这个钩子是有类型的、语义也更准。
   */
  onUserTouch?: () => void;
  /**
   * 用户**主动**切走马灯（拖指示器翻页 / 点圆点）时回调，带上目标 tab。
   * 只在用户操作时发；服务端推来的跟随（activeKey 变化经 useFollowedSelection 落到本地）
   * **不发** —— 否则会把桌面端的切换原样回弹给服务端，变成一次无意义的写、还平白 +1 seq。
   */
  onSelectTab?: (tab: CollabTabRef) => void;
  /**
   * 当前停在哪一页 —— **状态镜像**，选中项一变就报一次，含跟随服务端的被动切换；
   * 序列里找不到（布局还空着）时给 null。
   *
   * 跟 onSelectTab 的分工：那个是「用户表达了切换意图」的事件（要回写服务端），这个是
   * 「此刻停在哪」的事实。调用方拿它做与当前页相关的行为判断 —— 目前是 ChatScreen 的
   * 「过顶关闭抽屉只对 cowriter 文档页开放」。
   */
  onSelectionChange?: (tab: CollabTabRef | null) => void;
  /** 顶部 header 高度：内容从它下方开始（header 是绝对定位浮层）。 */
  topInset: number;
  /**
   * 底部被 sheet + composer 盖住的高度，取 **sheet 最低档**：滚动类页面（文档 / 项目大纲）
   * 垫这么多，最后一段才滚得出来 —— 它们本来就该能继续滚到 sheet 底下去。
   */
  bottomInset: number;
  /**
   * sheet **当前档**实际占掉的高度。居中类页面（占位页）得按它算可视区：垫最低档的话，
   * sheet 一展开内容就被留在原地，跟走马灯叠在一起、半截压进 sheet（真机实测的翻车点）。
   */
  viewportBottomInset: number;
  /**
   * 聊天 sheet 顶沿此刻的 y（gorhom animatedPosition，抛出时已含 topInset，与本层同坐标系）。
   * 指示器就浮在它上方一点 —— sheet 拖到哪档 tabs 跟到哪，逐帧走 UI 线程。
   */
  sheetTopY: SharedValue<number>;
  /** sheet 最低档时顶沿的 y：指示器不跟着哨兵值（首帧 / 入场动画）飘到屏幕外。 */
  sheetTopYMax: number;
};

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/** 走马灯里的 mode 视觉身份：胶囊图标 + 没有名字时的兜底标签。 */
/**
 * 【协同工作区里文档的排版：向聊天正文对齐】
 *
 * 文档原生排版是照 web editorChrome.css 抄的（正文 16 / 行高 1.6 = 26），而聊天里 assistant
 * 正文走 MarkdownContent，是 **14 / 20**。并排放在同一屏时文档明显更大更松 —— 行高差
 * （26 vs 20，+30%）比字号差（+14%）更抢眼。
 *
 * 三个值都只在**这个调用点**生效：全屏读文档（DocPreviewScreen）不传，保持 16/1.6/满宽。
 *  - 14   ：对齐 MarkdownContent.body.fontSize；六级标题按 14/16 等比缩（32→28、24→21…），
 *           层级比例自动保持，不用逐级决定
 *  - 1.45 ：14 × 1.45 ≈ 20，与 MarkdownContent.body.lineHeight 完全一致
 *  - 380  ：对齐聊天消息列的 maxWidth（ChatScreen.styles scrollContent）。不限宽的话同样
 *           字号下文档一行字数明显更多，"排版不一致"有一半来自行宽而不是字号
 *
 * 没有跟着缩的：块间距 / 缩进步长 / 代码块 padding 这些固定 px，以及**表格**（它内部另有
 * 一个绝对 14 的基准，列宽是按那个字号定的绝对像素，一起缩会让文字与列宽脱节）。
 */
const DOC_BASE_FONT_SIZE = 14;
const DOC_BODY_LH_RATIO = 1.45;
const DOC_MAX_CONTENT_WIDTH = 380;

const MODE_ICON: Record<MobileCollabMode, IoniconName> = {
  cowriter: 'document-text-outline',
  coplanner: 'git-branch-outline',
  cocoder: 'terminal-outline',
  cobrowser: 'globe-outline',
};
const MODE_LABEL: Record<MobileCollabMode, string> = {
  cowriter: '文档',
  coplanner: '项目',
  cocoder: '代码',
  cobrowser: '浏览器',
};

export function WorkspaceBody({
  layout,
  onUserTouch,
  onSelectTab,
  onSelectionChange,
  topInset,
  bottomInset,
  viewportBottomInset,
  sheetTopY,
  sheetTopYMax,
}: WorkspaceBodyProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const fadeColors = useMemo(() => collabWorkspaceFadeGradient(colors), [colors]);
  const { session } = useSession();
  const { projects } = useTask();

  const tabs = useMemo(() => collabTabs(layout), [layout]);
  const tabKeys = useMemo(() => tabs.map((t) => t.key), [tabs]);
  /** tabs 的 ref 镜像：setSelectedKey 要按 key 反查 tab，但不该把 tabs 列进它的依赖 ——
   *  布局每变一次就重建回调，PagerView / 指示器跟着白重渲染一轮。 */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** 服务端此刻的焦点（mode + id 二元组压成的 key）。 */
  const activeKey = useMemo(() => activeCollabTabKey(layout), [layout]);
  const [selectedKey, setSelectedKeyRaw] = useFollowedSelection(activeKey, tabKeys);
  /** 用户主动切：先本地切显示（跟手、不等网络），再把意图回写给服务端。 */
  const setSelectedKey = useCallback(
    (key: string) => {
      setSelectedKeyRaw(key);
      const tab = tabsRef.current.find((t) => t.key === key);
      if (tab) onSelectTab?.(tab);
    },
    [setSelectedKeyRaw, onSelectTab],
  );
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((t) => t.key === selectedKey),
  );
  /* 停在哪一页往上报（含被动跟随）。挂 selectedKey 而不是 tabs：增删文档不改"停在哪"，
     不该白报一次；而 key 一变必然是真的换页了。 */
  useEffect(() => {
    onSelectionChange?.(tabsRef.current.find((t) => t.key === selectedKey) ?? null);
  }, [selectedKey, onSelectionChange]);

  /* ── 文档名解析：胶囊标签与正文大标题共用一份 ──
     树缓存（DocsScreen 加载后写进去的进程级单例）优先；缺项拉一次全树；仍拿不到的
     （内嵌 subdoc 等不在侧栏树上的项）逐个问服务端要名字。 */
  const docIds = useMemo(() => layout.cowriter?.docIds ?? [], [layout.cowriter]);
  /** 文档树缓存命中计数：拉到新树后 +1，逼下面的 useMemo 重新解析 item。 */
  const [treeVersion, setTreeVersion] = useState(0);
  /** 「树里找不到」时只拉一次全树，避免解析不到的 id 反复打网络。 */
  const treeFetchedRef = useRef(false);
  const [names, setNames] = useState<Record<string, string>>({});
  /** 已问过服务端名字的 id：拿不到名字的项不该每次重渲染都再问一遍。 */
  const nameAskedRef = useRef<Set<string>>(new Set());
  /* 组件还挂着吗。**不能**用「每次 effect 重跑就 cancel」那套：下面取名字的 effect 依赖
     names，每回一个名字就重跑一次，共享的 cancelled 标记会把同批其它 id 还在飞的请求
     一起判死；它们又已被 nameAskedRef 记为问过，于是永远补不上名字。 */
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  const docItems = useMemo(() => {
    const map: Record<string, FlowDocTreeItem | null> = {};
    for (const id of docIds) map[id] = docsTreeStore.get(id);
    return map;
    /* treeVersion 是缓存失效信号：docsTreeStore 是模块级单例，不把它列进依赖，
       拉到新树后这里永远还读着「查不到」的旧结果。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docIds, treeVersion]);

  /* 树缓存可能还是空的（从聊天页直接进协同模式，没去过文档页）：缺项就拉一次全树补上
     （一次网络，之后所有 tab 都命中）。 */
  useEffect(() => {
    if (!session || treeFetchedRef.current) return;
    if (docIds.length === 0 || docIds.every((id) => docItems[id])) return;
    treeFetchedRef.current = true;
    getFlowDocTree(session)
      .then((tree) => {
        docsTreeStore.set(tree);
        if (aliveRef.current) setTreeVersion((v) => v + 1);
      })
      .catch(() => {
        /* 拉不到树不致命：下面按 document 类型 + 单项名字兜底渲染 */
      });
  }, [session, docIds, docItems]);

  useEffect(() => {
    if (!session) return;
    for (const id of docIds) {
      if (names[id] !== undefined) continue;
      const cached = docsTreeStore.get(id)?.name?.trim();
      if (cached) {
        setNames((prev) => (prev[id] === cached ? prev : { ...prev, [id]: cached }));
        continue;
      }
      if (nameAskedRef.current.has(id)) continue;
      nameAskedRef.current.add(id);
      getFlowDocItemName(session, id)
        .then((name) => {
          if (!aliveRef.current || !name) return;
          setNames((prev) => (prev[id] === name ? prev : { ...prev, [id]: name }));
        })
        .catch(() => {});
    }
  }, [session, docIds, names, treeVersion]);

  /** 项目名走 TaskContext 现成的列表，不用另外拉。 */
  const projectNameOf = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name?.trim() || '未命名项目',
    [projects],
  );
  const labelOf = useCallback(
    (tab: CollabTabRef) => {
      if (tab.mode === 'cowriter') {
        return names[tab.id] || docItems[tab.id]?.name?.trim() || MODE_LABEL.cowriter;
      }
      if (tab.mode === 'coplanner') return projectNameOf(tab.id);
      return MODE_LABEL[tab.mode];
    },
    [names, docItems, projectNameOf],
  );

  /* ─────────────────────────── 自绘翻页轨道 ─────────────────────────── */
  /**
   * 【为什么不用 PagerView 了】要的是「拖底部指示器时，上面的内容 1:1 跟着平移」。
   *
   * react-native-pager-view@8.0.2 的命令式接口只有 setPage / setPageWithoutAnimation /
   * setScrollEnabled（PagerView.d.ts 的全部内容），**没有逐帧设置滚动偏移的口子**，也不把
   * 内部滚动位置交给外部手势驱动。所以手势挂在哪儿都一样，最多做到"过了阈值翻一页"的离散
   * 翻页 —— 就是上一版的样子，而那正是用户说"不是我要的"。
   *
   * 于是自绘：一条 flexDirection:'row' 的轨道，每页宽 = 视口宽，整条靠一个 shared value
   * （trackX）平移。代价是翻页器该有的东西（吸附、阻尼、快甩）得自己写；换来的是**位移完全
   * 由我们说了算** —— 指示器拖拽和整幅横滑跑同一份 worklet，手感因此天然一模一样。
   */
  const win = useWindowDimensions();
  const [hostW, setHostW] = useState(0);
  /** 一页多宽：以量到的为准，量到之前用窗口宽兜底（工作区是全出血的，两者一致）。 */
  const pageWidth = hostW > 1 ? hostW : win.width;
  const onHostLayout = useCallback((e: LayoutChangeEvent) => {
    setHostW(e.nativeEvent.layout.width);
  }, []);
  /**
   * 轨道此刻的 translateX（px，≤ 0）——**显示位置的唯一真相，全程只在 UI 线程写**。
   * Reanimated 4 里 JS 侧写 shared value 是异步排队、读是同步插队（见 TaskFlowChartView 的
   * applyViewportOnUI），逐帧跟手的量一旦沾上 JS 线程的读-改-写就必然抖 —— 所以手势回调
   * 全是 worklet，JS 只在松手那一下经 runOnJS 收一次结果。
   */
  const trackX = useSharedValue(-selectedIndex * pageWidth);
  /** 手势起点的 trackX（worklet 内部用）。 */
  const dragStartX = useSharedValue(0);
  /* worklet 读不到 React 值，几个几何量各留一份镜像。 */
  const pageWidthSV = useSharedValue(pageWidth);
  const pageCountSV = useSharedValue(tabs.length);
  const selectedIndexSV = useSharedValue(selectedIndex);
  /** selectedIndex 的 ref 镜像：commitPage 要判「这次拖拽到底翻没翻动」。 */
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  /** 轨道已经停在哪一页 —— 手势自己会把轨道弹到位，别让下面那条 effect 再弹一次。 */
  const settledIndexRef = useRef(selectedIndex);
  /** tab 集合指纹：增删文档会让索引整体错位，此时要重新摆位而不是播一段翻页动画。 */
  const tabsSig = tabKeys.join('|');
  const lastSigRef = useRef(tabsSig);
  const lastWidthRef = useRef(pageWidth);
  useEffect(() => {
    pageWidthSV.value = pageWidth;
    pageCountSV.value = tabs.length;
    selectedIndexSV.value = selectedIndex;
    const sigChanged = lastSigRef.current !== tabsSig;
    const widthChanged = lastWidthRef.current !== pageWidth;
    lastSigRef.current = tabsSig;
    lastWidthRef.current = pageWidth;
    if (!sigChanged && !widthChanged && settledIndexRef.current === selectedIndex) return;
    settledIndexRef.current = selectedIndex;
    const to = -selectedIndex * pageWidth;
    /* 集合变了 / 转屏是「重新摆位」，直接落位，别播一段无中生有的滑动。 */
    trackX.value = sigChanged || widthChanged ? to : withSpring(to, TRACK_SPRING);
  }, [
    selectedIndex,
    tabsSig,
    pageWidth,
    tabs.length,
    trackX,
    pageWidthSV,
    pageCountSV,
    selectedIndexSV,
  ]);
  /** 松手落定：记下来 + 回写服务端。整段拖拽只走一次。 */
  const commitPage = useCallback(
    (index: number) => {
      settledIndexRef.current = index;
      /* 停在原地就别回写：没翻动的拖拽不该 +1 seq、更不该让桌面端跟着动一下。 */
      if (index === selectedIndexRef.current) return;
      const key = tabsRef.current[index]?.key;
      if (key) setSelectedKey(key);
    },
    [setSelectedKey],
  );
  /**
   * 走马灯拖拽手势。**指示器和整幅内容各挂一份**（同一个 Gesture 实例不能挂两处），逻辑
   * 完全共用 —— 用户要的就是"滑底部目录跟滑上面内容手感一模一样"。
   *
   * 每个回调都显式标 'worklet'：Reanimated 的 babel 插件按语法形状认手势回调，链一拆就静默
   * 失去 workletization（本仓踩过，真机报 "None of the callbacks are worklets"）。这里的回调
   * 只碰 shared value，本来就该留在 UI 线程 —— 逐帧跟手的东西不能过 JS。
   */
  const buildCarouselPan = useCallback(
    () =>
      Gesture.Pan()
        /* 横向占优才激活、明显纵向的直接判失败：纵向留给文档滚动 / 画布拖拽。 */
        .activeOffsetX([-8, 8])
        .failOffsetY([-14, 14])
        .onStart(() => {
          'worklet';
          dragStartX.value = trackX.value;
        })
        .onUpdate((e) => {
          'worklet';
          const w = pageWidthSV.value > 0 ? pageWidthSV.value : 1;
          const min = -Math.max(0, pageCountSV.value - 1) * w;
          let x = dragStartX.value + e.translationX;
          /* 两端阻尼：越界仍跟手，但只跟三成，松手弹回 —— 系统翻页器的手感。 */
          if (x > 0) x *= TRACK_OVERDRAG;
          else if (x < min) x = min + (x - min) * TRACK_OVERDRAG;
          trackX.value = x;
        })
        .onEnd((e) => {
          'worklet';
          const w = pageWidthSV.value > 0 ? pageWidthSV.value : 1;
          const maxIndex = Math.max(0, pageCountSV.value - 1);
          const from = Math.round(-dragStartX.value / w);
          /* 吸附最近页。 */
          let target = Math.round(-trackX.value / w);
          /* 快甩：朝甩的方向至少进一页 —— 位移没够的轻弹也该翻得过去。用 max/min 而不是
             直接 from±1：已经拖过好几页时别把它拽回来。 */
          if (e.velocityX <= -TRACK_FLING_V) target = Math.max(target, from + 1);
          else if (e.velocityX >= TRACK_FLING_V) target = Math.min(target, from - 1);
          target = Math.min(maxIndex, Math.max(0, target));
          trackX.value = withSpring(-target * w, TRACK_SPRING);
          runOnJS(commitPage)(target);
        }),
    [commitPage, trackX, dragStartX, pageWidthSV, pageCountSV],
  );
  /**
   * 【coplanner 页把整幅横滑让给画布】—— 只有这一页分叉，而且只关**整幅**那一份。
   *
   * 流程图整幅都是可拖可捏的画布，整幅横滑跟它抢同一个方向：抢赢了是误翻页、抢输了画布
   * 拖不动。指示器那份不受影响 —— 它在底部一条独立的带子上、跟画布不重叠，所以**所有页
   * （含 coplanner）都能拖指示器翻页**，这正是用户要的"对所有类型的页面都生效"。
   */
  const carouselSwipeOnPager = tabs[selectedIndex]?.mode !== 'coplanner';
  const indicatorPan = useMemo(() => buildCarouselPan(), [buildCarouselPan]);
  const contentPan = useMemo(
    () => buildCarouselPan().enabled(carouselSwipeOnPager),
    [buildCarouselPan, carouselSwipeOnPager],
  );
  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: trackX.value }] }));
  /**
   * 指示器在拖拽中的视觉反馈：整行圆点/胶囊跟着内容同向平移一小段（阻尼到 14pt 封顶）。
   * 不做"胶囊精确滑向下一个圆点"—— 胶囊宽度随文档名变、圆点间距也不固定，精确映射得先量
   * 每一项的位置，收益不值那份复杂度。同向微移已经足够让人感到"它被拖着"。
   */
  const indicatorDragStyle = useAnimatedStyle(() => {
    const w = pageWidthSV.value > 0 ? pageWidthSV.value : 1;
    const frac = (trackX.value + selectedIndexSV.value * w) / w;
    return { transform: [{ translateX: Math.min(1, Math.max(-1, frac)) * INDICATOR_DRAG_SHIFT }] };
  });

  /* 指示器不再占正文顶部那一条（它浮到 sheet 上沿去了），正文直接从 header 下沿开始。 */
  const contentTopInset = topInset;
  /** 指示器位移：贴在 sheet 顶沿上方 INDICATOR_SHEET_GAP 处，两端钳住 ——
   *  下不跟着「位置还没报上来」的哨兵飘出屏幕；上不钻进 header。
   *  顶到 header 还放不下（最高档 + 键盘把 sheet 顶过头）就顺势淡出：那会儿工作区已经被
   *  sheet 吃掉，硬钉在 header 下沿只会被 sheet 盖住半截。 */
  const indicatorAnimStyle = useAnimatedStyle(() => {
    const sheetY = Math.min(sheetTopY.value, sheetTopYMax);
    /* strip 顶沿：往回倒推「胶囊底沿离 sheet 顶沿 GAP」（胶囊在 strip 里居中，上下各 PAD）。 */
    const wanted = sheetY - INDICATOR_SHEET_GAP - INDICATOR_PAD - PILL_HEIGHT;
    /** 顶格位：胶囊上沿正好贴 header 下沿。 */
    const minTop = topInset - INDICATOR_PAD;
    const overflow = Math.max(0, minTop - wanted);
    return {
      opacity: Math.max(0, 1 - overflow / PILL_HEIGHT),
      transform: [{ translateY: Math.max(minTop, wanted) }],
    };
  });
  /** 底部渐变遮罩：下沿**正好停在** sheet 顶沿（不能越过，见 WORKSPACE_FADE_HEIGHT 的注释），
   *  同一个位置信号驱动，任何档位都对得上。不做钳制 —— 它只是一层洗白，跟着 sheet 滑出画面
   *  （或滑到 header 后面）都无所谓。 */
  const fadeAnimStyle = useAnimatedStyle(() => {
    const sheetY = Math.min(sheetTopY.value, sheetTopYMax);
    return { transform: [{ translateY: sheetY - WORKSPACE_FADE_HEIGHT }] };
  });

  /** 捕获阶段搭便车：看一眼有触摸开始（调用方拿去收键盘），**恒返回 false 不认领 responder**，
   *  事件照常往下传给真正的目标。 */
  const handleUserTouch = useCallback(() => {
    onUserTouch?.();
    return false;
  }, [onUserTouch]);

  return (
    <View style={styles.body} onStartShouldSetResponderCapture={handleUserTouch}>
      <GestureDetector gesture={contentPan}>
        <View style={styles.pager} onLayout={onHostLayout}>
          <Reanimated.View
            style={[styles.track, { width: pageWidth * Math.max(1, tabs.length) }, trackStyle]}
          >
            {tabs.map((tab, i) => {
              /* 占位页是纯静态的，常驻着；文档 / 项目页要拉网络、还带 WebView，只挂**当前页与
                 左右相邻页**。
                 为什么必须带上相邻页：拖拽是 1:1 跟手的，下一页在手指还按着时就已经露在屏幕上，
                 留空壳的话看到的是一页空白滑进来。窗口固定 ±1，再远的仍留空壳 —— 一次最多三个
                 DocBodyView（WebView / 富文本重物），是这套手感必须付的成本。 */
              const isPlaceholder = tab.mode === 'cocoder' || tab.mode === 'cobrowser';
              const mounted = isPlaceholder || Math.abs(i - selectedIndex) <= 1;
              return (
                <View key={tab.key} style={[styles.page, { width: pageWidth }]} collapsable={false}>
                  {!mounted ? null : isPlaceholder ? (
                    <PlaceholderPage
                      icon={MODE_ICON[tab.mode]}
                      title={MODE_LABEL[tab.mode]}
                      hint="手机端暂不支持，请在桌面端查看"
                      topInset={contentTopInset}
                      /* 居中在「header 下沿 ↔ 走马灯上沿」之间：当前档高 + 让开整条指示器。 */
                      bottomInset={viewportBottomInset + INDICATOR_RESERVE}
                      styles={styles}
                      colors={colors}
                    />
                  ) : tab.mode === 'cowriter' ? (
                    <DocBodyView
                      docId={tab.id}
                      /* 树里查不到就按 document 渲染：cowriter 的 doc_ids 绝大多数就是富文本文档，
                         真是别的类型（paper/flowbase）DocBodyView 自己会给出「暂不支持」占位。 */
                      docType={docItems[tab.id]?.type || 'document'}
                      title={labelOf(tab)}
                      meta={docItems[tab.id]?.meta}
                      contentTopInset={contentTopInset}
                      contentBottomInset={bottomInset}
                      /* 排版向聊天正文对齐，见 DOC_* 常量。 */
                      baseFontSize={DOC_BASE_FONT_SIZE}
                      bodyLineHeightRatio={DOC_BODY_LH_RATIO}
                      maxContentWidth={DOC_MAX_CONTENT_WIDTH}
                    />
                  ) : (
                    <CoplannerPage
                      projectId={tab.id}
                      topInset={contentTopInset}
                      /**
                       * 流程图是**居中类**页面（自己缩到全图 + 居中），不是滚动类 —— 所以跟占位页
                       * 取同一个 inset：**当前档高** + 让开整条指示器。
                       *
                       * 之前沿用了旧任务大纲那份 `bottomInset`（= sheet **最低档**）。滚动类页面
                       * 垫最低档是对的（内容本来就该能继续滚到 sheet 底下去），但居中类页面垫它，
                       * 算出来的"可视区"会把 sheet 盖住的那块也算进去 —— 图于是居中到 sheet 后面。
                       * sheet 停在高档位时上方只剩一条，看起来就是「什么都没加载出来」。
                       * WorkspaceBodyProps 里 viewportBottomInset 的注释早写过这个坑，占位页
                       * 当初就是这么翻的车，我换流程图时漏了这条。
                       */
                      bottomInset={viewportBottomInset + INDICATOR_RESERVE}
                      styles={styles}
                      colors={colors}
                    />
                  )}
                </View>
              );
            })}
          </Reanimated.View>
        </View>
      </GestureDetector>
      {/* 圆角缺口的堵头：接在渐变带下沿之后、探到 sheet 背后（见 WORKSPACE_FADE_OVERHANG）。
          放在渐变带**之前**渲染无所谓 —— 两者同 zIndex、不重叠，各管一段。 */}
      <Reanimated.View style={[styles.bottomFadeOverhang, fadeAnimStyle]} pointerEvents="none" />
      {/* 工作区底部的渐变遮罩：在正文之上、走马灯之下（zIndex 4 vs 5）。 */}
      <Reanimated.View style={[styles.bottomFade, fadeAnimStyle]} pointerEvents="none">
        <LinearGradient
          colors={fadeColors}
          locations={FADE_LOCATIONS}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
        />
      </Reanimated.View>
      <TabIndicator
        tabs={tabs}
        selectedKey={selectedKey}
        labelOf={labelOf}
        onSelect={setSelectedKey}
        pan={indicatorPan}
        dragStyle={indicatorDragStyle}
        animStyle={indicatorAnimStyle}
        styles={styles}
        colors={colors}
      />
    </View>
  );
}

type Styles = ReturnType<typeof createStyles>;

/**
 * 本地选中项：默认跟着服务端焦点（activeKey）走，用户手动切过之后仍以「服务端换了焦点」为准
 * （activeKey 一变就重新跟随）——agent 刚改的那篇理应顶到眼前。选中项被关掉（不在序列里了）
 * 时同样落回 activeKey。
 * 渲染期同步纠正（React 官方「props 变了调整 state」模式），不用 effect：
 * 免得先用旧选中渲染一帧、再跳到新的。
 */
function useFollowedSelection(activeKey: string, keys: string[]): [string, (key: string) => void] {
  const [local, setLocal] = useState(activeKey);
  const lastActiveRef = useRef(activeKey);
  if (lastActiveRef.current !== activeKey) {
    lastActiveRef.current = activeKey;
    if (local !== activeKey) setLocal(activeKey);
  }
  return [keys.includes(local) ? local : activeKey, setLocal];
}

/* ───────────────────── 指示器：当前页胶囊 + 其余小圆点 ───────────────────── */

/** 超过这么多项，圆点条就可能顶到边：改成可横滚（同文档 tab 条的老做法）。 */
const MAX_STATIC_TABS = 8;

function TabIndicator({
  tabs,
  selectedKey,
  labelOf,
  onSelect,
  pan,
  dragStyle,
  animStyle,
  styles,
  colors,
}: {
  tabs: CollabTabRef[];
  selectedKey: string;
  labelOf: (tab: CollabTabRef) => string;
  onSelect: (key: string) => void;
  pan: ReturnType<typeof Gesture.Pan>;
  dragStyle: ReturnType<typeof useAnimatedStyle>;
  animStyle: ReturnType<typeof useAnimatedStyle>;
  styles: Styles;
  colors: AppColors;
}) {
  /**
   * 项多到要横滚时**不挂翻页手势**：那时横滑的语义是"滚动圆点条去够远处的项"，跟翻页抢
   * 同一个方向，只能二选一。而项一多，点圆点直达本就比划过去快（点一下 vs 划过 9 页）。
   * 常态（四个模式 + 几篇文档）都挂着。
   */
  const scrollable = tabs.length > MAX_STATIC_TABS;
  const body = (
    /* 外层只负责跟着 sheet 平移（transform 走 UI 线程，比逐帧改 top 省一次布局），
       触摸交给里面那条同尺寸的 strip。 */
    <Reanimated.View style={[styles.tabStripWrap, animStyle]} pointerEvents="box-none">
      <ScrollView
        horizontal
        scrollEnabled={scrollable}
        /* 整条带子收触摸：它**就是**走马灯的拖拽条，胶囊两侧的空白也得能划。它只有 44pt
           高、又浮在 sheet 顶沿上方，挡掉的那一条画布可以接受。 */
        pointerEvents="auto"
        showsHorizontalScrollIndicator={false}
        style={styles.tabStrip}
        contentContainerStyle={styles.tabStripContent}
      >
        {/* 拖拽中整行跟着内容同向微移（见 indicatorDragStyle）。 */}
        <Reanimated.View style={[styles.tabStripRow, dragStyle]}>
          {tabs.map((tab) =>
            tab.key === selectedKey ? (
              <View key={tab.key} style={styles.pill}>
                <Ionicons name={MODE_ICON[tab.mode]} size={14} color={colors.textPrimary} />
                <Text numberOfLines={1} style={styles.pillText}>
                  {labelOf(tab)}
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                key={tab.key}
                onPress={() => onSelect(tab.key)}
                activeOpacity={0.6}
                hitSlop={HIT_SLOP}
                style={styles.dotHit}
              >
                <View style={styles.dot} />
              </TouchableOpacity>
            ),
          )}
        </Reanimated.View>
      </ScrollView>
    </Reanimated.View>
  );
  if (scrollable) return body;
  return <GestureDetector gesture={pan}>{body}</GestureDetector>;
}

/* ──────────────────────── CoPlanner：任务树只读大纲 ──────────────────────── */

function CoplannerPage({
  projectId,
  topInset,
  bottomInset,
  styles,
  colors,
}: {
  projectId: string;
  topInset: number;
  bottomInset: number;
  styles: Styles;
  colors: AppColors;
}) {
  const { getAuth } = useTask();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 请求代数：快速切项目时，旧请求晚到不许盖掉新项目的结果。 */
  const loadGenRef = useRef(0);
  const load = useCallback(async () => {
    const auth = getAuth();
    if (!projectId) return;
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      /* onlyMine:false：任务树要连别人的节点一起拿，否则父子链断开、缩进全乱（同 ProjectScreen）。 */
      const list = await fetchTasks(auth, { projectId, onlyMine: false });
      if (gen !== loadGenRef.current) return;
      setTasks(list.filter((t) => t.project_id === projectId));
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [getAuth, projectId]);

  useEffect(() => {
    setTasks([]);
    void load();
  }, [load]);

  /* 加载 / 出错 / 空项目这三种态自己画（TaskFlowChartView 只管有任务时的图）。 */
  if (loading && tasks.length === 0) {
    return (
      <View style={[styles.coplannerCenter, { paddingTop: topInset, paddingBottom: bottomInset }]}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={[styles.coplannerCenter, { paddingTop: topInset, paddingBottom: bottomInset }]}>
        <TouchableOpacity onPress={() => void load()} activeOpacity={0.7}>
          <Text style={styles.errorText}>{error}（点这里重试）</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (tasks.length === 0) {
    return (
      <View style={[styles.coplannerCenter, { paddingTop: topInset, paddingBottom: bottomInset }]}>
        <Text style={styles.emptyHint}>这个项目还没有任务</Text>
      </View>
    );
  }
  /**
   * 流程图直接复用项目页那套 TaskFlowChartView —— 它的入参就是 `tasks: TaskItem[]`，
   * 跟这里已经在拉的数据完全同形，不需要中间层。
   *
   * 画布的拖拽是 full-range 的（不把横向让给翻页器）：停在这一页时翻页器的横滑是关着的
   * （carouselSwipeOnPager），翻页只在底部指示器上，主画面这幅没有竞争者。
   * bottomInset：底下压着聊天 sheet，减掉之后"缩到全图并居中"才居中在真正看得见的那块里。
   * key={projectId}：换项目时整块重建，别让上一张图的缩放/平移残留过来。
   */
  return (
    <TaskFlowChartView
      key={projectId}
      tasks={tasks}
      topInset={topInset}
      bottomInset={bottomInset}
      /* 按项目缓存视口：切回来停在上次离开的缩放/平移上。
         **key 带 `ws:` 前缀**跟项目页分开 —— 两个界面可能同时挂着同一个项目的图，
         而可视区尺寸差很多（这里是被 header/sheet 夹出来的一条带，项目页是整屏）。
         共用一个 key 会互相覆盖，恢复出来的视口是给另一块画布算的。 */
      viewportCacheKey={`ws:${projectId}`}
      /* 底色跟工作区同层（collabWorkspaceLayer 也是 drawerBackground），
         否则流程图会是一块突兀的白板压在暗一档的工作区上。 */
      backgroundColor={colors.drawerBackground}
    />
  );
}

/* ───────────────────────────── 共用 ───────────────────────────── */

/** 内容显示暂不支持的 mode（cocoder / cobrowser）那一页。 */
function PlaceholderPage({
  icon,
  title,
  hint,
  topInset,
  bottomInset,
  styles,
  colors,
}: {
  icon: IoniconName;
  title: string;
  hint: string;
  topInset: number;
  bottomInset: number;
  styles: Styles;
  colors: AppColors;
}) {
  return (
    <View style={[styles.centered, { paddingTop: topInset, paddingBottom: bottomInset }]}>
      <Ionicons name={icon} size={44} color={colors.placeholder} style={styles.emptyIcon} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyHint}>{hint}</Text>
    </View>
  );
}

const PILL_HEIGHT = 28;
/** strip 比胶囊高一圈：阴影要有地方落 —— ScrollView 会把超出自己边界的那部分裁掉。 */
const INDICATOR_PAD = 8;
const INDICATOR_STRIP_HEIGHT = PILL_HEIGHT + INDICATOR_PAD * 2;
/** 胶囊底沿与 sheet 顶沿之间留的空。 */
const INDICATOR_SHEET_GAP = 10;
/** 整条走马灯从 sheet 顶沿往上占掉的高度：居中类内容要让开这一段。 */
const INDICATOR_RESERVE = INDICATOR_SHEET_GAP + PILL_HEIGHT + INDICATOR_PAD;
/** 越过两端还能拖多少：只跟三成，松手弹回。 */
const TRACK_OVERDRAG = 0.3;
/** 超过这个横向速度（pt/s）算「甩」：位移没够也朝那个方向进一页。 */
const TRACK_FLING_V = 450;
/** 吸附用的弹簧。偏硬、不回弹 —— 翻页要利落，不要晃两下。 */
const TRACK_SPRING = { damping: 22, stiffness: 220, mass: 0.7, overshootClamping: true } as const;
/** 拖拽中指示器行跟着内容同向平移的最大量。 */
const INDICATOR_DRAG_SHIFT = 14;
/**
 * 底部渐变遮罩：从 sheet 顶沿往上这么高，**下沿到 sheet 顶沿为止，一 pt 都不许往下探**。
 *
 * 血的教训（真机截图逐像素量出来的）：早先给它多铺了 8pt「兜亚像素缝」，结果那 8pt 实色
 * 正好糊在 sheet 顶上 —— 量出来 sheet body 顶沿在 435.3pt（按把手指示条倒推），可白面
 * 直到 443.3pt 才开始，中间 **正好 8.0pt** 是纯工作区底色、连 sheet 自己的投影都没有，
 * 说明这条带子是压在 sheet **之上**画的。表现就是圆角弧往上拐到一半被一条横线切掉。
 * 工作区层里任何不透明的东西都不准越过 sheet 顶沿。
 */
const WORKSPACE_FADE_HEIGHT = 96;
/**
 * 渐变带下沿再往 sheet 背后探这么多，**专门堵 sheet 顶沿两侧的圆角缺口**。
 *
 * 起因：流程图画布改成铺满整个工作区后，内容会一直画到 sheet 顶沿之下。sheet 的面是
 * 圆角矩形，左右上角那两片"缺口"里没有面 —— 于是画布上的文字直接从缺口透出来
 * （真机截图右下角那处）。中间被走马灯/渐变盖住的部分没事，坏的就是这两小片。
 *
 * 32 是 sheet 的圆角半径（collabSheetBackground borderTopLeftRadius），取 40 留点余量。
 *
 * 【为什么这次可以越过 sheet 顶沿，而上面那条注释说"一 pt 都不许"】那条教训成立于
 * collabWorkspaceLayer **还没有** zIndex:-1 的年代 —— 当时这层不透明的东西会画到 sheet
 * 之上，把圆角弧和投影一起切掉。zIndex:-1 之后本层被显式压到最底，越过去的部分**在 sheet
 * 背后**：sheet 有面的地方它被完全遮住（连投影都不受影响），只有缺口处露出来 ——
 * 那正是我们要它露的地方。
 * 溶解时它跟着工作区内容一起淡出（同在 collabWorkspaceInner 里），不会在 sheet 化掉之后
 * 留一条横带。
 */
const WORKSPACE_FADE_OVERHANG = 40;
/** 胶囊上沿在渐变带里的位置。**到这儿必须已经洗成实色** —— 第一版这里才 0.5 alpha，
 *  正文就从胶囊背后透出来跟标签糊成一团。 */
const FADE_SOLID_AT = (WORKSPACE_FADE_HEIGHT - INDICATOR_SHEET_GAP - PILL_HEIGHT) / WORKSPACE_FADE_HEIGHT;
/** 四档位置：0 全透明 → 中途 → 胶囊上沿处实色 → 带底（= sheet 顶沿）实色。 */
const FADE_LOCATIONS = [0, FADE_SOLID_AT * 0.55, FADE_SOLID_AT, 1];
const HIT_SLOP = { top: 10, bottom: 10, left: 6, right: 6 };

function createStyles(c: AppColors) {
  return StyleSheet.create({
    body: { flex: 1 },
    /** 翻页轨道的窗口：**必须裁剪**，否则左右邻页会画到工作区外面去。 */
    pager: { flex: 1, overflow: 'hidden' },
    /** 轨道本体：一行横排，总宽 = 页宽 × 页数（宽度按 pageWidth 现算，走内联样式）。 */
    track: { flexDirection: 'row', height: '100%' },
    /** 单页：宽度按 pageWidth 现算，这里只固定高度 —— 给 flex:1 会让几页去平分轨道宽。 */
    page: { height: '100%' },
    /** 「乐观展开但数据没到」那一屏：转圈居中在 header 下沿与 sheet 上沿之间，
     *  padding 跟占位页取同一套 inset，数据到了换成走马灯时视觉重心不跳。 */
    /** 底部渐变遮罩：同样贴原点 + translateY 跟随 sheet；在正文之上、指示器之下。 */
    bottomFade: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: WORKSPACE_FADE_HEIGHT,
      zIndex: 4,
    },
    /** 圆角缺口的堵头：跟渐变带同一个 transform，接在它下沿之后（top = 带高），
     *  所以恰好从 sheet 顶沿开始往下铺。实色取渐变的终点色 = 工作区底色。 */
    bottomFadeOverhang: {
      position: 'absolute',
      top: WORKSPACE_FADE_HEIGHT,
      left: 0,
      right: 0,
      height: WORKSPACE_FADE_OVERHANG,
      backgroundColor: c.drawerBackground,
      zIndex: 4,
    },
    /** 走马灯指示器的定位壳：贴在页面坐标原点，靠 translateY 跟着 sheet 顶沿走。 */
    tabStripWrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: INDICATOR_STRIP_HEIGHT,
      zIndex: 5,
    },
    /** 浮在正文之上，不占正文的位（正文只给 header 让位）。 */
    tabStrip: { flex: 1 },
    tabStripContent: {
      flexGrow: 1,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** 胶囊 + 圆点那一行。单独一层是为了让它整体跟着拖拽微移（indicatorDragStyle）；
     *  横排与间距原本在 contentContainerStyle 上，一并挪过来。 */
    tabStripRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    /** 当前页：展开成带图标的名字胶囊。浮在正文上（不再压在 header 下沿），
     *  所以给一层轻阴影把它从文字里托起来。 */
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height: PILL_HEIGHT,
      paddingHorizontal: 12,
      borderRadius: PILL_HEIGHT / 2,
      maxWidth: 180,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      ...shadowSoft,
    },
    pillText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: c.textPrimary },
    /** 其余页：收成小圆点，点一下直达（触区放到胶囊同高，免得难点）。 */
    dotHit: { height: PILL_HEIGHT, justifyContent: 'center', paddingHorizontal: 3 },
    /** 小圆点同样浮在正文上：给一层 thumb 级的小阴影，压在文字行上也分得清。 */
    dot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: c.placeholder,
      ...shadowToggleThumb,
    },
    errorText: { fontSize: 13, color: c.placeholder, marginVertical: 12 },
    /** coplanner 的 loading / 出错 / 空项目三态：居中在 header 与 sheet 之间那块。 */
    coplannerCenter: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
    emptyIcon: { marginBottom: 12, opacity: 0.5 },
    emptyTitle: { fontSize: 15, fontWeight: '600', color: c.textMuted, marginBottom: 6 },
    emptyHint: { fontSize: 13, color: c.placeholder },
  });
}
