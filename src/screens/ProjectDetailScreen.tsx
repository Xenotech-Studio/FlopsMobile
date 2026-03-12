import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { StackActions } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import type { TasksStackParamList } from '../navigation/types';
import type { TaskItem } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { TaskFilterSheet, type StatusLevel } from '../components/TaskFilterSheet';
import { shadowCircleButton, shadowFab, borderLight } from '../theme/shadows';
import { LIST_TOP_EXTRA, LIST_PADDING_BOTTOM_DEFAULT } from '../theme/layout';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { MonthCalendarScroll } from '../components/MonthCalendar';
import {
  filterTasksByStatusLevel,
  filterTasksByShowOnlyMine,
  isTaskBelongToDay,
} from '../utils/taskFilters';

const SHOW_TIME_KEY = 'showTimeLabels_projectDetail';
const SHOW_PROJECT_KEY = 'showProjectName_projectDetail';

type Tab = 'list' | 'calendar' | 'flow';
type Route = RouteProp<TasksStackParamList, 'ProjectDetail'>;

function TabBtn({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[tabBtnStyles.btn, active && tabBtnStyles.btnActive]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons
        name={icon as any}
        size={14}
        color={active ? '#fff' : '#111827'}
      />
      <Text style={[tabBtnStyles.label, active && tabBtnStyles.labelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const tabBtnStyles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 22,
  },
  btnActive: { backgroundColor: '#3b82f6' },
  label: { fontSize: 12, fontWeight: '600', color: '#111827' },
  labelActive: { color: '#fff' },
});

function ProjectCalendarTab({
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
}) {
  return (
    <View style={[calendarTabStyles.tabRoot, { paddingTop: headerHeight - 8 }]}>
      <MonthCalendarScroll
        selectedDate={selectedDate}
        onSelectDate={onDateChange}
      />
      <View style={calendarTabStyles.divider} />
      <ScrollView
        style={calendarTabStyles.tasksScroll}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
      {calendarTasks.length === 0 ? (
        <View style={calendarTabStyles.empty}>
          <Ionicons name="checkmark-done-outline" size={48} color="#9ca3af" />
          <Text style={calendarTabStyles.emptyText}>当日无任务</Text>
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

const calendarTabStyles = StyleSheet.create({
  tabRoot: { flex: 1 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#e5e7eb', marginVertical: 8 },
  tasksScroll: { flex: 1 },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { marginTop: 12, fontSize: 16, color: '#9ca3af' },
});

export function ProjectDetailScreen() {
  const { params } = useRoute<Route>();
  const navigation = useNavigation<StackNavigationProp<TasksStackParamList, 'ProjectDetail'>>();
  const { projectId, projectName } = params;
  const {
    tasks,
    projects,
    loadTasks,
    loadProjects,
    toggleTaskCompletion,
    isLoadingTasks,
  } = useTask();

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.project_id === projectId),
    [tasks, projectId]
  );
  const project = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );

  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [filterVisible, setFilterVisible] = useState(false);
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const [statusLevel, setStatusLevel] = useState<StatusLevel>(1);
  const [showTimeLabels, setShowTimeLabels] = useState(false);
  const [showProjectName, setShowProjectName] = useState(false);

  const statusKey = useMemo(() => `statusLevel_project_${projectId}`, [projectId]);
  const statusLevelCalendarKey = useMemo(
    () => `statusLevelCalendar_project_${projectId}`,
    [projectId]
  );

  const [tab, setTab] = useState<Tab>('list');
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [showOnlyMineCalendar, setShowOnlyMineCalendar] = useState(false);
  const [statusLevelCalendar, setStatusLevelCalendar] = useState<StatusLevel>(3);

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
        if (s !== null) {
          const v = parseInt(s, 10);
          if (v >= 0 && v <= 3) setStatusLevel(v as StatusLevel);
        }
        if (t !== null) setShowTimeLabels(t === 'true');
        if (p !== null) setShowProjectName(p === 'true');
        if (sc !== null) {
          const v = parseInt(sc, 10);
          if (v >= 0 && v <= 3) setStatusLevelCalendar(v as StatusLevel);
        }
      } catch {
        // ignore
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

  const onBack = useCallback(() => {
    navigation.dispatch(StackActions.pop(1));
  }, [navigation]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadTasks(true), loadProjects(true)]);
    setRefreshing(false);
  }, [loadTasks, loadProjects]);

  const onTaskPress = useCallback(
    (taskId: string) => {
      navigation.navigate('TaskDetail', { taskId });
    },
    [navigation]
  );

  const onCreateTask = useCallback(() => {
    navigation.navigate('TaskDetail', {
      projectId,
      projectName: params.projectName ?? project?.name ?? undefined,
    });
  }, [navigation, projectId, params.projectName, project?.name]);

  const title = params.projectName ?? project?.name ?? projectId;
  const headerHeight = insets.top + 8 + 12 + 44;

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground style={StyleSheet.absoluteFill} topSolidHeight={insets.top + 8} />
        <TouchableOpacity style={styles.circleBtn} onPress={onBack} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color="#374151" />
        </TouchableOpacity>
        <View style={styles.topBarCenter}>
          <Text style={styles.topBarTitle} numberOfLines={1}>{title}</Text>
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
        {tab === 'list' && (
          <>
            {isLoadingTasks && projectTasks.length === 0 ? (
              <View style={[styles.mainContent, { paddingTop: headerHeight }]}>
                <View style={styles.centered}>
                  <ActivityIndicator size="large" color="#0f172a" />
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
                refreshControl={
                  <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
                }
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Ionicons name="checkbox-outline" size={56} color="#9ca3af" />
                    <Text style={styles.emptyText}>该项目暂无任务</Text>
                  </View>
                }
                contentContainerStyle={[
                  filteredProjectTasks.length === 0 ? styles.emptyList : styles.listContent,
                  { paddingTop: headerHeight + LIST_TOP_EXTRA, paddingBottom: 100 },
                ]}
              />
            )}
          </>
        )}
        {tab === 'calendar' && (
          <ProjectCalendarTab
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
          />
        )}
        {tab === 'flow' && (
          <View style={[styles.flowPlaceholder, { paddingTop: headerHeight }]}>
            <Ionicons name="git-network-outline" size={56} color="#9ca3af" />
            <Text style={styles.flowPlaceholderText}>FlowChart 暂不支持</Text>
          </View>
        )}
      </View>
      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
        <View style={styles.tabCapsule}>
          <TabBtn label="列表" icon="list" active={tab === 'list'} onPress={() => setTab('list')} />
          <TabBtn label="日历" icon="calendar" active={tab === 'calendar'} onPress={() => setTab('calendar')} />
          <TabBtn label="Flow" icon="git-network-outline" active={tab === 'flow'} onPress={() => setTab('flow')} />
        </View>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={styles.fab} onPress={onCreateTask}>
          <Ionicons name="add" size={26} color="#0f172a" />
        </TouchableOpacity>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
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
  topBarTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6b7280' },
  listContent: { paddingBottom: LIST_PADDING_BOTTOM_DEFAULT },
  emptyList: { flex: 1, paddingBottom: LIST_PADDING_BOTTOM_DEFAULT },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { marginTop: 12, fontSize: 16, color: '#9ca3af' },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 24,
  },
  tabCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderRadius: 28,
    ...borderLight,
    ...shadowCircleButton,
  },
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
  flowPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  flowPlaceholderText: { marginTop: 12, fontSize: 16, color: '#9ca3af' },
});
