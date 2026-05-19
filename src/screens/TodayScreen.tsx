/**
 * TodayScreen —— 抽屉里「今天」条目对应的顶层页。
 *
 * 整体一个滚动容器，自上而下：
 *  1. 顶部 header：左 = 汉堡按钮（开抽屉）、中 = 今日日期/任务数、右 = 跨项目日历按钮
 *  2. 「今日 tasks」段头 + filter 按钮（右）+ 任务列表（拖拽排序，沿用 TasksHomeScreen 的状态/AsyncStorage key）
 *  3. 「对话」段头 + 历史对话列表（沿用 ConversationListScreen 的拉取、SSE running/unread 指示、长按删除）
 *  4. 底部 sticky 搜索框（UI 占位，后续接搜索 API）
 *
 * 注意：
 *  - 旧 TasksHomeScreen 内的「左缘右滑开 ProjectList」手势 + 「项目入口圆钮」**移除**，由抽屉接管。
 *  - 旧 TasksHomeScreen 内底部的 calendar/end-today/FAB 行 **移除**：日历搬到顶部、新建任务走抽屉底栏的 + 按钮。
 *    （结束今天按钮仍保留在 task 段尾作为一个 inline 按钮，避免破坏现有"今日结束"功能。）
 *  - DraggableFlatList 作为外层滚动容器；conv 段渲染在 ListFooterComponent 里。
 *  - 项目名仍然显示（沿用 showProjectName 偏好）。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import DraggableFlatList from 'react-native-draggable-flatlist';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSharedValue, runOnUI } from 'react-native-reanimated';
import { useTask } from '../context/TaskContext';
import { useSession } from '../context/SessionContext';
import {
  deleteConversation,
  listConversations,
  runInboxStream,
  type ConversationListItem,
} from '../api';
import type { RootStackParamList } from '../navigation/types';
import type { TaskItem, Project } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { TaskFilterSheet, type StatusLevel } from '../components/TaskFilterSheet';
import { ProjectSelectSheet } from '../components/ProjectSelectSheet';
import {
  CreateTaskRegionSheet,
  type CreateRegionChoice,
} from '../components/CreateTaskRegionSheet';
import {
  displayTitleForDumpParent,
  listUnorderedDumpParentsForProject,
} from '../utils/taskChoreRegion';
import { filterTasksByStatusLevel } from '../utils/taskFilters';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { PullToRefreshRing } from '../components/PullToRefreshRing';
import { InboxRunSpinner, InboxUnreadCheck } from '../components/InboxListIndicators';
import { HamburgerButton } from './shell/HamburgerButton';
import { useDrawer } from './shell/DrawerContext';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { shadowCircleButtonThemed, shadowMenu, shadowSoft } from '../theme/shadows';
import {
  HEADER_CIRCLE_BTN_SIZE,
  LIST_PADDING_BOTTOM_WITH_FOOTER,
} from '../theme/layout';
import {
  TASK_FONT_SIZE_SMALL,
  TASK_FONT_SIZE_TITLE,
} from '../theme/typography';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const PULL_RING_THRESHOLD = 120;
const MIN_REFRESH_DURATION_MS = 1000;
const STATUS_KEY = 'statusLevel_todayTasks';
const SHOW_TIME_KEY = 'showTimeLabels_todayTasks';
const SHOW_PROJECT_KEY = 'showProjectName_todayTasks';

function formatTodayDate(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const min = d.getMinutes();
  return `${m}月${day}日 ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return isoString;
  }
}

/** 渲染条目类型：DraggableFlatList 主区只渲染 task；conv 在 footer 里. */
type ListRow = TaskItem;

export function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const { setActive } = useDrawer();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useSession();
  const {
    todayTasks,
    todayDate,
    tasks,
    projects,
    isLoadingTasks,
    errorMessage,
    loadTasks,
    loadProjects,
    toggleTaskCompletion,
    shouldShowEndTodayButton,
    endToday,
    clearError,
    isAheadOfToday,
    cancelAheadOfToday,
  } = useTask();

  /* ---------- task 段：filter / 拖拽顺序 ---------- */
  const [filterVisible, setFilterVisible] = useState(false);
  const [statusLevel, setStatusLevel] = useState<StatusLevel>(3);
  const [showTimeLabels, setShowTimeLabels] = useState(false);
  const [showProjectName, setShowProjectName] = useState(true);

  const filteredTodayTasks = useMemo(
    () => filterTasksByStatusLevel(todayTasks, statusLevel),
    [todayTasks, statusLevel]
  );

  const [localTaskOrder, setLocalTaskOrder] = useState<TaskItem[]>(filteredTodayTasks);
  useEffect(() => {
    setLocalTaskOrder(filteredTodayTasks);
  }, [filteredTodayTasks]);

  useEffect(() => {
    (async () => {
      try {
        const [s, t, p] = await Promise.all([
          AsyncStorage.getItem(STATUS_KEY),
          AsyncStorage.getItem(SHOW_TIME_KEY),
          AsyncStorage.getItem(SHOW_PROJECT_KEY),
        ]);
        if (s != null) {
          const v = parseInt(s, 10);
          if (v >= 0 && v <= 3) setStatusLevel(v as StatusLevel);
        }
        if (t != null) setShowTimeLabels(t === 'true');
        if (p != null) setShowProjectName(p === 'true');
      } catch {
        /* ignore */
      }
    })();
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(STATUS_KEY, String(statusLevel));
  }, [statusLevel]);
  useEffect(() => {
    AsyncStorage.setItem(SHOW_TIME_KEY, String(showTimeLabels));
  }, [showTimeLabels]);
  useEffect(() => {
    AsyncStorage.setItem(SHOW_PROJECT_KEY, String(showProjectName));
  }, [showProjectName]);

  /* ---------- 对话段 ---------- */
  const [convList, setConvList] = useState<ConversationListItem[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [chatV2RunningByConv, setChatV2RunningByConv] = useState<Record<string, boolean>>({});
  const [chatV2UnreadByConv, setChatV2UnreadByConv] = useState<Record<string, boolean>>({});
  const [deleteConvTarget, setDeleteConvTarget] = useState<ConversationListItem | null>(null);

  const loadConvs = useCallback(async () => {
    if (!session) return;
    setConvLoading(true);
    try {
      const { conversations } = await listConversations(session);
      const rows = conversations ?? [];
      setConvList(rows);
      setChatV2RunningByConv((prev) => {
        const next = { ...prev };
        rows.forEach((c) => {
          if (Object.prototype.hasOwnProperty.call(c, 'chat_v2_running')) {
            if (c.chat_v2_running) next[c.id] = true;
            else delete next[c.id];
          }
        });
        return next;
      });
      setChatV2UnreadByConv((prev) => {
        const next = { ...prev };
        rows.forEach((c) => {
          if (Object.prototype.hasOwnProperty.call(c, 'chat_v2_unread')) {
            if (c.chat_v2_unread) next[c.id] = true;
            else delete next[c.id];
          }
        });
        return next;
      });
    } catch {
      setConvList([]);
    } finally {
      setConvLoading(false);
    }
  }, [session]);

  useEffect(() => {
    loadConvs();
  }, [loadConvs]);

  /** inbox/stream SSE：与 ConversationListScreen 一致 */
  useEffect(() => {
    if (!session) return undefined;
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        await runInboxStream(session, ac.signal, (msg) => {
          if (cancelled) return;
          const type = msg.type;
          if (
            type === 'inbox_snapshot' &&
            msg.running &&
            typeof msg.running === 'object'
          ) {
            setChatV2RunningByConv(
              Object.fromEntries(
                Object.entries(msg.running as Record<string, unknown>).filter(
                  ([, v]) => v === true
                )
              ) as Record<string, boolean>
            );
          }
          if (
            type === 'inbox_snapshot' &&
            Object.prototype.hasOwnProperty.call(msg, 'unread') &&
            msg.unread &&
            typeof msg.unread === 'object'
          ) {
            setChatV2UnreadByConv(
              Object.fromEntries(
                Object.entries(msg.unread as Record<string, unknown>).filter(
                  ([, v]) => v === true
                )
              ) as Record<string, boolean>
            );
          }
          if (type === 'conversation_run' && msg.conversation_id != null) {
            const id = String(msg.conversation_id);
            setChatV2RunningByConv((prev) => {
              const next = { ...prev };
              if (msg.running) next[id] = true;
              else delete next[id];
              return next;
            });
          } else if (type === 'conversation_unread' && msg.conversation_id != null) {
            const id = String(msg.conversation_id);
            setChatV2UnreadByConv((prev) => {
              const next = { ...prev };
              if (msg.unread) next[id] = true;
              else delete next[id];
              return next;
            });
          }
        });
      } catch (e: unknown) {
        const name = e && typeof e === 'object' && 'name' in e ? (e as { name?: string }).name : '';
        if (name !== 'AbortError') {
          /* 断线后无自动重连；下拉刷新会同步状态 */
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [session]);

  /* ---------- 刷新 ---------- */
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullDistanceShared = useSharedValue(0);
  const refreshingShared = useSharedValue(false);

  useEffect(() => {
    refreshingShared.value = refreshing;
  }, [refreshing, refreshingShared]);

  useEffect(
    () => () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    },
    []
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (Platform.OS === 'android') {
      Vibration.vibrate(15);
    } else {
      ReactNativeHapticFeedback.trigger('impactHeavy', { enableVibrateFallback: true });
    }
    clearError();
    const startedAt = Date.now();
    try {
      await Promise.all([loadTasks(true), loadProjects(true), loadConvs()]);
    } finally {
      const elapsed = Date.now() - startedAt;
      const remain = MIN_REFRESH_DURATION_MS - elapsed;
      if (remain > 0) {
        refreshTimeoutRef.current = setTimeout(() => {
          refreshTimeoutRef.current = null;
          setRefreshing(false);
        }, remain);
      } else {
        setRefreshing(false);
      }
    }
  }, [clearError, loadTasks, loadProjects, loadConvs]);

  /** session 切换 / 挂载首拉 */
  useEffect(() => {
    if (session) {
      loadTasks(true);
      loadProjects(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const updatePullDistance = runOnUI((pull: number) => {
    'worklet';
    pullDistanceShared.value = pull;
  });

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      if (Platform.OS !== 'ios') return;
      const y = e.nativeEvent.contentOffset.y;
      const pull = y <= 0 ? Math.min(-y, 120) : 0;
      updatePullDistance(pull);
    },
    [updatePullDistance]
  );

  /* ---------- 跳转 ---------- */
  const onTaskPress = useCallback(
    (task: TaskItem) => navigation.navigate('TaskDetail', { taskId: task.id }),
    [navigation]
  );

  /** 对话行点击：与抽屉 Recents 一致，作为顶层页切换，不 stack push */
  const onConvPress = useCallback(
    (conv: ConversationListItem) => {
      setActive({
        kind: 'chat',
        conversationId: conv.id,
        conversationTitle: (conv.title && conv.title.trim()) || '新对话',
      });
    },
    [setActive]
  );

  const onCalendarPress = useCallback(
    () => navigation.navigate('TasksCalendar'),
    [navigation]
  );

  /* ---------- 新建任务（沿用旧 TasksHomeScreen 流程） ---------- */
  const [showProjectSelect, setShowProjectSelect] = useState(false);
  const [showCreateRegionSheet, setShowCreateRegionSheet] = useState(false);
  const [pendingCreateProject, setPendingCreateProject] = useState<Project | null>(null);
  const [createRegionDumpOptions, setCreateRegionDumpOptions] = useState<
    { id: string; title: string }[]
  >([]);

  const onCreateTask = useCallback(() => {
    if (projects.length === 0) return;
    setShowProjectSelect(true);
  }, [projects.length]);

  const onSelectProjectForCreate = useCallback(
    (project: Project) => {
      setShowProjectSelect(false);
      const dumpParents = listUnorderedDumpParentsForProject(tasks, project.id);
      if (dumpParents.length === 0) {
        navigation.navigate('TaskDetail', {
          projectId: project.id,
          projectName: project.name ?? project.id,
          createPlacement: 'unorganized',
        });
        return;
      }
      setPendingCreateProject(project);
      setCreateRegionDumpOptions(
        dumpParents.map((t) => ({ id: t.id, title: displayTitleForDumpParent(t) }))
      );
      setShowCreateRegionSheet(true);
    },
    [navigation, tasks]
  );

  const onCloseCreateRegionSheet = useCallback(() => {
    setShowCreateRegionSheet(false);
    setPendingCreateProject(null);
    setCreateRegionDumpOptions([]);
  }, []);

  const onSelectCreateRegion = useCallback(
    (choice: CreateRegionChoice) => {
      const project = pendingCreateProject;
      if (!project) {
        onCloseCreateRegionSheet();
        return;
      }
      onCloseCreateRegionSheet();
      if (choice.kind === 'unorganized') {
        navigation.navigate('TaskDetail', {
          projectId: project.id,
          projectName: project.name ?? project.id,
          createPlacement: 'unorganized',
        });
        return;
      }
      navigation.navigate('TaskDetail', {
        projectId: project.id,
        projectName: project.name ?? project.id,
        createPlacement: { kind: 'chore_area', parentTaskId: choice.parentTaskId },
      });
    },
    [navigation, pendingCreateProject, onCloseCreateRegionSheet]
  );

  /* ---------- 对话删除 ---------- */
  const closeDeleteConvModal = useCallback(() => setDeleteConvTarget(null), []);
  const confirmDeleteConversation = useCallback(async () => {
    if (!session || !deleteConvTarget) return;
    const conv = deleteConvTarget;
    setDeleteConvTarget(null);
    try {
      await deleteConversation(session, conv.id);
      setConvList((prev) => prev.filter((c) => c.id !== conv.id));
      setChatV2RunningByConv((prev) => {
        const next = { ...prev };
        delete next[conv.id];
        return next;
      });
      setChatV2UnreadByConv((prev) => {
        const next = { ...prev };
        delete next[conv.id];
        return next;
      });
    } catch (e) {
      Alert.alert('删除失败', e instanceof Error ? e.message : '请稍后重试');
    }
  }, [session, deleteConvTarget]);

  /* ---------- 渲染 ---------- */
  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.placeholderText}>请先登录</Text>
      </View>
    );
  }

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  const taskLoading = isLoadingTasks && todayTasks.length === 0;
  const showEndToday = shouldShowEndTodayButton();

  /** 列表头：日期 + filter 段头 */
  const ListHeader = (
    <View style={styles.taskHeaderWrap}>
      <Text style={styles.todayBig}>今日任务</Text>
      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>
          今日 {filteredTodayTasks.length} 个任务
        </Text>
        <TouchableOpacity
          style={styles.smallCircleBtn}
          onPress={() => setFilterVisible(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="filter-outline" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {errorMessage ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
    </View>
  );

  /** 列表尾：结束今天 + 对话段 */
  const ListFooter = (
    <View style={styles.footerWrap}>
      {showEndToday ? (
        <TouchableOpacity style={styles.endTodayBtn} onPress={endToday} activeOpacity={0.8}>
          <Text style={styles.endTodayText}>结束今天</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>对话</Text>
        <View style={{ flex: 1 }} />
      </View>

      {convLoading && convList.length === 0 ? (
        <View style={styles.convLoading}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : convList.length === 0 ? (
        <View style={styles.convEmpty}>
          <Ionicons
            name="chatbubbles-outline"
            size={48}
            color={colors.border}
          />
          <Text style={styles.convEmptyText}>暂无历史对话</Text>
        </View>
      ) : (
        convList.map((c) => (
          <TouchableOpacity
            key={c.id}
            style={styles.convRow}
            onPress={() => onConvPress(c)}
            onLongPress={() => setDeleteConvTarget(c)}
            activeOpacity={0.7}
          >
            <View style={styles.convRowTitle}>
              <Text style={styles.convRowText} numberOfLines={1}>
                {(c.title && c.title.trim()) || '新对话'}
              </Text>
              {chatV2RunningByConv[c.id] ? (
                <InboxRunSpinner />
              ) : chatV2UnreadByConv[c.id] ? (
                <InboxUnreadCheck />
              ) : null}
            </View>
            {c.updated_at ? (
              <Text style={styles.convRowMeta} numberOfLines={1}>
                {formatTime(c.updated_at)}
              </Text>
            ) : null}
          </TouchableOpacity>
        ))
      )}

      {/* 留出空间不让搜索框遮内容 */}
      <View style={{ height: 80 }} />
    </View>
  );

  return (
    <View style={styles.container}>
      {/* 顶部 header（绝对定位，blur 背景） */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        <HamburgerButton />
        <View style={styles.topBarCenter} pointerEvents="none">
          <Text style={styles.todayTitle}>{formatTodayDate(todayDate)}</Text>
          {isAheadOfToday ? (
            <TouchableOpacity onPress={cancelAheadOfToday} activeOpacity={0.7}>
              <Text style={styles.aheadHint}>预览明日 · 点取消</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity
          style={styles.headerCircleBtn}
          onPress={onCalendarPress}
          activeOpacity={0.7}
        >
          <Ionicons name="calendar-outline" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* 主列表 */}
      {taskLoading ? (
        <View style={[styles.centered, { paddingTop: headerHeight }]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>加载中...</Text>
        </View>
      ) : (
        <DraggableFlatList<ListRow>
          containerStyle={{ flex: 1 }}
          data={localTaskOrder}
          keyExtractor={(item) => item.id}
          onDragEnd={({ data }) => setLocalTaskOrder(data)}
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
          ListEmptyComponent={
            <View style={styles.taskEmpty}>
              <Ionicons
                name="checkmark-done-outline"
                size={48}
                color={colors.placeholder}
              />
              <Text style={styles.taskEmptyText}>今日无任务</Text>
            </View>
          }
          renderItem={({ item, drag }) => (
            <TaskRow
              task={item}
              showProjectName={showProjectName}
              showTimeLabel={showTimeLabels}
              projectName={
                projects.find((p) => p.id === item.project_id)?.name ?? undefined
              }
              onPress={() => onTaskPress(item)}
              onToggleCompletion={() => toggleTaskCompletion(item)}
              drag={drag}
            />
          )}
          onScroll={Platform.OS === 'ios' ? handleScroll : undefined}
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              tintColor={colors.primary}
              progressViewOffset={Platform.OS === 'android' ? headerHeight : undefined}
            />
          }
          contentContainerStyle={[
            styles.listContent,
            { paddingTop: headerHeight + 8 },
          ]}
        />
      )}

      {Platform.OS === 'ios' ? (
        <View
          style={[styles.refreshIndicatorFixed, { top: headerHeight }]}
          pointerEvents="none"
        >
          <PullToRefreshRing
            pullDistance={pullDistanceShared}
            refreshing={refreshingShared}
            threshold={PULL_RING_THRESHOLD}
            refreshingState={refreshing}
            color={colors.primary}
          />
        </View>
      ) : null}

      {/* 底部 sticky 搜索框（UI 占位） */}
      <View style={[styles.searchWrap, { paddingBottom: Math.max(insets.bottom, 8) + 8 }]}>
        <View style={styles.searchInputBox}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="搜索任务或对话"
            placeholderTextColor={colors.placeholder}
            returnKeyType="search"
          />
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={onCreateTask}
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* 删除对话确认 */}
      <Modal
        visible={deleteConvTarget != null}
        transparent
        animationType="fade"
        onRequestClose={closeDeleteConvModal}
      >
        <Pressable style={styles.deleteOverlay} onPress={closeDeleteConvModal}>
          <View style={styles.deleteCenter} pointerEvents="box-none">
            <View style={styles.deleteCard} onStartShouldSetResponder={() => true}>
              <Text style={styles.deleteTitle}>删除对话</Text>
              <Text style={styles.deleteBody}>
                确定要删除「
                {(deleteConvTarget?.title && deleteConvTarget.title.trim()) || '新对话'}」吗？
              </Text>
              <View style={styles.deleteActions}>
                <TouchableOpacity
                  style={[styles.deleteBtn, styles.deleteBtnCancel]}
                  onPress={closeDeleteConvModal}
                  activeOpacity={0.75}
                >
                  <Text style={styles.deleteBtnCancelText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.deleteBtn, styles.deleteBtnDanger]}
                  onPress={confirmDeleteConversation}
                  activeOpacity={0.75}
                >
                  <Text style={styles.deleteBtnDangerText}>删除</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* 新建任务的两个 sheet（沿用 TasksHomeScreen） */}
      <ProjectSelectSheet
        visible={showProjectSelect}
        onClose={() => setShowProjectSelect(false)}
        projects={projects}
        onSelectProject={onSelectProjectForCreate}
      />
      <CreateTaskRegionSheet
        visible={showCreateRegionSheet}
        projectLabel={pendingCreateProject?.name ?? pendingCreateProject?.id ?? ''}
        dumpParents={createRegionDumpOptions}
        onClose={onCloseCreateRegionSheet}
        onSelect={onSelectCreateRegion}
      />
      <TaskFilterSheet
        visible={filterVisible}
        onClose={() => setFilterVisible(false)}
        showOnlyMine={false}
        onShowOnlyMineChange={() => {}}
        statusLevel={statusLevel}
        onStatusLevelChange={setStatusLevel}
        showTimeLabels={showTimeLabels}
        onShowTimeLabelsChange={setShowTimeLabels}
        showProjectName={showProjectName}
        onShowProjectNameChange={setShowProjectName}
        showOnlyMineToggle={false}
        isAheadOfToday={isAheadOfToday}
        onCancelAheadOfToday={cancelAheadOfToday}
      />
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    placeholderText: { fontSize: 16, color: c.textMuted },
    loadingText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted },
    topBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    topBarCenter: { alignItems: 'center', flex: 1 },
    todayTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: c.textHeader },
    aheadHint: { fontSize: 12, color: c.primary, marginTop: 2 },
    headerCircleBtn: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
    smallCircleBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderMuted,
    },
    taskHeaderWrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
    todayBig: {
      fontSize: 22,
      fontWeight: '700',
      color: c.textHeader,
      marginBottom: 8,
    },
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginVertical: 8,
    },
    sectionTitle: { fontSize: 14, fontWeight: '600', color: c.textSecondary },
    errorBar: { backgroundColor: c.errorBg, padding: 12, borderRadius: 8, marginBottom: 8 },
    errorText: { fontSize: 14, color: c.danger, textAlign: 'center' },
    taskEmpty: { paddingVertical: 32, alignItems: 'center' },
    taskEmptyText: {
      marginTop: 8,
      fontSize: TASK_FONT_SIZE_SMALL,
      color: c.placeholder,
    },
    listContent: { paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
    footerWrap: { paddingHorizontal: 16, paddingTop: 12 },
    endTodayBtn: {
      alignSelf: 'flex-start',
      paddingHorizontal: 20,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.androidCircleFabHairline,
      marginBottom: 12,
      ...Platform.select({ ios: { ...shadowSoft } }),
    },
    endTodayText: { fontSize: 16, fontWeight: '500', color: c.textPrimary },
    convLoading: { paddingVertical: 24, alignItems: 'center' },
    convEmpty: {
      paddingVertical: 24,
      alignItems: 'center',
    },
    convEmptyText: { marginTop: 8, fontSize: 13, color: c.placeholder },
    convRow: {
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    convRowTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    convRowText: { flex: 1, minWidth: 0, fontSize: 15, color: c.textPrimary, fontWeight: '500' },
    convRowMeta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    refreshIndicatorFixed: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      zIndex: 9,
    },
    /* sticky 搜索 */
    searchWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      paddingTop: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.chatScreenBackground,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderMuted,
    },
    searchInputBox: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 22,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderMuted,
    },
    searchInput: { flex: 1, fontSize: 15, color: c.textPrimary, padding: 0 },
    addBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.borderMuted,
    },
    /* 删除 modal */
    deleteOverlay: { flex: 1, backgroundColor: c.modalBackdrop },
    deleteCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    deleteCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 20,
      width: '100%',
      maxWidth: 340,
      borderWidth: 1,
      borderColor: c.borderMuted,
      ...shadowMenu,
    },
    deleteTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader, marginBottom: 8 },
    deleteBody: { fontSize: 15, color: c.textSecondary, lineHeight: 22, marginBottom: 20 },
    deleteActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
    deleteBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
    deleteBtnCancel: { backgroundColor: c.surfaceMuted },
    deleteBtnDanger: { backgroundColor: c.roseBg },
    deleteBtnCancelText: { fontSize: 16, color: c.textPrimary },
    deleteBtnDangerText: { fontSize: 16, fontWeight: '600', color: c.danger },
  });
}

