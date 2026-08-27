/**
 * WorkspaceBody —— 协同工作模式下的**页面主体**（工作区）。
 *
 * 协同模式的形态是「工作区占页面主体 + 聊天消息区落进底部 sheet」，所以这里画的是
 * agent 正在操作的那个东西本身，不是聊天。四个 mode 铺成**一条走马灯**：
 *  - cowriter：每篇打开着的 FlowDoc 一页，走 DocBodyView 只读渲染；
 *  - coplanner：每个打开着的 FlowTask 项目一页（任务树只读大纲）；
 *  - cocoder / cobrowser：各一页占位（服务端 layout 只给 active_mode，没有对象数据），
 *    内容显示暂不支持，但页面在序列里 —— 桌面端切过去时手机端跟着停到占位页，滑一下能滑回文档。
 * 顶部的胶囊指示器 = 当前页展开成「图标 + 名字」，其余收成小圆点（可点直达）。
 *
 * 边界：**只读 + 纯本地切换**。用户横滑/点圆点只改本地选中，不 POST /cowriter_layout
 * 抢桌面端的焦点。服务端换焦点时（agent 又改了另一篇 / 桌面端切了 mode），本地跟随
 * (activeMode, activeId) 二元组跳过去。
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
import { getFlowDocItemName, getFlowDocTree, type FlowDocTreeItem } from '../../api';
import { fetchTasks, type TaskItem } from '../../taskApi';
import { useSession } from '../../context/SessionContext';
import { useTask } from '../../context/TaskContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { docsTreeStore } from '../docs/docsTreeStore';
import { DocBodyView } from '../docs/DocBodyView';
import {
  activeCollabTabKey,
  collabTabs,
  type CollabLayoutState,
  type CollabTabRef,
  type MobileCollabMode,
} from '../../utils/collabLayout';

export type WorkspaceBodyProps = {
  layout: CollabLayoutState;
  /** 顶部 header 高度：内容从它下方开始（header 是绝对定位浮层）。 */
  topInset: number;
  /** 底部被 sheet + composer 盖住的高度：正文垫这么多，最后一段才滚得出来。 */
  bottomInset: number;
};

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/** 走马灯里的 mode 视觉身份：胶囊图标 + 没有名字时的兜底标签。 */
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

export function WorkspaceBody({ layout, topInset, bottomInset }: WorkspaceBodyProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useSession();
  const { projects } = useTask();

  const tabs = useMemo(() => collabTabs(layout), [layout]);
  const tabKeys = useMemo(() => tabs.map((t) => t.key), [tabs]);
  /** 服务端此刻的焦点（mode + id 二元组压成的 key）。 */
  const activeKey = useMemo(() => activeCollabTabKey(layout), [layout]);
  const [selectedKey, setSelectedKey] = useFollowedSelection(activeKey, tabKeys);
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
  /** tab 集合指纹：增删文档会让索引整体错位，此时要重新把翻页器摆到选中项上。 */
  const tabsSig = tabKeys.join('|');
  const lastSigRef = useRef(tabsSig);
  useEffect(() => {
    const sigChanged = lastSigRef.current !== tabsSig;
    lastSigRef.current = tabsSig;
    if (!sigChanged && pagerPageRef.current === selectedIndex) return;
    pagerPageRef.current = selectedIndex;
    /* 集合变了是「重新摆位」不是「用户翻页」：直接落位，别播一段无中生有的滑动动画。 */
    if (sigChanged) pagerRef.current?.setPageWithoutAnimation(selectedIndex);
    else pagerRef.current?.setPage(selectedIndex);
  }, [selectedIndex, tabsSig]);

  const contentTopInset = topInset + INDICATOR_STRIP_HEIGHT;

  return (
    <View style={styles.body}>
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={selectedIndex}
        /* offscreenPageLimit 刻意不设：Android 侧透传给 ViewPager2，0 会直接抛
           IllegalArgumentException（只收 >0 或 -1）。真正的省法在下面 —— 只有当前页
           挂真内容，其余页留空壳，免得一次挂起好几个 DocBodyView（WebView / 富文本重物）。 */
        onPageSelected={(e) => {
          const i = e.nativeEvent.position;
          pagerPageRef.current = i;
          const key = tabs[i]?.key;
          if (key) setSelectedKey(key);
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
                  bottomInset={bottomInset}
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
                />
              ) : (
                <CoplannerPage
                  projectId={tab.id}
                  title={labelOf(tab)}
                  topInset={contentTopInset}
                  bottomInset={bottomInset}
                  styles={styles}
                  colors={colors}
                />
              )}
            </View>
          );
        })}
      </PagerView>
      <TabIndicator
        tabs={tabs}
        selectedKey={selectedKey}
        labelOf={labelOf}
        onSelect={setSelectedKey}
        top={topInset}
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
  top,
  styles,
  colors,
}: {
  tabs: CollabTabRef[];
  selectedKey: string;
  labelOf: (tab: CollabTabRef) => string;
  onSelect: (key: string) => void;
  top: number;
  styles: Styles;
  colors: AppColors;
}) {
  /** 项少到不用滚时让整条 strip 透传触摸：它是横跨整幅的浮层，否则胶囊两侧的空白
   *  会白白吃掉正文那 40px 的滑动。要滚的时候（项多）才收回触摸。 */
  const scrollable = tabs.length > MAX_STATIC_TABS;
  return (
    <ScrollView
      horizontal
      scrollEnabled={scrollable}
      pointerEvents={scrollable ? 'auto' : 'box-none'}
      showsHorizontalScrollIndicator={false}
      style={[styles.tabStrip, { top }]}
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
  );
}

/* ──────────────────────── CoPlanner：任务树只读大纲 ──────────────────────── */

type OutlineRow = { task: TaskItem; depth: number };

/** childrenId 关系铺成缩进大纲：无父的做根，DFS 下钻；成环/多父只画第一次出现的位置。 */
function buildOutline(tasks: TaskItem[]): OutlineRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childIds = new Set<string>();
  for (const t of tasks) {
    for (const c of t.childrenId ?? []) if (byId.has(c)) childIds.add(c);
  }
  const roots = tasks.filter((t) => !childIds.has(t.id));
  const out: OutlineRow[] = [];
  const seen = new Set<string>();
  const walk = (task: TaskItem, depth: number) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    out.push({ task, depth });
    for (const cid of task.childrenId ?? []) {
      const child = byId.get(cid);
      if (child) walk(child, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  /* 全是环（没有根）时兜底：剩下没画到的平铺出来，别整块空白。 */
  for (const t of tasks) if (!seen.has(t.id)) walk(t, 0);
  return out;
}

function CoplannerPage({
  projectId,
  title,
  topInset,
  bottomInset,
  styles,
  colors,
}: {
  projectId: string;
  title: string;
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

  const outline = useMemo(() => buildOutline(tasks), [tasks]);

  return (
    <ScrollView
      style={styles.body}
      contentContainerStyle={[
        styles.outlineContent,
        { paddingTop: topInset + 24, paddingBottom: bottomInset },
      ]}
    >
      <Text style={styles.projectTitle}>{title}</Text>
      {loading && outline.length === 0 ? (
        <ActivityIndicator color={colors.textMuted} style={styles.inlineSpinner} />
      ) : null}
      {error ? (
        <TouchableOpacity onPress={() => void load()} activeOpacity={0.7}>
          <Text style={styles.errorText}>{error}（点这里重试）</Text>
        </TouchableOpacity>
      ) : null}
      {!loading && !error && outline.length === 0 ? (
        <Text style={styles.emptyHint}>这个项目还没有任务</Text>
      ) : null}
      {outline.map(({ task, depth }) => (
        <View key={task.id} style={[styles.taskRow, { paddingLeft: depth * 16 }]}>
          <View
            style={[
              styles.taskDot,
              task.done ? styles.taskDotDone : task.doing ? styles.taskDotDoing : null,
            ]}
          />
          <Text numberOfLines={2} style={[styles.taskTitle, task.done && styles.taskTitleDone]}>
            {task.title?.trim() || '未命名任务'}
          </Text>
        </View>
      ))}
    </ScrollView>
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

/** 指示器条整体高度（胶囊 28 + 上下留白）：正文用它 + header 高让位。 */
const INDICATOR_STRIP_HEIGHT = 40;
const PILL_HEIGHT = 28;
const HIT_SLOP = { top: 10, bottom: 10, left: 6, right: 6 };

function createStyles(c: AppColors) {
  return StyleSheet.create({
    body: { flex: 1 },
    pager: { flex: 1 },
    page: { flex: 1 },
    /** 走马灯指示器：绝对浮在正文之上（正文用 contentTopInset 让位），随 header 高度下移。 */
    tabStrip: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: INDICATOR_STRIP_HEIGHT,
      zIndex: 5,
    },
    tabStripContent: {
      flexGrow: 1,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    /** 当前页：展开成带图标的名字胶囊。 */
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
    },
    pillText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: c.textPrimary },
    /** 其余页：收成小圆点，点一下直达（触区放到胶囊同高，免得难点）。 */
    dotHit: { height: PILL_HEIGHT, justifyContent: 'center', paddingHorizontal: 3 },
    dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.placeholder },
    outlineContent: { paddingHorizontal: 16 },
    projectTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: c.textHeader,
      marginBottom: 16,
    },
    taskRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      paddingVertical: 7,
    },
    taskDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      marginTop: 6,
      backgroundColor: c.placeholder,
    },
    taskDotDone: { backgroundColor: c.success },
    taskDotDoing: { backgroundColor: c.accentPurple },
    taskTitle: { flex: 1, fontSize: 14, lineHeight: 20, color: c.textBody },
    taskTitleDone: { color: c.textMuted, textDecorationLine: 'line-through' },
    inlineSpinner: { alignSelf: 'flex-start', marginVertical: 12 },
    errorText: { fontSize: 13, color: c.placeholder, marginVertical: 12 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
    emptyIcon: { marginBottom: 12, opacity: 0.5 },
    emptyTitle: { fontSize: 15, fontWeight: '600', color: c.textMuted, marginBottom: 6 },
    emptyHint: { fontSize: 13, color: c.placeholder },
  });
}
