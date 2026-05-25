/**
 * ProjectScreen —— 抽屉里某个 project 条目对应的顶层页（替代旧 ProjectDetailScreen）。
 *
 * 与旧版相比：
 *  - 左上角"返回"圆钮 → 改为汉堡按钮（开抽屉）。本页是顶层，不需要 goBack。
 *  - 底部 floating capsule tab 从 3 项扩到 4 项：Chats / Tasks / Calendar / FlowChart。
 *  - Chats tab：按 conversation.flowtask_project_id 等于当前 projectId 过滤；再用横向胶囊
 *    tab 在「默认 / 各 folder」之间切（参考 Web FlowtaskProjectDetailPage 的 folder-tabs）。
 *  - Tasks tab = 旧 list tab；Calendar tab = 旧 calendar tab；FlowChart tab = 旧 flow tab，逻辑保留。
 *  - RootStack 顶层挂载，左缘开抽屉手势由 DrawerShell 提供；本页自身不挂左缘手势。
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
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnUI,
} from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import { useSession } from '../context/SessionContext';
import {
  createConversation,
  listConversations,
  listFlowtaskFolders,
  placeConversation,
  type ConversationListItem,
  type FlowtaskFolder,
} from '../api';
import { InboxRunSpinner, InboxUnreadCheck } from '../components/InboxListIndicators';
import type { RootStackParamList } from '../navigation/types';
import { fetchTasks, type TaskItem } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { TaskFilterSheet, type StatusLevel } from '../components/TaskFilterSheet';
import { shadowCircleButtonThemed, shadowFabThemed } from '../theme/shadows';
import {
  HEADER_CIRCLE_BTN_SIZE,
  LIST_PADDING_BOTTOM_DEFAULT,
  LIST_TOP_EXTRA,
} from '../theme/layout';
import { TASK_FONT_SIZE_SMALL, TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { BlurHeaderBackground, BlurFooterBackground } from '../components/BlurHeaderBackground';
import { TaskFlowChartView } from '../components/TaskFlowChartView';
import { RemoteCollabPresenceBar } from '../components/RemoteCollabPresenceBar';
import { ScreenErrorBoundary } from '../components/ScreenErrorBoundary';
import { useProjectCollabSocket } from '../hooks/useProjectCollabSocket';
import { PullToRefreshRing } from '../components/PullToRefreshRing';
import { MonthCalendarScroll } from '../components/MonthCalendar';
import {
  filterTasksByShowOnlyMine,
  filterTasksByStatusLevel,
  isTaskBelongToDay,
} from '../utils/taskFilters';
import { HamburgerButton } from './shell/HamburgerButton';
import {
  AnimatedCircleButton,
  IS_IOS_LIQUID_GLASS,
} from '../components/AnimatedCircleButton';
import { Fab } from '../components/Fab';
import { NativeTabBar } from '../components/NativeTabBar';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Tab = 'chats' | 'tasks' | 'calendar' | 'flow';

const SHOW_TIME_KEY = 'showTimeLabels_projectDetail';
const SHOW_PROJECT_KEY = 'showProjectName_projectDetail';
const PULL_RING_THRESHOLD = 120;
const MIN_REFRESH_DURATION_MS = 1000;
const TAB_CAPSULE_PADDING = 4;
const TAB_ACTIVE_ANIM_DURATION = 200;

function formatConvTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return isoString;
  }
}

export type ProjectScreenProps = {
  projectId: string;
  projectName?: string;
};

export function ProjectScreen({ projectId, projectName }: ProjectScreenProps) {
  const navigation = useNavigation<Nav>();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const {
    tasks,
    projects,
    loadTasks,
    loadProjects,
    toggleTaskCompletion,
    isLoadingTasks,
    getAuth,
    mergeProjectTasksSnapshot,
  } = useTask();

  /* ---------- 该项目数据 ---------- */
  const project = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );
  const title = projectName ?? project?.name ?? projectId;

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.project_id === projectId),
    [tasks, projectId]
  );

  const taskAuth = getAuth();

  const [flowChartTasks, setFlowChartTasks] = useState<TaskItem[]>([]);
  const [flowChartLoading, setFlowChartLoading] = useState(false);

  const handleRemoteProjectTasksRefresh = useCallback(async () => {
    const a = getAuth();
    if (!a) return;
    try {
      const list = await fetchTasks(a, { projectId, onlyMine: false });
      const safe = Array.isArray(list) ? list : [];
      mergeProjectTasksSnapshot(projectId, safe);
      setFlowChartTasks(safe);
      await loadProjects(true);
    } catch {
      /* ignore */
    }
  }, [getAuth, projectId, mergeProjectTasksSnapshot, loadProjects]);

  const { visibleRemoteSessions } = useProjectCollabSocket({
    projectId,
    enabled: Boolean(taskAuth && projectId && !projectId.startsWith('__')),
    auth: taskAuth,
    onRemoteProjectTasksRefresh: handleRemoteProjectTasksRefresh,
  });

  const tasksForCollabPresence = useMemo(() => {
    if (flowChartTasks.length > 0) return flowChartTasks;
    return projectTasks;
  }, [flowChartTasks, projectTasks]);

  /* ---------- tab 状态与设置 ---------- */
  const [tab, setTab] = useState<Tab>('chats');
  const [selectedDate, setSelectedDate] = useState(() => new Date());

  const [filterVisible, setFilterVisible] = useState(false);
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const [statusLevel, setStatusLevel] = useState<StatusLevel>(1);
  const [showTimeLabels, setShowTimeLabels] = useState(false);
  const [showProjectName, setShowProjectName] = useState(false);
  const [showOnlyMineCalendar, setShowOnlyMineCalendar] = useState(false);
  const [statusLevelCalendar, setStatusLevelCalendar] = useState<StatusLevel>(3);

  /* ---------- 项目对话段 ---------- */
  const { session } = useSession();
  const [convList, setConvList] = useState<ConversationListItem[]>([]);
  const [folders, setFolders] = useState<FlowtaskFolder[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  /** null = 「默认」段（flowtask_folder_id 为空的对话），string = 某 folder.id */
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);

  const loadConvs = useCallback(async () => {
    if (!session) return;
    setConvLoading(true);
    try {
      const [convRes, folderRes] = await Promise.all([
        listConversations(session),
        listFlowtaskFolders(session, projectId).catch(() => ({ folders: [] as FlowtaskFolder[] })),
      ]);
      setConvList(convRes.conversations ?? []);
      setFolders(folderRes.folders ?? []);
    } catch {
      setConvList([]);
      setFolders([]);
    } finally {
      setConvLoading(false);
    }
  }, [session, projectId]);

  useEffect(() => {
    loadConvs();
  }, [loadConvs]);

  /** 跟 Web ConversationList 的语义一致：按 conversation.flowtask_project_id 等于当前项目 ID 过滤 */
  const projectConvs = useMemo(
    () => convList.filter((c) => c.flowtask_project_id === projectId),
    [convList, projectId]
  );

  /** 按 folder 分组：null key = "默认"；string key = folder.id。计数给 capsule tab 用 */
  const convCountByFolder = useMemo(() => {
    const map = new Map<string | null, number>();
    map.set(null, 0);
    folders.forEach((f) => map.set(f.id, 0));
    for (const c of projectConvs) {
      const fid = typeof c.flowtask_folder_id === 'string' && c.flowtask_folder_id.trim()
        ? c.flowtask_folder_id.trim()
        : null;
      map.set(fid, (map.get(fid) ?? 0) + 1);
    }
    return map;
  }, [projectConvs, folders]);

  /** 当 folder 数据变化（比如刚加载完）后，若 activeFolderId 不存在了就回到默认 */
  useEffect(() => {
    if (activeFolderId == null) return;
    if (!folders.some((f) => f.id === activeFolderId)) setActiveFolderId(null);
  }, [folders, activeFolderId]);

  /** 当前胶囊 tab 下的对话子集 */
  const visibleConvs = useMemo(() => {
    return projectConvs.filter((c) => {
      const fid = typeof c.flowtask_folder_id === 'string' && c.flowtask_folder_id.trim()
        ? c.flowtask_folder_id.trim()
        : null;
      return fid === activeFolderId;
    });
  }, [projectConvs, activeFolderId]);

  const onConvPress = useCallback(
    (conv: ConversationListItem) => {
      navigation.navigate('Chat', {
        conversationId: conv.id,
        conversationTitle: (conv.title && conv.title.trim()) || '新对话',
      });
    },
    [navigation]
  );

  /** chats tab 右上角「+」：建一条空对话，挂到当前项目（+ 当前 folder，如果有选中）。
   *  Place 失败也照常进 Chat，避免阻塞用户输入，后续用户进 Chat 后还可手动归位。 */
  const handleNewConv = useCallback(async () => {
    if (!session) return;
    try {
      const { id } = await createConversation(session);
      await placeConversation(session, id, {
        flowtask_project_id: projectId,
        flowtask_folder_id: activeFolderId,
      }).catch(() => undefined);
      navigation.navigate('Chat', { conversationId: id, conversationTitle: '新对话' });
      // 不 await，让导航先发生；列表刷新跟在后台
      loadConvs();
    } catch (e) {
      Alert.alert('新建对话失败', e instanceof Error ? e.message : String(e));
    }
  }, [session, projectId, activeFolderId, navigation, loadConvs]);

  const statusKey = useMemo(() => `statusLevel_project_${projectId}`, [projectId]);
  const statusLevelCalendarKey = useMemo(
    () => `statusLevelCalendar_project_${projectId}`,
    [projectId]
  );

  const listTasks = useMemo(
    () => projectTasks.filter((t) => t.type !== 'milestone'),
    [projectTasks]
  );

  const filteredProjectTasks = useMemo(() => {
    const byMine = filterTasksByShowOnlyMine(listTasks, showOnlyMine);
    return filterTasksByStatusLevel(byMine, statusLevel);
  }, [listTasks, showOnlyMine, statusLevel]);

  const calendarTasks = useMemo(() => {
    const byMine = filterTasksByShowOnlyMine(listTasks, showOnlyMineCalendar);
    const byStatus = filterTasksByStatusLevel(byMine, statusLevelCalendar);
    return byStatus.filter((t) => isTaskBelongToDay(t, selectedDate));
  }, [listTasks, showOnlyMineCalendar, statusLevelCalendar, selectedDate]);

  useEffect(() => {
    (async () => {
      try {
        const [s, t, p, sc] = await Promise.all([
          AsyncStorage.getItem(statusKey),
          AsyncStorage.getItem(SHOW_TIME_KEY),
          AsyncStorage.getItem(SHOW_PROJECT_KEY),
          AsyncStorage.getItem(statusLevelCalendarKey),
        ]);
        if (s != null) {
          const v = parseInt(s, 10);
          if (v >= 0 && v <= 3) setStatusLevel(v as StatusLevel);
        }
        if (t != null) setShowTimeLabels(t === 'true');
        if (p != null) setShowProjectName(p === 'true');
        if (sc != null) {
          const v = parseInt(sc, 10);
          if (v >= 0 && v <= 3) setStatusLevelCalendar(v as StatusLevel);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [statusKey, statusLevelCalendarKey]);

  useEffect(() => {
    AsyncStorage.setItem(statusKey, String(statusLevel));
  }, [statusLevel, statusKey]);
  useEffect(() => {
    AsyncStorage.setItem(SHOW_TIME_KEY, String(showTimeLabels));
  }, [showTimeLabels]);
  useEffect(() => {
    AsyncStorage.setItem(SHOW_PROJECT_KEY, String(showProjectName));
  }, [showProjectName]);
  useEffect(() => {
    AsyncStorage.setItem(statusLevelCalendarKey, String(statusLevelCalendar));
  }, [statusLevelCalendar, statusLevelCalendarKey]);

  /* ---------- 拉 flow 全量 ---------- */
  useEffect(() => {
    if (tab !== 'flow') return;
    let cancelled = false;
    setFlowChartLoading(true);
    (async () => {
      try {
        const a = getAuth();
        if (!a) {
          if (!cancelled) setFlowChartTasks([]);
          return;
        }
        const list = await fetchTasks(a, { projectId, onlyMine: false });
        if (!cancelled) setFlowChartTasks(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setFlowChartTasks([]);
      } finally {
        if (!cancelled) setFlowChartLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, projectId, getAuth]);

  /* ---------- 下拉刷新 ---------- */
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
    const startedAt = Date.now();
    try {
      const flowAuth = getAuth();
      const extra =
        tab === 'flow' && flowAuth
          ? fetchTasks(flowAuth, { projectId, onlyMine: false }).then((list) => {
              setFlowChartTasks(Array.isArray(list) ? list : []);
            })
          : Promise.resolve();
      await Promise.all([loadTasks(true), loadProjects(true), extra]);
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
  }, [getAuth, loadProjects, loadTasks, projectId, tab]);

  const onTaskPress = useCallback(
    (taskId: string) => navigation.navigate('TaskDetail', { taskId }),
    [navigation]
  );

  const onCreateTask = useCallback(() => {
    navigation.navigate('TaskDetail', {
      projectId,
      projectName: project?.name ?? title,
    });
  }, [navigation, projectId, project?.name, title]);

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

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;

  return (
    <View style={styles.container}>
      {/* 顶部 header */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        <HamburgerButton />
        <View style={styles.topBarCenter} pointerEvents="none">
          <Text style={styles.topBarTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {tab === 'chats' ? (
          <AnimatedCircleButton
            style={styles.headerCircleBtn}
            onPress={handleNewConv}
            iosSfSymbol={{ name: 'plus', size: 16, color: colors.textSecondary }}
          >
            <Ionicons name="add" size={26} color={colors.textSecondary} />
          </AnimatedCircleButton>
        ) : (
          <AnimatedCircleButton
            style={styles.headerCircleBtn}
            onPress={() => setFilterVisible(true)}
            iosSfSymbol={{ name: 'line.3.horizontal.decrease', size: 16, color: colors.textSecondary }}
          >
            <Ionicons name="filter-outline" size={22} color={colors.textSecondary} />
          </AnimatedCircleButton>
        )}
      </View>

      {visibleRemoteSessions.length > 0 ? (
        <View style={[styles.collabPresenceTopWrap, { top: headerHeight }]} pointerEvents="none">
          <RemoteCollabPresenceBar
            variant="floating"
            sessions={visibleRemoteSessions}
            tasks={tasksForCollabPresence}
          />
        </View>
      ) : null}

      <ScreenErrorBoundary key={`project-${projectId}-${tab}`} title="当前标签页加载异常">
        <View style={styles.mainContent}>
          {tab === 'chats' && (
            <View style={[styles.tabRoot, { paddingTop: headerHeight }]}>
              {convLoading && projectConvs.length === 0 ? (
                <View style={styles.centered}>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
              ) : projectConvs.length === 0 ? (
                <View style={styles.centered}>
                  <Ionicons
                    name="chatbubbles-outline"
                    size={56}
                    color={colors.placeholder}
                  />
                  <Text style={styles.emptyText}>暂无项目对话</Text>
                  <Text style={styles.emptyHint}>
                    项目内的对话会出现在这里
                  </Text>
                </View>
              ) : (
                <>
                  {/* folder 维度胶囊 tab：横向滚动；首项「默认」恒挂，对应没归入子文件夹的对话。
                      跟 Web FlowtaskProjectDetailPage 的 folder-tabs 等价语义。
                      没自定义 folder 时整行不挂——只剩一个「默认」tab 没有切换意义、还占空间。 */}
                  {folders.length > 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.folderTabsScroll}
                      contentContainerStyle={styles.folderTabsRow}
                      contentInsetAdjustmentBehavior="never"
                    >
                      {[
                        { id: null as string | null, name: '默认' },
                        ...folders.map((f) => ({ id: f.id, name: f.name || '(未命名)' })),
                      ].map((item) => {
                        const active = activeFolderId === item.id;
                        const cnt = convCountByFolder.get(item.id) ?? 0;
                        /* iOS 强制走 worklet 路径（iosForceWorklet）—— 跟 Android 同款 Reanimated
                         * bounce，不走 iOS 26 glass material。这样：
                         *   - bg 色完全自由（folderTabActive 的 c.primary / folderTab 的 surfaceMuted 浅灰）
                         *   - 没玻璃材质固有的 drop shadow
                         *   - React children 两个 Text 各自 fontSize / color / weight 都生效
                         *   - 仍有 UI 线程 bouncy press 反馈
                         * 之前试 native glass 走 iosNativeTitle 因为单一字符串单一样式没法实现
                         * 「label 14pt + count 13pt 半透明」，干脆放弃 glass。glass 留给 Fab /
                         * HeaderCircleButton 等真吃材质的按钮。 */
                        return (
                          <AnimatedCircleButton
                            key={item.id ?? '__default'}
                            style={[styles.folderTab, active && styles.folderTabActive]}
                            onPress={() => setActiveFolderId(item.id)}
                            iosForceWorklet
                          >
                            <Text
                              style={[styles.folderTabLabel, active && styles.folderTabLabelActive]}
                              numberOfLines={1}
                            >
                              {item.name}
                            </Text>
                            <Text
                              style={[styles.folderTabCount, active && styles.folderTabCountActive]}
                            >
                              {cnt}
                            </Text>
                          </AnimatedCircleButton>
                        );
                      })}
                    </ScrollView>
                  ) : null}
                  <ScrollView
                    style={styles.convScrollOuter}
                    contentContainerStyle={styles.convScrollContent}
                    /* 内容刚好够长触发滚动时 iOS 默认 contentInsetAdjustmentBehavior 会回调
                     * 一次 inset 调整 → 触发整个 tabRoot layout pass → folder tabs 高度抖
                     * 1-2pt（用户报告的「滚动触发上下抖动」）。设 never 关掉自动调整。
                     * automaticallyAdjustsScrollIndicatorInsets 也关掉，避免 scroll indicator
                     * 出现/消失时 iOS 再触发一次 inset 回调。
                     * convScrollOuter 显式 flex:1 让 ScrollView 占固定空间，外层尺寸不随内容
                     * 长短变化，从根上断掉「内容增减触发父 layout pass」的链路。 */
                    contentInsetAdjustmentBehavior="never"
                    automaticallyAdjustsScrollIndicatorInsets={false}
                    refreshControl={
                      <RefreshControl
                        refreshing={convLoading}
                        onRefresh={loadConvs}
                        tintColor={colors.primary}
                      />
                    }
                  >
                    {visibleConvs.length === 0 ? (
                      <View style={styles.convFolderEmpty}>
                        <Text style={styles.convFolderEmptyText}>该文件夹下暂无对话</Text>
                      </View>
                    ) : (
                      visibleConvs.map((c) => (
                        <TouchableOpacity
                          key={c.id}
                          style={styles.convRow}
                          onPress={() => onConvPress(c)}
                          activeOpacity={0.7}
                        >
                          <View style={styles.convRowTitle}>
                            <Text style={styles.convRowText} numberOfLines={1}>
                              {(c.title && c.title.trim()) || '新对话'}
                            </Text>
                            {c.chat_v2_running ? (
                              <InboxRunSpinner />
                            ) : c.chat_v2_unread ? (
                              <InboxUnreadCheck />
                            ) : null}
                          </View>
                          {c.updated_at ? (
                            <Text style={styles.convRowMeta} numberOfLines={1}>
                              {formatConvTime(c.updated_at)}
                            </Text>
                          ) : null}
                        </TouchableOpacity>
                      ))
                    )}
                  </ScrollView>
                </>
              )}
            </View>
          )}

          {tab === 'tasks' && (
            <>
              {isLoadingTasks && projectTasks.length === 0 ? (
                <View style={[styles.mainContent, { paddingTop: headerHeight }]}>
                  <View style={styles.centered}>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text style={styles.loadingText}>加载中...</Text>
                  </View>
                </View>
              ) : (
                <FlatList
                  data={filteredProjectTasks}
                  keyExtractor={(item) => item.id}
                  renderItem={({ item }) => (
                    <TaskRow
                      task={item}
                      showProjectName={showProjectName}
                      showTimeLabel={showTimeLabels}
                      onPress={() => onTaskPress(item.id)}
                      onToggleCompletion={() => toggleTaskCompletion(item)}
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
                      progressViewOffset={
                        Platform.OS === 'android' ? headerHeight + LIST_TOP_EXTRA : undefined
                      }
                    />
                  }
                  ListEmptyComponent={
                    <View style={styles.emptyBox}>
                      <Ionicons
                        name="checkbox-outline"
                        size={56}
                        color={colors.placeholder}
                      />
                      <Text style={styles.emptyText}>该项目暂无任务</Text>
                    </View>
                  }
                  contentContainerStyle={[
                    filteredProjectTasks.length === 0
                      ? styles.emptyList
                      : styles.listContent,
                    { paddingTop: headerHeight + LIST_TOP_EXTRA, paddingBottom: 100 },
                  ]}
                />
              )}
            </>
          )}

          {tab === 'calendar' && (
            <CalendarTab
              headerHeight={headerHeight}
              selectedDate={selectedDate}
              onDateChange={setSelectedDate}
              calendarTasks={calendarTasks}
              showTimeLabels={showTimeLabels}
              showProjectName={showProjectName}
              onTaskPress={onTaskPress}
              onToggleCompletion={toggleTaskCompletion}
              onRefresh={onRefresh}
              refreshing={refreshing}
              colors={colors}
            />
          )}

          {tab === 'flow' &&
            (flowChartLoading && flowChartTasks.length === 0 ? (
              <View style={[styles.mainContent, { paddingTop: headerHeight }]}>
                <View style={styles.centered}>
                  <ActivityIndicator size="large" color={colors.primary} />
                  <Text style={styles.loadingText}>加载项目全量任务…</Text>
                </View>
              </View>
            ) : (
              <TaskFlowChartView key={projectId} tasks={flowChartTasks} topInset={headerHeight} />
            ))}
        </View>
      </ScreenErrorBoundary>

      {Platform.OS === 'ios' && tab === 'tasks' ? (
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

      {/* 底栏背后的渐变 fade，跟 TodayScreen 同款 —— 滚动列表滚到 tab/FAB 下方时被柔化遮挡。
          三个 knob 跟 TodayScreen 同语义可独立调：
            FADE_BOTTOM_BELOW: fade 底端离屏底距离（0 = 贴屏底；正值往上推）
            FADE_TOP_ABOVE: fade 顶端离屏底距离（值越大越上、渐变越长）
            FADE_SOLID_HEIGHT: 底部纯实色块高度（覆盖 safe-area 防 home indicator 区显空） */}
      {(() => {
        const FADE_BOTTOM_BELOW = 0;
        const FADE_TOP_ABOVE = Math.max(insets.bottom, 12) + 60 + 26;
        const FADE_SOLID_HEIGHT = Math.max(insets.bottom, 38);
        return (
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: -FADE_BOTTOM_BELOW,
              height: FADE_TOP_ABOVE + FADE_BOTTOM_BELOW,
            }}
            pointerEvents="none"
          >
            <BlurFooterBackground
              bottomSolidHeight={FADE_SOLID_HEIGHT}
              gradientBaseHex={colors.chatScreenBackground}
            />
          </View>
        );
      })()}

      {/* 底部 sticky：tab + FAB 单行并列。tab 拿 flex:1 横向铺满，FAB 紧贴右侧。
          iOS 26+ 走原生 UITabBar（icon 上 / title 下 stacked + Liquid Glass）；
          iOS < 26 / Android 走自绘 tabCapsule 兜底。 */}
      <View
        style={[
          styles.bottomBar,
          { paddingBottom: Math.max(insets.bottom, 12) + 4 },
        ]}
      >
        <View style={styles.bottomRow}>
          {IS_IOS_LIQUID_GLASS ? (
            <NativeTabBar<Tab>
              style={styles.nativeTabs}
              iconSize={14}
              titleSize={9}
              selectedTintColor="#3a3a3c"
              items={[
                { key: 'chats', title: 'Chats', sfSymbol: 'bubble.left.and.bubble.right' },
                { key: 'tasks', title: 'Tasks', sfSymbol: 'list.bullet' },
                { key: 'calendar', title: 'Calendar', sfSymbol: 'calendar' },
                { key: 'flow', title: 'Flow', sfSymbol: 'point.3.connected.trianglepath.dotted' },
              ]}
              selectedKey={tab}
              onChange={setTab}
            />
          ) : (
            <View style={[styles.tabCapsule, styles.tabCapsuleFlex]}>
              {(
                [
                  { tab: 'chats' as Tab, label: 'Chats', icon: 'chatbubbles-outline' },
                  { tab: 'tasks' as Tab, label: 'Tasks', icon: 'list' },
                  { tab: 'calendar' as Tab, label: 'Calendar', icon: 'calendar' },
                  { tab: 'flow' as Tab, label: 'Flow', icon: 'git-network-outline' },
                ] as const
              ).map(({ tab: t, label, icon }) => (
                <TabBtn
                  key={t}
                  label={label}
                  icon={icon}
                  active={tab === t}
                  onPress={() => setTab(t)}
                  colors={colors}
                />
              ))}
            </View>
          )}
          {/* iOS 26+ glass 路径：UIButton glass material 在 60pt bounds 内部有 ~4pt 居中
              内缩——可视玻璃圆比 bounds 小一圈，flex-end 对齐后视觉底比 tab pill 视觉底
              高几 pt。translateY: 7 硬把 FAB 视觉往下推补偿，让两个视觉底对齐。
              Android / iOS<26 fallback 没有 glass material 内缩，translateY 0，FAB 自然跟
              tab capsule 底对齐。 */}
          <Fab
            ionicon="add"
            sfSymbol="plus"
            size={60}
            style={IS_IOS_LIQUID_GLASS ? { transform: [{ translateY: 8 }] } : undefined}
            onPress={onCreateTask}
          />
        </View>
      </View>

      <TaskFilterSheet
        visible={filterVisible}
        onClose={() => setFilterVisible(false)}
        showOnlyMine={tab === 'calendar' ? showOnlyMineCalendar : showOnlyMine}
        onShowOnlyMineChange={tab === 'calendar' ? setShowOnlyMineCalendar : setShowOnlyMine}
        statusLevel={tab === 'calendar' ? statusLevelCalendar : statusLevel}
        onStatusLevelChange={tab === 'calendar' ? setStatusLevelCalendar : setStatusLevel}
        showTimeLabels={showTimeLabels}
        onShowTimeLabelsChange={setShowTimeLabels}
        showProjectName={showProjectName}
        onShowProjectNameChange={setShowProjectName}
        showOnlyMineToggle={true}
        onShowDeletedTasks={() => Alert.alert('近期删除', '敬请期待')}
      />
    </View>
  );
}

/* TabBtn —— Android / iOS<26 fallback。布局参考 iOS NativeTabBar（icon 上 / label 下
 *  stacked，capsule 高 60pt），但 active 视觉用我们原有的设计：active 段渲染填充背景
 *  pill（colors.userBubble），icon + label 翻到 colors.onUserBubble；非 active 段是
 *  colors.textMuted、无背景。pill 通过 Animated opacity 在 active 切换时淡入淡出 200ms。
 *
 *  capsule + overflow:hidden 让 absoluteFill 的 bg pill 跟 TabBtn 形状贴合。 */
function TabBtn({
  label,
  icon,
  active,
  onPress,
  colors,
}: {
  label: string;
  icon: string;
  active: boolean;
  onPress: () => void;
  colors: AppColors;
}) {
  /* active bg 用深灰 '#3a3a3c'（iOS tertiary system fill 色值，比 colors.userBubble 浅一档
     —— userBubble 在浅色主题下是 #1c1c1c 接近纯黑、用户觉得太重）。这个色值在浅色 + 深色
     主题下都跟 surface 形成足够对比：浅色 surface=白时它是深灰显眼；深色 surface=#1f1f1f
     时它略亮看着"高亮"。 */
  const activeBg = '#3a3a3c';
  const activeFg = colors.onUserBubble;
  const inactiveFg = colors.textMuted;
  const fg = active ? activeFg : inactiveFg;

  const v = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    v.value = withTiming(active ? 1 : 0, { duration: TAB_ACTIVE_ANIM_DURATION });
  }, [active, v]);

  const bgStyle = useAnimatedStyle(() => ({ opacity: v.value }));

  return (
    <TouchableOpacity
      style={tabStyles.btn}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Animated.View
        style={[tabStyles.btnBg, bgStyle, { backgroundColor: activeBg }]}
        pointerEvents="none"
      />
      <View style={tabStyles.btnContent}>
        <Ionicons name={icon as never} size={22} color={fg} />
        <Text style={[tabStyles.label, { color: fg }]}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}

const tabStyles = StyleSheet.create({
  btn: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 999,
    overflow: 'hidden',
  },
  btnBg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 999 },
  btnContent: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
    zIndex: 1,
  },
  label: { fontSize: 9, fontWeight: '600' },
});

function CalendarTab({
  headerHeight,
  selectedDate,
  onDateChange,
  calendarTasks,
  showTimeLabels,
  showProjectName,
  onTaskPress,
  onToggleCompletion,
  onRefresh,
  refreshing,
  colors,
}: {
  headerHeight: number;
  selectedDate: Date;
  onDateChange: (d: Date) => void;
  calendarTasks: TaskItem[];
  showTimeLabels: boolean;
  showProjectName: boolean;
  onTaskPress: (id: string) => void;
  onToggleCompletion: (t: TaskItem) => void;
  onRefresh: () => void;
  refreshing: boolean;
  colors: AppColors;
}) {
  const s = useMemo(
    () =>
      StyleSheet.create({
        tabRoot: { flex: 1 },
        divider: {
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.conversationListSeparator,
          marginVertical: 8,
        },
        tasksScroll: { flex: 1 },
        empty: { paddingVertical: 48, alignItems: 'center' },
        emptyText: {
          marginTop: 12,
          fontSize: TASK_FONT_SIZE_SMALL,
          color: colors.placeholder,
        },
      }),
    [colors]
  );
  return (
    <View style={[s.tabRoot, { paddingTop: headerHeight - 8 }]}>
      <MonthCalendarScroll selectedDate={selectedDate} onSelectDate={onDateChange} />
      <View style={s.divider} />
      <ScrollView
        style={s.tasksScroll}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        {calendarTasks.length === 0 ? (
          <View style={s.empty}>
            <Ionicons name="checkmark-done-outline" size={48} color={colors.placeholder} />
            <Text style={s.emptyText}>当日无任务</Text>
          </View>
        ) : (
          calendarTasks.map((item) => (
            <TaskRow
              key={item.id}
              task={item}
              showProjectName={showProjectName}
              showTimeLabel={showTimeLabels}
              onPress={() => onTaskPress(item.id)}
              onToggleCompletion={() => onToggleCompletion(item)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
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
    mainContent: { flex: 1 },
    headerCircleBtn: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
    topBarCenter: { alignItems: 'center', flex: 1 },
    topBarTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: c.textHeader },
    collabPresenceTopWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      zIndex: 12,
      alignItems: 'center',
      paddingTop: 6,
      paddingBottom: 6,
    },
    refreshIndicatorFixed: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      zIndex: 9,
    },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
    loadingText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted },
    listContent: { paddingBottom: LIST_PADDING_BOTTOM_DEFAULT },
    emptyList: { flex: 1, paddingBottom: LIST_PADDING_BOTTOM_DEFAULT },
    emptyBox: { paddingVertical: 48, alignItems: 'center' },
    emptyText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: c.placeholder },
    emptyHint: {
      marginTop: 6,
      fontSize: 13,
      color: c.placeholder,
      textAlign: 'center',
    },
    tabRoot: { flex: 1 },
    /** topBar.paddingHorizontal=16，HamburgerButton 是圆形 + 阴影，视觉左边沿大致
     *  在 x≈20 处（圆的左边沿 16 + 内边视觉权重）。列表 / 胶囊 tab 取同样的 20
     *  让两者左对齐；右 padding 也对齐右上角圆按钮的右边沿（对称）。 */
    /** ScrollView 自身 flex:1 占固定空间 —— 外层尺寸跟内容长短无关，从根上断掉「内容增减
     *  触发父 layout pass → 上面 folder tabs 行抖动」的链路。 */
    convScrollOuter: { flex: 1 },
    convScrollContent: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 120 },
    convRow: {
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    convRowTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    convRowText: { flex: 1, minWidth: 0, fontSize: 15, color: c.textPrimary, fontWeight: '500' },
    convRowMeta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    /** ScrollView 默认有 flexGrow:1（在 column 父里会把竖向余高吃掉），加 flexGrow:0
     *  让它紧贴内容。不然 tab 行下方会出现一段空白。
     *  显式 height:64 = folderTabsRow 的 paddingVertical(14)*2 + tab minHeight(36)。固定高度
     *  避免下面 conv ScrollView 内容多少触发滚动状态变化时通过 layout pass 影响到 tabs 行
     *  的测量结果（用户报告的「切换 folder/tab 后位置 1-2pt 漂移」）。 */
    folderTabsScroll: { flexGrow: 0, height: 64 },
    /** 胶囊外形带 borderRadius:14，左侧弧度让视觉重心比 box 左沿更靠右一点。
     *  比 convScrollContent (20) 多 4dp 让视觉左沿跟下方对话行对齐。 */
    /** paddingVertical 14：胶囊行跟上面的圆形汉堡按钮纵向多让点呼吸。 */
    folderTabsRow: { paddingHorizontal: 18, paddingVertical: 14, gap: 8, alignItems: 'center' },
    /** 胶囊高度对齐 sheet 里那种 toggle 控件（segmentTrack 高 40dp），
     *  paddingVertical 8 + fontSize 14 → 大概 34-36dp，更好点中。 */
    folderTab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      /* minHeight 强制所有 tab 同高 —— 不设的话 RN ScrollView horizontal + gap +
       * alignItems:center 在某些 case 下会让奇/偶 position 的 tab 高度差 1-2pt（疑似文字
       * ascender/descender 自然高度不同导致 alignSelf 算出不同），强制 minHeight 一致就稳。
       * 36 = paddingVertical(8)*2 + fontSize(14) + 字体行高 ~1.4 余裕。 */
      minHeight: 36,
      borderRadius: 18,
      backgroundColor: c.surfaceMuted,
    },
    folderTabActive: { backgroundColor: c.primary },
    folderTabLabel: { fontSize: 14, color: c.textPrimary, fontWeight: '500' },
    /* active 文字 onPrimary（白），跟 folderTabActive 的 primary bg 对比清楚。
     * iOS 走 iosForceWorklet 路径不用 glass，bg 也是 solid primary，所以跟 Android 一致即可。 */
    folderTabLabelActive: { color: c.onPrimary },
    folderTabCount: { fontSize: 13, color: c.textMuted },
    folderTabCountActive: { color: c.onPrimary, opacity: 0.85 },
    convFolderEmpty: { paddingVertical: 40, alignItems: 'center' },
    convFolderEmptyText: { fontSize: 13, color: c.placeholder },
    bottomBar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'column',
      alignItems: 'stretch',
      /* paddingLeft: 两边分开——iOS NativeTabBar 自带内部 padding，外层给 0 让 UITabBar
         的 floating pill 视觉刚好；Android / iOS<26 自绘 capsule 完全贴屏边会很挤，
         加 12pt 透气。
         paddingRight: 22 两边一样（FAB 在右，逻辑同质）。 */
      paddingLeft: IS_IOS_LIQUID_GLASS ? 0 : 12,
      paddingRight: 22,
      paddingTop: 10,
      gap: 10,
    },
    /* tab + FAB 单行：space-between 把 tab 推到左、FAB 推到右、中间留空。
       alignItems: 'flex-end' —— iOS 26 UITabBar 把 floating pill 锚在 bounds 底部，
       UIButton glass 居中。flex-end 让两个 child 的"视觉底"对齐。
       height: 60 给加大后的 FAB（60pt）留位；UITabBar 还是 52pt 高 bounds，靠 flex-end
       会贴在 row 底部（视觉上 tab pill 跟 FAB 底对齐）。 */
    bottomRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      height: 60,
    },
    /* iOS 26+ native UITabBar：320pt 宽（4 tab × ~80pt 给每 tab 留点透气空间）+ 52pt 高
       （比 FAB 的 60pt 小 8pt，靠 bottomRow.alignItems: 'flex-end' tab 底跟 FAB 底对齐、
       顶部少一截就行）。320 + FAB 60 = 380 < iPhone 17 Pro 内容宽 394，不溢出。 */
    nativeTabs: {
      width: 320,
      height: 52,
    },
    /* iOS < 26 / Android fallback：tabCapsuleFlex 这个样式已经废弃但保留兼容现有
       callsite——传 {} 没副作用。 */
    tabCapsuleFlex: {},
    /* tabCapsule 跟 FAB 直径同高（60pt）；宽度 280（每 tab 70pt）比 iOS NativeTabBar 的
       320 收紧——自绘字体没 iOS native 那种 dynamic type / 字距加宽，相同宽度下视觉更挤，
       所以这里特意收一点让 inter-icon 间距舒服些。iOS 那边宽度走 nativeTabs 不受影响。 */
    tabCapsule: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: 280,
      height: 60,
      paddingHorizontal: TAB_CAPSULE_PADDING,
      backgroundColor: c.surface,
      borderRadius: 999,
      overflow: 'hidden',
      ...shadowCircleButtonThemed(c),
    },
    fab: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.surface,
      justifyContent: 'center',
      alignItems: 'center',
      ...shadowFabThemed(c),
    },
  });
}
