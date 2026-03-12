import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import type { TasksStackParamList } from '../navigation/types';
import type { Project } from '../taskApi';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { HEADER_CIRCLE_BTN_SIZE, LIST_PADDING_BOTTOM_DEFAULT } from '../theme/layout';
import { shadowCircleButton } from '../theme/shadows';
import { TASK_FONT_SIZE_SMALL, TASK_FONT_SIZE_TITLE } from '../theme/typography';

type Nav = StackNavigationProp<TasksStackParamList, 'ProjectList'>;

export function ProjectListScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { projects, loadProjects, loadTasks, isLoadingProjects } = useTask();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadTasks(true), loadProjects(true)]);
    setRefreshing(false);
  }, [loadTasks, loadProjects]);

  const onClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const onProjectPress = useCallback(
    (project: Project) => {
      navigation.navigate('ProjectDetail', {
        projectId: project.id,
        projectName: project.name ?? project.id,
      });
    },
    [navigation]
  );

  const headerHeight = insets.top + 8 + 12 + 44;

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground style={StyleSheet.absoluteFill} topSolidHeight={insets.top + 8} />
        <View style={styles.titleWrap}>
          <Text style={styles.title}>项目</Text>
        </View>
        <TouchableOpacity style={styles.circleBtn} onPress={onClose} activeOpacity={0.7}>
          <Ionicons name="close" size={24} color="#374151" />
        </TouchableOpacity>
      </View>
      <View style={styles.mainContent}>
        {isLoadingProjects && projects.length === 0 ? (
          <View style={[styles.mainContent, { paddingTop: headerHeight }]}>
            <View style={styles.centered}>
              <ActivityIndicator size="large" color="#0f172a" />
              <Text style={styles.loadingText}>加载中...</Text>
            </View>
          </View>
        ) : (
          <FlatList
            data={projects}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.projectRow}
                onPress={() => onProjectPress(item)}
                activeOpacity={0.7}
              >
                <Ionicons name="folder-outline" size={24} color="#374151" />
                <View
                  style={[
                    styles.projectInfo,
                    !item.description && styles.projectInfoCenter,
                  ]}
                >
                  <Text style={styles.projectName} numberOfLines={1}>
                    {item.name ?? item.id}
                  </Text>
                  {item.description ? (
                    <Text style={styles.projectDesc} numberOfLines={1}>
                      {item.description}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
              </TouchableOpacity>
            )}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="folder-open-outline" size={56} color="#9ca3af" />
                <Text style={styles.emptyText}>暂无项目</Text>
              </View>
            }
            contentContainerStyle={[
              projects.length === 0 ? styles.emptyList : styles.listContent,
              { paddingTop: headerHeight },
            ]}
          />
        )}
      </View>
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
  titleWrap: { flex: 1, justifyContent: 'center' },
  title: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: '#0f172a' },
  circleBtn: {
    width: HEADER_CIRCLE_BTN_SIZE,
    height: HEADER_CIRCLE_BTN_SIZE,
    borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    ...shadowCircleButton,
  },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: '#6b7280' },
  listContent: {
    paddingBottom: LIST_PADDING_BOTTOM_DEFAULT,
    paddingHorizontal: 16,
  },
  emptyList: { flex: 1, paddingBottom: LIST_PADDING_BOTTOM_DEFAULT },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: '#9ca3af' },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 76,
    paddingVertical: 18,
    paddingHorizontal: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    gap: 12,
  },
  projectInfo: { flex: 1 },
  projectInfoCenter: { justifyContent: 'center' },
  projectName: { fontSize: 16, fontWeight: '600', color: '#111827' },
  projectDesc: {
    fontSize: TASK_FONT_SIZE_SMALL,
    color: '#6b7280',
    marginTop: 4,
  },
});
