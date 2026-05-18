/**
 * 日历视图：从今日页左下角进入，按日期查看任务（跨项目）
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StackActions } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import type { RootStackParamList } from '../navigation/types';
import type { TaskItem } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { MonthCalendarScroll } from '../components/MonthCalendar';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { shadowCircleButtonThemed } from '../theme/shadows';
import { TASK_FONT_SIZE_SMALL, TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { isTaskBelongToDay } from '../utils/taskFilters';

type Nav = StackNavigationProp<RootStackParamList, 'TasksCalendar'>;

function createTasksCalendarStyles(c: AppColors) {
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
    title: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: c.textHeader },
    calendarArea: { flex: 1 },
    tasksScroll: { flex: 1 },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.conversationListSeparator,
      marginVertical: 8,
    },
    empty: { paddingVertical: 48, alignItems: 'center' },
    emptyText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: c.placeholder },
  });
}

export function TasksCalendarScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createTasksCalendarStyles(colors), [colors]);
  const { tasks, projects, loadTasks, toggleTaskCompletion } = useTask();
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadTasks(true);
    setRefreshing(false);
  }, [loadTasks]);

  const calendarTasks = useMemo(() => {
    const list = tasks.filter((t) => t.type !== 'milestone');
    return list.filter((t) => isTaskBelongToDay(t, selectedDate));
  }, [tasks, selectedDate]);

  const onBack = useCallback(() => {
    navigation.dispatch(StackActions.pop(1));
  }, [navigation]);

  const onTaskPress = useCallback(
    (taskId: string) => {
      navigation.navigate('TaskDetail', { taskId });
    },
    [navigation]
  );

  const headerHeight = insets.top + 8 + 12 + 44;

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        <TouchableOpacity style={styles.circleBtn} onPress={onBack} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.topBarCenter}>
          <Text style={styles.title}>日历</Text>
        </View>
        <View style={styles.circleBtn} />
      </View>
      <View style={[styles.calendarArea, { paddingTop: headerHeight - 8 }]}>
        <MonthCalendarScroll
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />
        <View style={styles.divider} />
        <ScrollView
          style={styles.tasksScroll}
          contentContainerStyle={{ paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {calendarTasks.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="checkmark-done-outline" size={48} color={colors.placeholder} />
              <Text style={styles.emptyText}>当日无任务</Text>
            </View>
          ) : (
            calendarTasks.map((item) => (
              <TaskRow
                key={item.id}
                task={item}
                showProjectName={true}
                showTimeLabel={true}
                projectName={projects.find((p) => p.id === item.project_id)?.name ?? undefined}
                onPress={() => onTaskPress(item.id)}
                onToggleCompletion={() => toggleTaskCompletion(item)}
              />
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}
