import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import { useSession } from '../context/SessionContext';
import type { TasksStackParamList } from '../navigation/types';
import type { TaskItem, Project } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { TaskFilterSheet } from '../components/TaskFilterSheet';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';

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
  } = useTask();

  const [refreshing, setRefreshing] = useState(false);
  const [filterVisible, setFilterVisible] = useState(false);

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
    const first = projects[0];
    navigation.navigate('TaskDetail', {
      projectId: first.id,
      projectName: first.name ?? first.id,
    });
  }, [navigation, projects]);

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
          <Text style={styles.todaySubtitle}>今日 {todayTasks.length} 个任务</Text>
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
          <FlatList
            data={todayTasks}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TaskRow
                task={item}
                showProjectName
                projectName={projects.find((p) => p.id === item.project_id)?.name ?? undefined}
                onPress={() => onTaskPress(item)}
                onToggleCompletion={() => toggleTaskCompletion(item)}
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
              todayTasks.length === 0 ? styles.emptyList : styles.listContent,
              { paddingTop: headerHeight },
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

      <TaskFilterSheet
        visible={filterVisible}
        onClose={() => setFilterVisible(false)}
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  topBarCenter: { alignItems: 'center', flex: 1 },
  todayTitle: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  todaySubtitle: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  errorBar: { backgroundColor: '#fef2f2', padding: 12 },
  errorText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6b7280' },
  listContent: { paddingBottom: 100 },
  emptyList: { flex: 1, paddingBottom: 100 },
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
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    ...Platform.select({ ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.12, shadowRadius: 2 }, android: { elevation: 2 } }),
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
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    ...Platform.select({ ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.12, shadowRadius: 2 }, android: { elevation: 2 } }),
  },
});
