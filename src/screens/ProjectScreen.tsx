/**
 * ProjectScreen —— 抽屉里某个 project 条目对应的顶层页（替代旧 ProjectDetailScreen）。
 *
 * 与旧版相比：
 *  - 左上角"返回"圆钮 → 改为汉堡按钮（开抽屉）。本页是顶层，不需要 goBack。
 *  - 底部 floating capsule tab 从 3 项扩到 4 项：Chats / Tasks / Calendar / FlowChart。
 *  - Chats tab：目前后端 ConversationListItem 不带 project_id，临时显示"项目对话即将推出"的占位。
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
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
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
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Tab = 'chats' | 'tasks' | 'calendar' | 'flow';

const SHOW_TIME_KEY = 'showTimeLabels_projectDetail';
const SHOW_PROJECT_KEY = 'showProjectName_projectDetail';
const PULL_RING_THRESHOLD = 120;
const MIN_REFRESH_DURATION_MS = 1000;
const TAB_CAPSULE_PADDING = 6;
const TAB_PADDING_X = 12;
const TAB_PADDING_Y = 3;
const TAB_ACTIVE_ANIM_DURATION = 200;

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
  const [tab, setTab] = useState<Tab>('tasks');
  const [selectedDate, setSelectedDate] = useState(() => new Date());

  const [filterVisible, setFilterVisible] = useState(false);
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const [statusLevel, setStatusLevel] = useState<StatusLevel>(1);
  const [showTimeLabels, setShowTimeLabels] = useState(false);
  const [showProjectName, setShowProjectName] = useState(false);
  const [showOnlyMineCalendar, setShowOnlyMineCalendar] = useState(false);
  const [statusLevelCalendar, setStatusLevelCalendar] = useState<StatusLevel>(3);

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
        <TouchableOpacity
          style={styles.headerCircleBtn}
          onPress={() => setFilterVisible(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="filter-outline" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
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
              <View style={styles.centered}>
                <Ionicons
                  name="chatbubbles-outline"
                  size={56}
                  color={colors.placeholder}
                />
                <Text style={styles.emptyText}>项目对话即将推出</Text>
                <Text style={styles.emptyHint}>
                  当前对话与项目尚未关联；
                  {'\n'}请到「今天」页查看全部对话
                </Text>
              </View>
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

      {/* 底部 floating capsule tab + 新建 FAB */}
      <View
        style={[
          styles.bottomBar,
          { paddingBottom: Math.max(insets.bottom, 12) + 4 },
        ]}
      >
        <View style={styles.bottomBarRow}>
          <View style={styles.tabCapsule}>
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
          <View style={{ flex: 1 }} />
          <TouchableOpacity style={styles.fab} onPress={onCreateTask}>
            <Ionicons name="add" size={26} color={colors.primary} />
          </TouchableOpacity>
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
  const activeBg = colors.userBubble;
  const activeFg = colors.onUserBubble;
  const inactiveFg = colors.textMuted;

  const v = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    v.value = withTiming(active ? 1 : 0, { duration: TAB_ACTIVE_ANIM_DURATION });
  }, [active, v]);

  const bgStyle = useAnimatedStyle(() => ({ opacity: v.value }));

  return (
    <TouchableOpacity
      style={[
        tabStyles.btn,
        {
          paddingLeft: TAB_PADDING_X + TAB_PADDING_Y,
          paddingRight: TAB_PADDING_X + TAB_PADDING_Y,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Animated.View
        style={[tabStyles.btnBg, bgStyle, { backgroundColor: activeBg }]}
        pointerEvents="none"
      />
      <View style={tabStyles.btnContent}>
        <Ionicons
          name={icon as never}
          size={14}
          color={active ? activeFg : inactiveFg}
        />
        <Text style={[tabStyles.label, { color: active ? activeFg : inactiveFg }]}>
          {label}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const tabStyles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 18 - TAB_CAPSULE_PADDING,
    borderRadius: 999,
    overflow: 'hidden',
  },
  btnBg: { ...StyleSheet.absoluteFillObject, borderRadius: 999 },
  btnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    zIndex: 1,
  },
  label: { fontSize: TASK_FONT_SIZE_SMALL, fontWeight: '600' },
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
    bottomBar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'column',
      alignItems: 'stretch',
    },
    bottomBarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      gap: 12,
    },
    tabCapsule: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      height: 52,
      paddingHorizontal: TAB_CAPSULE_PADDING,
      backgroundColor: c.surface,
      borderRadius: 999,
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
