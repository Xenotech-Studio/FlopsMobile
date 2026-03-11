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
        <Text style={styles.title}>项目</Text>
        <TouchableOpacity
          onPress={onClose}
          style={styles.closeBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
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
                <View style={styles.projectInfo}>
                  <Text style={styles.projectName}>{item.name ?? item.id}</Text>
                  {item.description ? (
                    <Text style={styles.projectDesc} numberOfLines={2}>
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
  title: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  closeBtn: { padding: 4 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6b7280' },
  listContent: { paddingBottom: 24 },
  emptyList: { flex: 1, paddingBottom: 24 },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { marginTop: 12, fontSize: 16, color: '#9ca3af' },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    gap: 12,
  },
  projectInfo: { flex: 1 },
  projectName: { fontSize: 16, fontWeight: '600', color: '#111827' },
  projectDesc: { fontSize: 13, color: '#6b7280', marginTop: 2 },
});
