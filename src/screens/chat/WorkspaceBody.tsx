/**
 * WorkspaceBody —— 协同工作模式下的**页面主体**（工作区）。
 *
 * 协同模式的形态是「工作区占页面主体 + 聊天消息区落进底部 sheet」，所以这里画的是
 * agent 正在操作的那个东西本身，不是聊天：
 *  - cowriter：当前会话打开着的 FlowDoc 文档（多篇时顶部一排 tab），走 DocBodyView 只读渲染；
 *  - coplanner：当前会话打开着的 FlowTask 项目任务树（只读大纲）。
 *
 * Phase 1 的边界：**只读**。不落库、不改 layout —— 用户在手机上切 tab 只是本地看看，
 * 不会 POST /cowriter_layout 抢桌面端的焦点（那是后续 Phase 的事）。服务端换焦点时
 * （agent 又改了另一篇），本地跟随 layout.activeDocId 走。
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
import { getFlowDocItemName, getFlowDocTree } from '../../api';
import { fetchTasks, type TaskItem } from '../../taskApi';
import { useSession } from '../../context/SessionContext';
import { useTask } from '../../context/TaskContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { docsTreeStore } from '../docs/docsTreeStore';
import { DocBodyView } from '../docs/DocBodyView';
import type { CollabLayoutState, MobileCollabMode } from '../../utils/collabLayout';

export type WorkspaceBodyProps = {
  mode: MobileCollabMode;
  layout: CollabLayoutState;
  /** 顶部 header 高度：内容从它下方开始（header 是绝对定位浮层）。 */
  topInset: number;
  /** 底部被 sheet + composer 盖住的高度：正文垫这么多，最后一段才滚得出来。 */
  bottomInset: number;
};

export function WorkspaceBody({ mode, layout, topInset, bottomInset }: WorkspaceBodyProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return mode === 'cowriter' ? (
    <CowriterBody
      layout={layout}
      topInset={topInset}
      bottomInset={bottomInset}
      styles={styles}
      colors={colors}
    />
  ) : (
    <CoplannerBody
      layout={layout}
      topInset={topInset}
      bottomInset={bottomInset}
      styles={styles}
      colors={colors}
    />
  );
}

type Styles = ReturnType<typeof createStyles>;
type BodyProps = {
  layout: CollabLayoutState;
  topInset: number;
  bottomInset: number;
  styles: Styles;
  colors: AppColors;
};

/**
 * 本地选中项：默认跟着服务端 activeId 走，用户手动切过之后仍以「服务端换了 active」为准
 * （activeId 一变就重新跟随）——agent 刚改的那篇理应顶到眼前。
 * 渲染期同步纠正（React 官方「props 变了调整 state」模式），不用 effect：
 * 免得先用旧选中渲染一帧、再跳到新的。
 */
function useFollowedSelection(activeId: string, ids: string[]): [string, (id: string) => void] {
  const [local, setLocal] = useState(activeId);
  const lastActiveRef = useRef(activeId);
  if (lastActiveRef.current !== activeId) {
    lastActiveRef.current = activeId;
    if (local !== activeId) setLocal(activeId);
  }
  return [ids.includes(local) ? local : activeId, setLocal];
}

/* ───────────────────────── CoWriter：FlowDoc 只读 ───────────────────────── */

function CowriterBody({ layout, topInset, bottomInset, styles, colors }: BodyProps) {
  const { session } = useSession();
  const slot = layout.cowriter;
  const docIds = useMemo(() => slot?.docIds ?? [], [slot]);
  const [selectedDocId, setSelectedDocId] = useFollowedSelection(slot?.activeDocId ?? '', docIds);

  /** 文档树缓存命中计数：拉到新树后 +1，逼 useMemo 重新解析 item。 */
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

  const item = useMemo(
    () => (selectedDocId ? docsTreeStore.get(selectedDocId) : null),
    /* treeVersion 是缓存失效信号：docsTreeStore 是模块级单例，不把它列进依赖，
       拉到新树后这里永远还读着「查不到」的旧结果。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedDocId, treeVersion],
  );

  /* 树缓存是 DocsScreen 加载后写进去的进程级单例；从聊天页直接进协同模式时它可能还是空的。
     缺项就拉一次全树补上（一次网络，之后所有 tab 都命中）。 */
  useEffect(() => {
    if (!session || !selectedDocId || item || treeFetchedRef.current) return;
    treeFetchedRef.current = true;
    getFlowDocTree(session)
      .then((tree) => {
        docsTreeStore.set(tree);
        if (aliveRef.current) setTreeVersion((v) => v + 1);
      })
      .catch(() => {
        /* 拉不到树不致命：下面按 document 类型 + 单项名字兜底渲染 */
      });
  }, [session, selectedDocId, item]);

  /* tab 标签 / 标题：树里有就用树里的名字；树里没有（内嵌 subdoc 等不在侧栏树上的项）
     再逐个问服务端要名字。 */
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

  if (!slot || !selectedDocId) {
    return <EmptyState styles={styles} colors={colors} icon="document-text-outline" title="没有打开的文档" />;
  }

  const title = names[selectedDocId] || item?.name?.trim() || '未命名文档';
  /* 树里查不到就按 document 渲染：cowriter 的 doc_ids 绝大多数就是富文本文档，
     真是别的类型（paper/flowbase）DocBodyView 自己会给出「暂不支持」占位，不会画错。 */
  const docType = item?.type || 'document';
  const showTabs = docIds.length > 1;

  return (
    <View style={styles.body}>
      {showTabs ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.tabStrip, { top: topInset }]}
          contentContainerStyle={styles.tabStripContent}
        >
          {docIds.map((id) => {
            const active = id === selectedDocId;
            return (
              <TouchableOpacity
                key={id}
                onPress={() => setSelectedDocId(id)}
                activeOpacity={0.7}
                style={[styles.tab, active && styles.tabActive]}
              >
                <Text numberOfLines={1} style={[styles.tabText, active && styles.tabTextActive]}>
                  {names[id] || '文档'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      ) : null}
      <DocBodyView
        key={selectedDocId}
        docId={selectedDocId}
        docType={docType}
        title={title}
        meta={item?.meta}
        contentTopInset={topInset + (showTabs ? TAB_STRIP_HEIGHT : 0)}
        contentBottomInset={bottomInset}
      />
    </View>
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

function CoplannerBody({ layout, topInset, bottomInset, styles, colors }: BodyProps) {
  const { getAuth, projects } = useTask();
  const slot = layout.coplanner;
  const projectIds = useMemo(() => slot?.projectIds ?? [], [slot]);
  const [selectedProjectId, setSelectedProjectId] = useFollowedSelection(
    slot?.activeProjectId ?? '',
    projectIds,
  );

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 请求代数：快速切项目时，旧请求晚到不许盖掉新项目的结果。 */
  const loadGenRef = useRef(0);
  const load = useCallback(async () => {
    const auth = getAuth();
    if (!selectedProjectId) return;
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      /* onlyMine:false：任务树要连别人的节点一起拿，否则父子链断开、缩进全乱（同 ProjectScreen）。 */
      const list = await fetchTasks(auth, { projectId: selectedProjectId, onlyMine: false });
      if (gen !== loadGenRef.current) return;
      setTasks(list.filter((t) => t.project_id === selectedProjectId));
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [getAuth, selectedProjectId]);

  useEffect(() => {
    setTasks([]);
    void load();
  }, [load]);

  const outline = useMemo(() => buildOutline(tasks), [tasks]);
  const nameOf = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name?.trim() || '未命名项目',
    [projects],
  );

  if (!slot || !selectedProjectId) {
    return <EmptyState styles={styles} colors={colors} icon="git-branch-outline" title="没有打开的项目" />;
  }

  const showTabs = projectIds.length > 1;
  return (
    <View style={styles.body}>
      {showTabs ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.tabStrip, { top: topInset }]}
          contentContainerStyle={styles.tabStripContent}
        >
          {projectIds.map((id) => {
            const active = id === selectedProjectId;
            return (
              <TouchableOpacity
                key={id}
                onPress={() => setSelectedProjectId(id)}
                activeOpacity={0.7}
                style={[styles.tab, active && styles.tabActive]}
              >
                <Text numberOfLines={1} style={[styles.tabText, active && styles.tabTextActive]}>
                  {nameOf(id)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      ) : null}
      <ScrollView
        style={styles.body}
        contentContainerStyle={[
          styles.outlineContent,
          {
            paddingTop: topInset + (showTabs ? TAB_STRIP_HEIGHT : 0) + 24,
            paddingBottom: bottomInset,
          },
        ]}
      >
        <Text style={styles.projectTitle}>{nameOf(selectedProjectId)}</Text>
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
                task.done
                  ? styles.taskDotDone
                  : task.doing
                    ? styles.taskDotDoing
                    : null,
              ]}
            />
            <Text
              numberOfLines={2}
              style={[styles.taskTitle, task.done && styles.taskTitleDone]}
            >
              {task.title?.trim() || '未命名任务'}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/* ───────────────────────────── 共用 ───────────────────────────── */

function EmptyState({
  styles,
  colors,
  icon,
  title,
}: {
  styles: Styles;
  colors: AppColors;
  icon: string;
  title: string;
}) {
  return (
    <View style={styles.centered}>
      <Ionicons
        name={icon as React.ComponentProps<typeof Ionicons>['name']}
        size={44}
        color={colors.placeholder}
        style={styles.emptyIcon}
      />
      <Text style={styles.emptyTitle}>{title}</Text>
    </View>
  );
}

const TAB_STRIP_HEIGHT = 44;

function createStyles(c: AppColors) {
  return StyleSheet.create({
    body: { flex: 1 },
    /** 文档 / 项目 tab 条：绝对浮在正文之上（正文用 contentTopInset 让位），随 header 高度下移。 */
    tabStrip: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: TAB_STRIP_HEIGHT,
      zIndex: 5,
    },
    tabStripContent: {
      paddingHorizontal: 12,
      alignItems: 'center',
      gap: 8,
    },
    tab: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: c.surfaceMuted,
      maxWidth: 160,
    },
    tabActive: { backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    tabText: { fontSize: 13, color: c.textSecondary },
    tabTextActive: { color: c.textPrimary, fontWeight: '600' },
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
    emptyTitle: { fontSize: 15, fontWeight: '600', color: c.textMuted },
    emptyHint: { fontSize: 13, color: c.placeholder },
  });
}
