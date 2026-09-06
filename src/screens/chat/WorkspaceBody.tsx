/**
 * WorkspaceBody —— 协同工作模式下的**页面主体**（工作区）。
 *
 * 协同模式的形态是「工作区占页面主体 + 聊天消息区落进底部 sheet」，所以这里画的是
 * agent 正在操作的那个东西本身，不是聊天。四个 mode 铺成**一条走马灯**：
 *  - cowriter：每篇打开着的 FlowDoc 一页，走 DocBodyView 只读渲染；
 *  - coplanner：每个打开着的 FlowTask 项目一页（复用项目页的 TaskFlowChartView 画流程图，
 *    只读；进场自动缩到全图并居中，可双指缩放 / 纵向拖）；
 *  - cocoder / cobrowser：各一页占位（服务端 layout 只给 active_mode，没有对象数据），
 *    内容显示暂不支持，但页面在序列里 —— 桌面端切过去时手机端跟着停到占位页，滑一下能滑回文档。
 * 顶部的胶囊指示器 = 当前页展开成「图标 + 名字」，其余收成小圆点（可点直达）。
 *
 * 边界：**只读**（不编辑文档内容），但切换是**双向**的：
 *  - 服务端换焦点（agent 又改了另一篇 / 桌面端切了 mode）→ 本地跟随 (activeMode, activeId)
 *    二元组跳过去（useFollowedSelection）；
 *  - 用户在这儿横滑 / 点圆点 → 先本地切显示，再经 onSelectTab 回写服务端（ChatScreen 发的
 *    POST /cowriter_layout），于是桌面端下次加载会话时停在同一处、手机端重开也驻留。
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
  View,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import PagerView from 'react-native-pager-view';
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
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
   * 协同数据还没到，但布局已经按本地记录乐观展开了 —— 先摆 loading，别用走马灯里那两个
   * 常驻占位 tab（cocoder / cobrowser）冒充内容：它们恒存在，不摆 loading 的话用户看到的
   * 是"两个空模式"，比转圈更像出错。
   */
  pending?: boolean;
  /**
   * 工作区里任何一次触摸开始时调一下（调用方用来收键盘）。
   *
   * 实现挂在根 View 的 **onStartShouldSetResponderCapture** 上：它在捕获阶段被逐层问到，
   * 我们只是搭个便车看一眼、**恒返回 false**（不认领 responder），所以事件继续往下走 ——
   * 走马灯 tab 的点击、PagerView 的横滑、文档里的可点元素全都照常拿到这次触摸。
   * 不用 onTouchStartCapture 是因为 RN 的 ViewProps 类型里压根没有它（消息区那处同样写法
   * 至今在 tsc 基线里挂着一条 TS2769），而这个钩子是有类型的、语义也更准。
   */
  onUserTouch?: () => void;
  /**
   * 用户**主动**切走马灯（横滑翻页 / 点圆点）时回调，带上目标 tab。
   * 只在用户操作时发；服务端推来的跟随（activeKey 变化经 useFollowedSelection 落到本地）
   * **不发** —— 否则会把桌面端的切换原样回弹给服务端，变成一次无意义的写、还平白 +1 seq。
   */
  onSelectTab?: (tab: CollabTabRef) => void;
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
  pending,
  onUserTouch,
  onSelectTab,
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

  /* ── 翻页器 ↔ 选中项双向同步（ref 比对避免回环） ── */
  const pagerRef = useRef<PagerView | null>(null);
  const pagerPageRef = useRef(selectedIndex);
  /**
   * 【这次翻页是不是手指驱动的】—— 决定 onPageSelected 要不要回写服务端。
   *
   * 要解决的问题：同步 effect 调 setPage 之后 PagerView 照样回一发 onPageSelected，分不出来
   * 的话**被动跟随会被当成用户主动切而回写**，服务端再广播、两端互相纠正 → 闪一下又弹回去。
   *
   * 判据用 `onPageScrollStateChanged` 的 **dragging**，而不是"比对我们刚才设的目标 index"。
   * 后者是**猜**，实测那版间歇性失灵，两个方向的洞都有：
   *  - **漏写**（用户切了却没同步）：程序化 setPage 落到「已经在这一页」时原生不回
   *    onPageSelected，或动画被打断导致回调对不上 —— 目标 index 就**留成了陈旧值**，
   *    之后用户真划到那一页反而被当成回声吞掉；
   *  - **多写**（跟随却写了）：连着两次程序化翻页时只存得下最后一个目标，第一发
   *    onPageSelected 对不上，被误判成用户操作又 POST 一次 —— 震荡照旧。
   *
   * dragging 是**因果**信号而不是猜测：手指划过必然经过 dragging，程序化翻页只走
   * settling → idle。而且它每个滚动周期都会重新置位，不会像 index 那样留下陈旧值毒害后续。
   * 消费即清（onPageSelected 里读完置 false），程序化翻页前也主动清一次。
   */
  const userDrivenPageRef = useRef(false);
  /** tab 集合指纹：增删文档会让索引整体错位，此时要重新把翻页器摆到选中项上。 */
  const tabsSig = tabKeys.join('|');
  const lastSigRef = useRef(tabsSig);
  useEffect(() => {
    const sigChanged = lastSigRef.current !== tabsSig;
    lastSigRef.current = tabsSig;
    if (!sigChanged && pagerPageRef.current === selectedIndex) return;
    pagerPageRef.current = selectedIndex;
    /* 这一发是我们叫的：把手指标记清掉，免得上一轮拖拽的残留把它认成用户操作。 */
    userDrivenPageRef.current = false;
    /* 集合变了是「重新摆位」不是「用户翻页」：直接落位，别播一段无中生有的滑动动画。 */
    if (sigChanged) pagerRef.current?.setPageWithoutAnimation(selectedIndex);
    else pagerRef.current?.setPage(selectedIndex);
  }, [selectedIndex, tabsSig]);

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

  /* 数据没到就只画 loading + 那条底部渐变：走马灯、指示器一概不挂 —— 挂了就得先按
     EMPTY_COLLAB_LAYOUT 铺出两个占位 tab，等数据到了再整个换掉，闪一次。 */
  if (pending) {
    return (
      <View style={styles.body} onStartShouldSetResponderCapture={handleUserTouch}>
        <View
          style={[
            styles.pendingWrap,
            { paddingTop: contentTopInset, paddingBottom: viewportBottomInset },
          ]}
          pointerEvents="none"
        >
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
        <Reanimated.View style={[styles.bottomFade, fadeAnimStyle]} pointerEvents="none">
          <LinearGradient
            colors={fadeColors}
            locations={FADE_LOCATIONS}
            style={StyleSheet.absoluteFill}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
          />
        </Reanimated.View>
      </View>
    );
  }

  return (
    <View style={styles.body} onStartShouldSetResponderCapture={handleUserTouch}>
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={selectedIndex}
        /* offscreenPageLimit 刻意不设：Android 侧透传给 ViewPager2，0 会直接抛
           IllegalArgumentException（只收 >0 或 -1）。真正的省法在下面 —— 只有当前页
           挂真内容，其余页留空壳，免得一次挂起好几个 DocBodyView（WebView / 富文本重物）。 */
        /* 手指一碰就置位；onPageSelected 读完即清（见 userDrivenPageRef）。 */
        onPageScrollStateChanged={(e) => {
          if (e.nativeEvent.pageScrollState === 'dragging') userDrivenPageRef.current = true;
        }}
        onPageSelected={(e) => {
          const i = e.nativeEvent.position;
          pagerPageRef.current = i;
          const key = tabs[i]?.key;
          if (!key) return;
          /* 读完即清：一次滚动周期只算一次用户操作。 */
          const userDriven = userDrivenPageRef.current;
          userDrivenPageRef.current = false;
          if (__DEV__) {
            console.log(
              `[carousel] selected=${i} key=${key} userDriven=${userDriven} wouldPOST=${userDriven}`,
            );
          }
          /**
           * 程序化（服务端焦点变了 / 点圆点已经写过一次了）：**什么都不做**。
           *
           * 这里原来会 setSelectedKeyRaw(key) "对齐本地"，那是个反馈环：本地选中本来就是
           * 这次移动的**源头**（local → selectedIndex → setPage），再把翻页器报回来的页码
           * 写回 local，等于让结果去改原因。只要有一发 onPageSelected 报的不是最终目标页
           * （跨多页的程序化滚动途中、或事件被合并/延迟），local 就被拽到中间页 →
           * 同步 effect 立刻改道去那一页 → 动画被自己打断。
           * 现象就是"闪了一下，而且没停在正确的位置"。
           *
           * pagerPageRef 已在上面记过，同步 effect 靠它判断"还用不用再 setPage"，够了。
           */
          if (!userDriven) return;
          setSelectedKey(key);
        }}
      >
        {tabs.map((tab) => {
          /* 占位页是纯静态的，常驻着（横滑过去当场就有东西看）；文档 / 项目页要拉网络、
             还带 WebView，只在选中时才挂 —— 未选中的留空壳。 */
          const isPlaceholder = tab.mode === 'cocoder' || tab.mode === 'cobrowser';
          const mounted = isPlaceholder || tab.key === selectedKey;
          return (
            <View key={tab.key} style={styles.page} collapsable={false}>
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
      </PagerView>
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
  animStyle,
  styles,
  colors,
}: {
  tabs: CollabTabRef[];
  selectedKey: string;
  labelOf: (tab: CollabTabRef) => string;
  onSelect: (key: string) => void;
  animStyle: ReturnType<typeof useAnimatedStyle>;
  styles: Styles;
  colors: AppColors;
}) {
  /** 项少到不用滚时让整条 strip 透传触摸：它是横跨整幅的浮层，否则胶囊两侧的空白
   *  会白白吃掉正文那一条的滑动。要滚的时候（项多）才收回触摸。 */
  const scrollable = tabs.length > MAX_STATIC_TABS;
  return (
    /* 外层只负责跟着 sheet 平移（transform 走 UI 线程，比逐帧改 top 省一次布局），
       触摸一律 box-none 透传给里面的胶囊 / 圆点。 */
    <Reanimated.View style={[styles.tabStripWrap, animStyle]} pointerEvents="box-none">
      <ScrollView
        horizontal
        scrollEnabled={scrollable}
        pointerEvents={scrollable ? 'auto' : 'box-none'}
        showsHorizontalScrollIndicator={false}
        style={styles.tabStrip}
        contentContainerStyle={styles.tabStripContent}
      >
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
      </ScrollView>
    </Reanimated.View>
  );
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
   * insidePager：把**横向**拖拽让给走马灯，否则手指横划被画布吃掉、用户划不出这一页。
   * bottomInset：底下压着聊天 sheet，减掉之后"缩到全图并居中"才居中在真正看得见的那块里。
   * key={projectId}：换项目时整块重建，别让上一张图的缩放/平移残留过来。
   */
  return (
    <TaskFlowChartView
      key={projectId}
      tasks={tasks}
      topInset={topInset}
      bottomInset={bottomInset}
      insidePager
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
/** 胶囊上沿在渐变带里的位置。**到这儿必须已经洗成实色** —— 第一版这里才 0.5 alpha，
 *  正文就从胶囊背后透出来跟标签糊成一团。 */
const FADE_SOLID_AT = (WORKSPACE_FADE_HEIGHT - INDICATOR_SHEET_GAP - PILL_HEIGHT) / WORKSPACE_FADE_HEIGHT;
/** 四档位置：0 全透明 → 中途 → 胶囊上沿处实色 → 带底（= sheet 顶沿）实色。 */
const FADE_LOCATIONS = [0, FADE_SOLID_AT * 0.55, FADE_SOLID_AT, 1];
const HIT_SLOP = { top: 10, bottom: 10, left: 6, right: 6 };

function createStyles(c: AppColors) {
  return StyleSheet.create({
    body: { flex: 1 },
    pager: { flex: 1 },
    page: { flex: 1 },
    /** 「乐观展开但数据没到」那一屏：转圈居中在 header 下沿与 sheet 上沿之间，
     *  padding 跟占位页取同一套 inset，数据到了换成走马灯时视觉重心不跳。 */
    pendingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    /** 底部渐变遮罩：同样贴原点 + translateY 跟随 sheet；在正文之上、指示器之下。 */
    bottomFade: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: WORKSPACE_FADE_HEIGHT,
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
      gap: 8,
    },
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
