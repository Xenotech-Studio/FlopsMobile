import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { StackActions } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import type { TasksStackParamList } from '../navigation/types';
import type { TaskItem, Project, NewTaskPayload } from '../taskApi';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';

type Route = RouteProp<TasksStackParamList, 'TaskDetail'>;

function generateId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function toISO(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function TaskDetailScreen() {
  const { params } = useRoute<Route>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { tasks, projects, toggleTaskCompletion, updateTask, addTask, getAuth, todayDate } = useTask();

  const isCreate = 'projectId' in params && params.projectId != null;
  const projectId = isCreate ? params.projectId! : '';
  const taskId = !isCreate ? (params as { taskId: string }).taskId : '';

  const task = tasks.find((t) => t.id === taskId) ?? null;
  const project = projects.find((p) => p.id === isCreate ? projectId : task?.project_id);

  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState<string>('default');
  const [saving, setSaving] = useState(false);
  const [endDate, setEndDate] = useState<Date | null>(null);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNote(task.note ?? '');
      setPriority(task.priority ?? 'default');
      if (task.enddatetime && task.enddatetime !== '2025-02-28T23:59:59Z') {
        try {
          setEndDate(new Date(task.enddatetime));
        } catch {
          setEndDate(null);
        }
      } else {
        setEndDate(null);
      }
    } else if (isCreate) {
      setTitle('');
      setNote('');
      setPriority('default');
      const d = new Date(todayDate);
      d.setHours(15, 0, 0, 0);
      setEndDate(d);
    }
  }, [task, isCreate, projectId, todayDate]);

  const onSave = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    const t = title.trim();
    if (!t) {
      Alert.alert('提示', '请输入标题');
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const endStr = endDate ? toISO(endDate) : undefined;
        const payload: NewTaskPayload = {
          id: generateId(),
          project_id: projectId,
          title: t,
          type: 'task',
          description: '',
          note: note.trim() || undefined,
          childrenId: [],
          done: false,
          ismine: true,
          relPos: { x: 0, y: 0 },
          startdatetime: undefined,
          enddatetime: endStr ?? null,
          completed_time: undefined,
          icon: null,
          creator: auth.userId,
          priority: priority !== 'default' ? priority : undefined,
          doing: false,
          done_quality: 'reviewing',
          users: [auth.userId],
        };
        await addTask(payload);
        navigation.goBack();
      } else if (task) {
        const updated: TaskItem = {
          ...task,
          title: t,
          note: note.trim() || undefined,
          priority: priority !== 'default' ? priority : null,
          enddatetime: endDate ? toISO(endDate) : task.enddatetime ?? null,
        };
        await updateTask(updated);
        navigation.goBack();
      }
    } catch (e) {
      Alert.alert('保存失败', e instanceof Error ? e.message : '请重试');
    } finally {
      setSaving(false);
    }
  }, [isCreate, title, note, priority, endDate, task, projectId, getAuth, addTask, updateTask, navigation, todayDate]);

  const onToggleDone = useCallback(() => {
    if (task) toggleTaskCompletion(task);
  }, [task, toggleTaskCompletion]);

  const onBack = useCallback(() => {
    navigation.dispatch(StackActions.pop(1));
  }, [navigation]);

  if (!isCreate && !task) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0f172a" />
        <Text style={styles.loadingText}>加载中...</Text>
      </View>
    );
  }

  const priorityOptions = [
    { value: 'now', label: '立即完成', color: '#dc2626' },
    { value: 'default', label: '正常', color: '#6b7280' },
    { value: 'later', label: '不着急', color: '#2563eb' },
  ];

  const headerTitle = isCreate ? '新建任务' : '任务详情';
  const headerHeight = insets.top + 8 + 12 + 44;

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground style={StyleSheet.absoluteFill} topSolidHeight={insets.top + 8} />
        <TouchableOpacity style={styles.circleBtn} onPress={onBack} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color="#374151" />
        </TouchableOpacity>
        <View style={styles.topBarCenter}>
          <Text style={styles.topBarTitle}>{headerTitle}</Text>
        </View>
        <View style={styles.circleBtn}>
          <Ionicons name="ellipsis-horizontal" size={22} color="#374151" />
        </View>
      </View>
      <View style={styles.mainContent}>
      <KeyboardAvoidingView
        style={styles.keyboardWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingTop: headerHeight }]}
        keyboardShouldPersistTaps="handled"
      >
        {task ? (
          <TouchableOpacity style={styles.doneRow} onPress={onToggleDone}>
            <View style={[styles.doneCheck, task.done && styles.doneCheckDone]}>
              {task.done ? <Ionicons name="checkmark" size={20} color="#fff" /> : null}
            </View>
            <Text style={[styles.doneLabel, task.done && styles.doneLabelDone]}>
              {task.done ? '已完成' : '标记完成'}
            </Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.field}>
          <Text style={styles.label}>标题</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="任务标题"
            placeholderTextColor="#9ca3af"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>备注</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={note}
            onChangeText={setNote}
            placeholder="可选"
            placeholderTextColor="#9ca3af"
            multiline
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>优先级</Text>
          <View style={styles.priorityRow}>
            {priorityOptions.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.priorityBtn,
                  priority === opt.value && { borderColor: opt.color, backgroundColor: `${opt.color}15` },
                ]}
                onPress={() => setPriority(opt.value)}
              >
                <Text style={[styles.priorityBtnText, { color: opt.color }]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {endDate != null ? (
          <View style={styles.field}>
            <Text style={styles.label}>截止时间</Text>
            <Text style={styles.dateText}>
              {endDate.getMonth() + 1}月{endDate.getDate()}日 {endDate.getHours()}:{String(endDate.getMinutes()).padStart(2, '0')}
            </Text>
            <TouchableOpacity
              style={styles.dateBtn}
              onPress={() => {
                const d = new Date(endDate);
                d.setHours(d.getHours() + 1);
                setEndDate(d);
              }}
            >
              <Text style={styles.dateBtnText}>+1 小时</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={onSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>{isCreate ? '创建' : '保存'}</Text>
          )}
        </TouchableOpacity>

      </ScrollView>
    </KeyboardAvoidingView>
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
  topBarTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  keyboardWrap: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6b7280' },
  doneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 16,
    gap: 12,
  },
  doneCheck: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e5e7eb',
    justifyContent: 'center',
    alignItems: 'center',
  },
  doneCheckDone: { backgroundColor: '#22c55e' },
  doneLabel: { fontSize: 16, color: '#111827', fontWeight: '500' },
  doneLabelDone: { color: '#6b7280', textDecorationLine: 'line-through' },
  field: { marginBottom: 20 },
  label: { fontSize: 13, color: '#6b7280', marginBottom: 8, fontWeight: '500' },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111827',
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  priorityRow: { flexDirection: 'row', gap: 10 },
  priorityBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  priorityBtnText: { fontSize: 14, fontWeight: '600' },
  dateText: { fontSize: 16, color: '#111827', marginBottom: 8 },
  dateBtn: { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 12 },
  dateBtnText: { fontSize: 14, color: '#2563eb', fontWeight: '500' },
  saveBtn: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.7 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
