import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Platform,
  Vibration,
  BackHandler,
} from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import Animated, { useSharedValue, runOnJS, runOnUI } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import DraggableFlatList from 'react-native-draggable-flatlist';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import { useSession } from '../context/SessionContext';
import type { TasksStackParamList } from '../navigation/types';
import type { TaskItem, Project } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { TaskFilterSheet, type StatusLevel } from '../components/TaskFilterSheet';
import { ProjectSelectSheet } from '../components/ProjectSelectSheet';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { shadowCircleButtonThemed, shadowFabThemed, shadowSoft } from '../theme/shadows';
import { HEADER_CIRCLE_BTN_SIZE, LIST_TOP_EXTRA, LIST_PADDING_BOTTOM_WITH_FOOTER } from '../theme/layout';
import { TASK_FONT_SIZE_SMALL, TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { SystemGestureExclusionView } from '../components/SystemGestureExclusionView';
import { PullToRefreshRing } from '../components/PullToRefreshRing';
import { filterTasksByStatusLevel } from '../utils/taskFilters';

const EDGE_WIDTH = 24;
/** Android 加宽 + SystemGestureExclusionView，与对话列表左缘开 Profile 一致 */
const LEFT_EDGE_STRIP_WIDTH = Platform.OS === 'android' ? 56 : EDGE_WIDTH;
const PULL_RING_THRESHOLD = 120;
const MIN_REFRESH_DURATION_MS = 1000;
const SWIPE_THRESHOLD = 60;
const STATUS_KEY = 'statusLevel_todayTasks';
const SHOW_TIME_KEY = 'showTimeLabels_todayTasks';
const SHOW_PROJECT_KEY = 'showProjectName_todayTasks';

type Nav = StackNavigationProp<TasksStackParamList, 'TasksHome'>;

function createTasksHomeStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
    leftEdgeGesture: {
      position: 'absolute',
      left: 0,
      bottom: 0,
      zIndex: 30,
      ...(Platform.OS === 'android' ? { elevation: 24 } : null),
    },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    placeholderText: { fontSize: 16, color: c.textMuted },
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
    list: { flex: 1 },
    circleBtn: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
    topBarCenter: { alignItems: 'center', flex: 1 },
    refreshIndicatorFixed: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      zIndex: 9,
    },
    todayTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: c.textHeader },
    todaySubtitle: { fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted, marginTop: 4 },
    errorBar: { backgroundColor: c.errorBg, padding: 12 },
    errorText: { fontSize: 14, color: c.danger, textAlign: 'center' },
    loadingText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted },
    listContent: { paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
    emptyList: { flex: 1, paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
    empty: { paddingVertical: 48, alignItems: 'center' },
    emptyText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: c.placeholder },
    footer: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      zIndex: 40,
      ...(Platform.OS === 'android' ? { elevation: 26 } : null),
    },
    calendarBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderRadius: Platform.OS === 'android' ? 999 : 22,
      marginLeft: 12,
      marginBottom: 8,
      ...Platform.select({
        ios: {
          ...shadowSoft,
          borderWidth: 1,
          borderColor: c.androidCircleFabHairline,
        },
        android: {
          borderWidth: 1,
          borderColor: c.androidCircleFabHairline,
          elevation: 0,
        },
      }),
    },
    calendarBtnText: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    endTodayBtn: {
      paddingHorizontal: 20,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderRadius: 20,
      ...Platform.select({
        ios: {
          ...shadowSoft,
          borderWidth: 1,
          borderColor: c.androidCircleFabHairline,
        },
        android: {
          borderWidth: 1,
          borderColor: c.androidCircleFabHairline,
          elevation: 0,
        },
      }),
    },
    endTodayText: { fontSize: 16, fontWeight: '500', color: c.textPrimary },
    footerSpacer: { flex: 1 },
    fab: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: c.surface,
      justifyContent: 'center',
      alignItems: 'center',
      ...shadowFabThemed(c),
    },
  });
}

function formatTodayDate(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const min = d.getMinutes();
  return `${m}月${day}日 ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function TasksHomeScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createTasksHomeStyles(colors), [colors]);
  const { session } = useSession();
  const {
    todayTasks,
    todayDate,
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

  const [refreshing, setRefreshing] = useState(false);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullDistanceShared = useSharedValue(0);
  const refreshingShared = useSharedValue(false);

  React.useEffect(() => {
    refreshingShared.value = refreshing;
  }, [refreshing, refreshingShared]);

  React.useEffect(() => () => {
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
  }, []);

  const [filterVisible, setFilterVisible] = useState(false);
  const [showProjectSelect, setShowProjectSelect] = useState(false);
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
        if (s !== null) {
          const v = parseInt(s, 10);
          if (v >= 0 && v <= 3) setStatusLevel(v as StatusLevel);
        }
        if (t !== null) setShowTimeLabels(t === 'true');
        if (p !== null) setShowProjectName(p === 'true');
      } catch {
        // ignore
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
      await Promise.all([loadTasks(true), loadProjects(true)]);
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
  }, [loadTasks, loadProjects, clearError]);

  useEffect(() => {
    if (session) {
      loadTasks(true);
      loadProjects(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const onTaskPress = useCallback(
    (task: TaskItem) => {
      navigation.navigate('TaskDetail', { taskId: task.id });
    },
    [navigation]
  );

  const onProjectsPress = useCallback(() => {
    navigation.navigate('ProjectList');
  }, [navigation]);

  /**
   * Android：边缘返回与左缘右滑目标一致时走 BackHandler，避免根栈直接 finish。
   */
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        onProjectsPress();
        return true;
      });
      return () => sub.remove();
    }, [onProjectsPress])
  );

  const leftEdgeOpenProjectListGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(10)
        .failOffsetY([-24, 24])
        .onEnd((e) => {
          'worklet';
          if (e.translationX > SWIPE_THRESHOLD) {
            runOnJS(onProjectsPress)();
          }
        }),
    [onProjectsPress]
  );

  const onCreateTask = useCallback(() => {
    if (projects.length === 0) return;
    setShowProjectSelect(true);
  }, [projects]);

  const onSelectProjectForCreate = useCallback(
    (project: Project) => {
      setShowProjectSelect(false);
      navigation.navigate('TaskDetail', {
        projectId: project.id,
        projectName: project.name ?? project.id,
      });
    },
    [navigation]
  );

  const onCalendarPress = useCallback(() => {
    navigation.navigate('TasksCalendar');
  }, [navigation]);

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

  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.placeholderText}>请先登录</Text>
      </View>
    );
  }

  const showEndToday = shouldShowEndTodayButton();
  const loading = isLoadingTasks && todayTasks.length === 0;
  const headerHeight = insets.top + 8 + 12 + 44;

  return (
    <View style={styles.container}>
      {/* 顶部栏：毛玻璃 + 渐变，绝对定位；列表内容在其下滚动 */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={onProjectsPress}
          activeOpacity={0.7}
        >
          <Ionicons name="folder-outline" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.topBarCenter} pointerEvents="none">
          <Text style={styles.todayTitle}>{formatTodayDate(todayDate)}</Text>
          <Text style={styles.todaySubtitle}>今日 {filteredTodayTasks.length} 个任务</Text>
        </View>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={() => setFilterVisible(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="filter-outline" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.mainContent}>
        {errorMessage ? (
          <View style={[styles.errorBar, { marginTop: headerHeight }]}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {loading ? (
          <View style={[styles.mainContent, { paddingTop: headerHeight }]}>
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>加载中...</Text>
            </View>
          </View>
        ) : (
          <View style={styles.list}>
            <DraggableFlatList<TaskItem>
            containerStyle={styles.list}
            data={localTaskOrder}
            keyExtractor={(item) => item.id}
            onDragEnd={({ data }) => setLocalTaskOrder(data)}
            renderItem={({ item, drag }) => (
              <TaskRow
                task={item}
                showProjectName={showProjectName}
                showTimeLabel={showTimeLabels}
                projectName={projects.find((p) => p.id === item.project_id)?.name ?? undefined}
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
                progressViewOffset={Platform.OS === 'android' ? headerHeight + LIST_TOP_EXTRA : undefined}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="checkmark-done-outline" size={56} color={colors.placeholder} />
                <Text style={styles.emptyText}>今日无任务</Text>
              </View>
            }
            contentContainerStyle={[
              localTaskOrder.length === 0 ? styles.emptyList : styles.listContent,
              { paddingTop: headerHeight + LIST_TOP_EXTRA },
            ]}
            />
          </View>
        )}
      </View>

      {Platform.OS === 'ios' ? (
        <View style={[styles.refreshIndicatorFixed, { top: headerHeight }]} pointerEvents="none">
          <PullToRefreshRing
            pullDistance={pullDistanceShared}
            refreshing={refreshingShared}
            threshold={PULL_RING_THRESHOLD}
            refreshingState={refreshing}
            color={colors.primary}
          />
        </View>
      ) : null}

      <View style={[styles.footer, Platform.OS === 'ios' && { paddingBottom: 28 }]}>
        <TouchableOpacity style={styles.calendarBtn} onPress={onCalendarPress} activeOpacity={0.7}>
          <Ionicons name="calendar-outline" size={20} color={colors.textPrimary} />
          <Text style={styles.calendarBtnText}>日历</Text>
        </TouchableOpacity>
        {showEndToday ? (
          <TouchableOpacity style={styles.endTodayBtn} onPress={endToday}>
            <Text style={styles.endTodayText}>结束今天</Text>
          </TouchableOpacity>
        ) : null}
        <View style={styles.footerSpacer} />
        <TouchableOpacity style={styles.fab} onPress={onCreateTask}>
          <Ionicons name="add" size={26} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <ProjectSelectSheet
        visible={showProjectSelect}
        onClose={() => setShowProjectSelect(false)}
        projects={projects}
        onSelectProject={onSelectProjectForCreate}
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
      <GestureDetector gesture={leftEdgeOpenProjectListGesture}>
        <SystemGestureExclusionView
          style={[styles.leftEdgeGesture, { width: LEFT_EDGE_STRIP_WIDTH, top: headerHeight }]}
          pointerEvents="box-only"
          collapsable={false}
        />
      </GestureDetector>
    </View>
  );
}
