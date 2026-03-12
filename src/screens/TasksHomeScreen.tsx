import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Platform,
} from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import { useSession } from '../context/SessionContext';
import type { TasksStackParamList } from '../navigation/types';
import type { TaskItem, Project } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { TaskFilterSheet, type StatusLevel } from '../components/TaskFilterSheet';
import { ProjectSelectSheet } from '../components/ProjectSelectSheet';
import { shadowCircleButton, shadowFab, shadowSoft, borderLight } from '../theme/shadows';
import { LIST_TOP_EXTRA, LIST_PADDING_BOTTOM_WITH_FOOTER } from '../theme/layout';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { filterTasksByStatusLevel } from '../utils/taskFilters';

const STATUS_KEY = 'statusLevel_todayTasks';
const SHOW_TIME_KEY = 'showTimeLabels_todayTasks';
const SHOW_PROJECT_KEY = 'showProjectName_todayTasks';

type Nav = StackNavigationProp<TasksStackParamList, 'TasksHome'>;

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
    clearError();
    await Promise.all([loadTasks(true), loadProjects(true)]);
    setRefreshing(false);
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
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground style={StyleSheet.absoluteFill} topSolidHeight={insets.top + 8} />
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={onProjectsPress}
          activeOpacity={0.7}
        >
          <Ionicons name="folder-outline" size={24} color="#374151" />
        </TouchableOpacity>
        <View style={styles.topBarCenter}>
          <Text style={styles.todayTitle}>{formatTodayDate(todayDate)}</Text>
          <Text style={styles.todaySubtitle}>今日 {filteredTodayTasks.length} 个任务</Text>
        </View>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={() => setFilterVisible(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="filter-outline" size={22} color="#374151" />
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
              <ActivityIndicator size="large" color="#0f172a" />
              <Text style={styles.loadingText}>加载中...</Text>
            </View>
          </View>
        ) : (
          <DraggableFlatList<TaskItem>
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
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="checkmark-done-outline" size={56} color="#9ca3af" />
                <Text style={styles.emptyText}>今日无任务</Text>
              </View>
            }
            contentContainerStyle={[
              localTaskOrder.length === 0 ? styles.emptyList : styles.listContent,
              { paddingTop: headerHeight + LIST_TOP_EXTRA },
            ]}
          />
        )}
      </View>

      <View style={[styles.footer, Platform.OS === 'ios' && { paddingBottom: 28 }]}>
        {showEndToday ? (
          <TouchableOpacity style={styles.endTodayBtn} onPress={endToday}>
            <Text style={styles.endTodayText}>结束今天</Text>
          </TouchableOpacity>
        ) : null}
        <View style={styles.footerSpacer} />
        <TouchableOpacity style={styles.fab} onPress={onCreateTask}>
          <Ionicons name="add" size={26} color="#0f172a" />
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  placeholderText: { fontSize: 16, color: '#6b7280' },
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
  circleBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    ...shadowCircleButton,
  },
  topBarCenter: { alignItems: 'center', flex: 1 },
  todayTitle: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  todaySubtitle: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  errorBar: { backgroundColor: '#fef2f2', padding: 12 },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6b7280' },
  listContent: { paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
  emptyList: { flex: 1, paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { marginTop: 12, fontSize: 16, color: '#9ca3af' },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  endTodayBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderRadius: 20,
    ...borderLight,
    ...shadowSoft,
  },
  endTodayText: { fontSize: 16, fontWeight: '500', color: '#111827' },
  footerSpacer: { flex: 1 },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    ...borderLight,
    ...shadowFab,
  },
});
