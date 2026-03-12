/**
 * 任务详情 / 新建任务：1:1 对齐 FlowTaskIOS TaskDetailView
 * - 简洁模式（默认）：标题 + 状态图标（点击展开/收起元数据）+ 元数据摘要 + 备注
 * - 完整模式：状态 Toggle、优先级/完成程度、类型、时间、备注
 * - 自动保存（编辑模式防抖 1 秒）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Modal,
  Dimensions,
  Animated,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { StackActions } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTask } from '../context/TaskContext';
import type { TasksStackParamList } from '../navigation/types';
import type { TaskItem, Project, NewTaskPayload } from '../taskApi';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { IOSStyleSwitch } from '../components/IOSStyleSwitch';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { shadowCircleButton, shadowCard } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL, TASK_FONT_SIZE_TITLE } from '../theme/typography';

type Route = RouteProp<TasksStackParamList, 'TaskDetail'>;

function generateId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function toISO(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 与 iOS taskColor 一致 */
function getTaskColor(opts: {
  type: string;
  done: boolean;
  doing: boolean;
  priority: string;
  done_quality: string;
}): string {
  const { type, done, doing, priority, done_quality: dq } = opts;
  if (type === 'milestone') return done ? '#b8e0b8' : '#adadad';
  if (type === 'delegation') {
    if (done) {
      if (dq === 'wasted') return '#f5b033';
      return dq === 'reviewing' ? '#22c55e' : '#8fec8f';
    }
    return '#9466f5';
  }
  if (done) {
    if (dq === 'wasted') return '#f5b033';
    return dq === 'reviewing' ? '#22c55e' : '#8fec8f';
  }
  if (priority === 'now') return '#fa5a17';
  if (priority === 'later') return '#6b7280';
  return '#d98f33';
}

/** 标题输入框写死行高，用行数 × 此行高得到高度，与 TASK_FONT_SIZE_TITLE 匹配 */
const TITLE_LINE_HEIGHT = 26;

/** 备注区正文行高，与 fontSize 17 一致；展开 meta 时最少 3 行、折叠时最少 5 行 */
const NOTE_LINE_HEIGHT = 24;
const NOTE_MIN_LINES_EXPANDED = 3;
const NOTE_MIN_LINES_COLLAPSED = 5;

/** 时间折叠行用：MM-dd HH:mm */
function formatDateTimeShort(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
}

/** 时间卡片内药丸用：Nov 26, 2025 / 23:59 */
function formatDatePill(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatTimePill(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

function formatCompletedTime(iso: string): string {
  try {
    const d = new Date(iso);
    return formatDateTimeShort(d);
  } catch {
    return iso;
  }
}

const PRIORITY_OPTIONS = [
  { value: 'later', label: '不着急' },
  { value: 'default', label: '正常' },
  { value: 'now', label: '立即完成' },
];

const DONE_QUALITY_OPTIONS = [
  { value: 'reviewing', label: '有待测试' },
  { value: 'done', label: '完成' },
  { value: 'wasted', label: '浪费' },
];

const TYPE_OPTIONS = [
  { value: 'task', label: '任务' },
  { value: 'milestone', label: '里程碑' },
  { value: 'delegation', label: '委托' },
];

export function TaskDetailScreen() {
  const { params } = useRoute<Route>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { tasks, projects, updateTask, addTask, getAuth, todayDate } = useTask();

  const isCreate = 'projectId' in params && params.projectId != null;
  const projectId = isCreate ? params.projectId! : '';
  const taskId = !isCreate ? (params as { taskId: string }).taskId : '';

  const task = tasks.find((t) => t.id === taskId) ?? null;
  const project = projects.find((p) => p.id === (isCreate ? projectId : task?.project_id));

  const [editedTitle, setEditedTitle] = useState('');
  const [editedNote, setEditedNote] = useState('');
  const [editedDoing, setEditedDoing] = useState(false);
  const [editedDone, setEditedDone] = useState(false);
  const [editedPriority, setEditedPriority] = useState('default');
  const [editedType, setEditedType] = useState('task');
  const [editedDoneQuality, setEditedDoneQuality] = useState('reviewing');
  const [editedEndDateTime, setEditedEndDateTime] = useState<Date | null>(null);
  const [editedStartDateTime, setEditedStartDateTime] = useState<Date | null>(null);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showDateTimeEditor, setShowDateTimeEditor] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 标题行数：由隐藏 Text 的 onTextLayout 得到，用于单行/多行下边距（TextInput 本身不提供行数） */
  const [titleLineCount, setTitleLineCount] = useState(1);
  /** 当前打开的日期/时间选择器；iOS 含 layout 用于相对胶囊定位 */
  const [timePicker, setTimePicker] = useState<{
    field: 'start' | 'end';
    mode: 'date' | 'time';
    layout?: { x: number; y: number; width: number; height: number };
  } | null>(null);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleMarginTopAnim = useRef(new Animated.Value(-2)).current;
  const titleHeightAnim = useRef(new Animated.Value(TITLE_LINE_HEIGHT)).current;

  const startDatePillRef = useRef<View>(null);
  const startTimePillRef = useRef<View>(null);
  const endDatePillRef = useRef<View>(null);
  const endTimePillRef = useRef<View>(null);

  const openTimePicker = useCallback(
    (field: 'start' | 'end', mode: 'date' | 'time') => {
      if (Platform.OS !== 'ios') {
        setTimePicker({ field, mode });
        return;
      }
      const ref =
        field === 'start'
          ? mode === 'date'
            ? startDatePillRef
            : startTimePillRef
          : mode === 'date'
            ? endDatePillRef
            : endTimePillRef;
      ref.current?.measureInWindow((x, y, width, height) => {
        setTimePicker({ field, mode, layout: { x, y, width, height } });
      });
    },
    []
  );

  /** 把新选的日期合并进原 Date（保留原时间） */
  const mergeDateInto = useCallback((base: Date, newDate: Date) => {
    const d = new Date(base);
    d.setFullYear(newDate.getFullYear(), newDate.getMonth(), newDate.getDate());
    return d;
  }, []);
  /** 把新选的时间合并进原 Date（保留原日期） */
  const mergeTimeInto = useCallback((base: Date, newTime: Date) => {
    const d = new Date(base);
    d.setHours(newTime.getHours(), newTime.getMinutes(), newTime.getSeconds(), newTime.getMilliseconds());
    return d;
  }, []);

  useEffect(() => {
    setTitleLineCount(1);
    titleMarginTopAnim.setValue(-2);
    titleHeightAnim.setValue(TITLE_LINE_HEIGHT);
    if (task) {
      setEditedTitle(task.title);
      setEditedNote((task.note ?? '').trim());
      setEditedDoing(task.doing ?? false);
      setEditedDone(task.done);
      setEditedPriority(task.priority ?? 'default');
      setEditedType(task.type);
      setEditedDoneQuality(task.done_quality ?? 'reviewing');
      if (task.enddatetime && task.enddatetime !== '2025-02-28T23:59:59Z') {
        try {
          setEditedEndDateTime(new Date(task.enddatetime));
        } catch {
          setEditedEndDateTime(null);
        }
      } else {
        setEditedEndDateTime(null);
      }
      if (task.startdatetime && task.startdatetime !== '2025-02-28T00:00:00Z') {
        try {
          setEditedStartDateTime(new Date(task.startdatetime));
        } catch {
          setEditedStartDateTime(null);
        }
      } else {
        setEditedStartDateTime(null);
      }
    } else if (isCreate) {
      setEditedTitle('');
      setEditedNote('');
      setEditedDoing(false);
      setEditedDone(false);
      setEditedPriority('default');
      setEditedType('task');
      setEditedDoneQuality('reviewing');
      setEditedStartDateTime(null);
      const d = new Date(todayDate);
      d.setHours(23, 59, 0, 0);
      setEditedEndDateTime(d);
    }
  }, [task?.id, isCreate, projectId, todayDate]);

  useEffect(() => {
    const marginTarget = titleLineCount <= 1 ? -1 : -3;
    const heightTarget = titleLineCount * TITLE_LINE_HEIGHT;
    Animated.parallel([
      Animated.timing(titleMarginTopAnim, {
        toValue: marginTarget,
        delay: 0,
        duration: 0,
        useNativeDriver: false,
      }),
      Animated.timing(titleHeightAnim, {
        toValue: heightTarget,
        delay: 0,
        duration: 0,
        useNativeDriver: false,
      }),
    ]).start();
  }, [titleLineCount, titleMarginTopAnim, titleHeightAnim]);

  const taskColor = getTaskColor({
    type: editedType,
    done: editedDone,
    doing: editedDoing,
    priority: editedPriority,
    done_quality: editedDoneQuality,
  });

  const triggerAutoSave = useCallback(() => {
    if (isCreate || !task) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = null;
      const updated: TaskItem = {
        ...task,
        description: '', // 忽略该字段，仅兼容接口
        title: editedTitle.trim(),
        note: editedNote.trim() || undefined,
        doing: editedDoing,
        done: editedDone,
        priority: editedPriority !== 'default' ? editedPriority : null,
        type: editedType,
        done_quality: editedDoneQuality,
        enddatetime: editedEndDateTime ? toISO(editedEndDateTime) : null,
        startdatetime: editedStartDateTime ? toISO(editedStartDateTime) : null,
        completed_time:
          editedDone && !task.completed_time
            ? toISO(new Date())
            : editedDone
              ? task.completed_time ?? undefined
              : undefined,
      };
      if (!editedDone) (updated as TaskItem).completed_time = undefined;
      setSaving(true);
      try {
        await updateTask(updated);
      } catch (e) {
        Alert.alert('保存失败', e instanceof Error ? e.message : '请重试');
      } finally {
        setSaving(false);
      }
    }, 1000);
  }, [
    isCreate,
    task,
    editedTitle,
    editedNote,
    editedDoing,
    editedDone,
    editedPriority,
    editedType,
    editedDoneQuality,
    editedEndDateTime,
    editedStartDateTime,
    updateTask,
  ]);

  useEffect(() => {
    if (isCreate || !task) return;
    triggerAutoSave();
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [triggerAutoSave, isCreate, task]);

  const buildMetadataSummary = useCallback((): string => {
    const parts: string[] = [];
    if (project?.name) parts.push(project.name);
    if (editedDoing) parts.push('进行中');
    if (editedDone) parts.push('已完成');
    if (editedType !== 'task') parts.push(editedType === 'milestone' ? '里程碑' : '委托');
    if (!editedDone && editedPriority !== 'default')
      parts.push(editedPriority === 'now' ? '立即完成' : '不着急');
    if (editedEndDateTime) {
      if (editedStartDateTime) {
        parts.push(`${formatDateTimeShort(editedStartDateTime)} ~ ${formatDateTimeShort(editedEndDateTime)}`);
      } else {
        parts.push(`截止 ${formatDateTimeShort(editedEndDateTime)}`);
      }
    }
    if (editedDone && task?.completed_time)
      parts.push(`完成于 ${formatCompletedTime(task.completed_time)}`);
    if (task?.users?.length) parts.push(task.users.join(', '));
    return parts.join(' · ');
  }, [
    project?.name,
    editedDoing,
    editedDone,
    editedType,
    editedPriority,
    editedEndDateTime,
    editedStartDateTime,
    task?.completed_time,
    task?.users,
  ]);

  const handleCreate = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    const t = editedTitle.trim();
    if (!t) {
      Alert.alert('提示', '请输入标题');
      return;
    }
    setSaving(true);
    try {
      const payload: NewTaskPayload = {
        id: generateId(),
        project_id: projectId,
        title: t,
        type: editedType,
        description: '', // 忽略该字段，仅兼容接口
        note: editedNote.trim() || undefined,
        childrenId: [],
        done: editedDone,
        ismine: true,
        relPos: { x: 0, y: 0 },
        startdatetime: editedStartDateTime ? toISO(editedStartDateTime) : undefined,
        enddatetime: editedEndDateTime ? toISO(editedEndDateTime) : null,
        completed_time: undefined,
        icon: null,
        creator: auth.userId,
        priority: editedPriority !== 'default' ? editedPriority : undefined,
        doing: editedDoing,
        done_quality: editedDoneQuality,
        users: [auth.userId],
      };
      await addTask(payload);
      navigation.dispatch(StackActions.pop(1));
    } catch (e) {
      Alert.alert('创建失败', e instanceof Error ? e.message : '请重试');
    } finally {
      setSaving(false);
    }
  }, [
    editedTitle,
    editedNote,
    editedDone,
    editedPriority,
    editedType,
    editedDoneQuality,
    editedDoing,
    editedEndDateTime,
    editedStartDateTime,
    projectId,
    getAuth,
    addTask,
    navigation,
  ]);

  const onBack = useCallback(() => {
    navigation.dispatch(StackActions.pop(1));
  }, [navigation]);

  const setEndToToday = useCallback(() => {
    const d = new Date(todayDate);
    d.setHours(23, 59, 0, 0);
    setEditedEndDateTime(d);
  }, [todayDate]);

  if (!isCreate && !task) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0f172a" />
        <Text style={styles.loadingText}>加载中...</Text>
      </View>
    );
  }

  const headerTitle = isCreate ? '新建任务' : '任务详情';
  const headerHeight = insets.top + 8 + 12 + 44;
  const summary = buildMetadataSummary();

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground style={StyleSheet.absoluteFill} topSolidHeight={insets.top + 8} />
        <TouchableOpacity style={[styles.circleBtn, styles.circleBtnLeft]} onPress={onBack} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color="#374151" />
        </TouchableOpacity>
        <View style={styles.topBarCenter}>
          <Text style={styles.topBarTitle}>{headerTitle}</Text>
        </View>
        {isCreate ? (
          <TouchableOpacity
            style={[styles.circleBtn, styles.createBtn]}
            onPress={handleCreate}
            disabled={!editedTitle.trim() || saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#0f172a" />
            ) : (
              <Text style={[styles.createBtnText, !editedTitle.trim() && styles.createBtnTextDisabled]}>
                创建
              </Text>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.circleBtn, styles.circleBtnRight]}
            onPress={() => setShowMetadata((v) => !v)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={showMetadata ? 'chevron-up' : 'ellipsis-horizontal'}
              size={showMetadata ? 20 : 22}
              color="#374151"
            />
          </TouchableOpacity>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingTop: headerHeight + 12 }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* 卡片 1：标题行；行数由隐藏 Text onTextLayout 得到，用于下边距（TextInput 无行数 API） */}
          <View style={styles.card}>
            <View
              key={task?.id ?? 'new'}
              style={[
                styles.sectionTitleRow,
                { paddingBottom: titleLineCount <= 1 ? 16 : 16 },
              ]}
            >
              <TouchableOpacity
                style={styles.statusIconWrap}
                onPress={() => setShowMetadata((v) => !v)}
                activeOpacity={0.8}
              >
                <View style={[styles.statusRing, { borderColor: taskColor }]}>
                  {editedDone ? (
                    <Ionicons name="checkmark" size={12} color={taskColor} />
                  ) : editedDoing ? (
                    <Ionicons name="construct-outline" size={10} color={taskColor} />
                  ) : null}
                </View>
              </TouchableOpacity>
              <View style={styles.titleInputWrap}>
                <Animated.View
                  style={{
                    marginTop: titleMarginTopAnim,
                    height: titleHeightAnim,
                  }}
                >
                  <TextInput
                    style={[
                      styles.titleInput,
                      {
                        flex: 1,
                        lineHeight: TITLE_LINE_HEIGHT,
                        ...(Platform.OS === 'android' && { textAlignVertical: 'top' }),
                      },
                    ]}
                    value={editedTitle}
                    onChangeText={(t) => setEditedTitle(t)}
                    placeholder="任务标题"
                    placeholderTextColor="#9ca3af"
                    multiline
                    {...(Platform.OS === 'android' && { includeFontPadding: false })}
                  />
                </Animated.View>
                <View style={styles.titleMeasureWrap} pointerEvents="none">
                  <Text
                    style={styles.titleMeasureText}
                    onTextLayout={(e) =>
                      setTitleLineCount(e.nativeEvent.lines.length || 1)
                    }
                  >
                    {editedTitle.trim() || ' '}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {showMetadata ? (
            <>
              {/* 区域标题在卡片外上方 */}
              <Text style={styles.sectionHeaderOuter}>状态</Text>
              <View style={[styles.card, styles.section]}>
                {!editedDone && (
                  <View style={[styles.row, styles.rowFirst]}>
                    <Text style={[styles.rowLabel, { color: taskColor }]}>进行中</Text>
                    <IOSStyleSwitch
                      value={editedDoing}
                      onValueChange={setEditedDoing}
                      trackColorOff="#e5e7eb"
                      trackColorOn={taskColor}
                    />
                  </View>
                )}
                <View style={[styles.row, editedDone && styles.rowFirst, editedType !== 'task' && styles.rowLast]}>
                  <Text style={[styles.rowLabel, { color: taskColor }]}>已完成</Text>
                  <IOSStyleSwitch
                    value={editedDone}
                    onValueChange={(v) => {
                      setEditedDone(v);
                      if (v) setEditedDoing(false);
                    }}
                    trackColorOff="#e5e7eb"
                    trackColorOn={taskColor}
                  />
                </View>
                {editedType === 'task' && (
                  <View style={[styles.row, styles.rowLast]}>
                    <Text style={styles.rowLabel}>
                      {editedDone ? '完成程度' : '优先级'}
                    </Text>
                    <TouchableOpacity
                      style={styles.pickerRow}
                      onPress={() => {
                        const opts = editedDone ? DONE_QUALITY_OPTIONS : PRIORITY_OPTIONS;
                        const current = editedDone ? editedDoneQuality : editedPriority;
                        Alert.alert(
                          editedDone ? '完成程度' : '优先级',
                          undefined,
                          opts.map((o) => ({
                            text: o.label,
                            onPress: () =>
                              editedDone ? setEditedDoneQuality(o.value) : setEditedPriority(o.value),
                          })).concat([{ text: '取消', style: 'cancel' as const }]),
                          { cancelable: true }
                        );
                      }}
                    >
                      <Text style={styles.pickerRowText}>
                        {(editedDone ? DONE_QUALITY_OPTIONS : PRIORITY_OPTIONS).find(
                          (o) => o.value === (editedDone ? editedDoneQuality : editedPriority)
                        )?.label ?? ''}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              <Text style={styles.sectionHeaderOuter}>基本信息</Text>
              <View style={[styles.card, styles.section]}>
                <View style={[styles.row, styles.rowFirst]}>
                  <Text style={styles.rowLabel}>类型</Text>
                  <TouchableOpacity
                    style={styles.pickerRow}
                    onPress={() =>
                      Alert.alert(
                        '类型',
                        undefined,
                        TYPE_OPTIONS.map((o) => ({
                          text: o.label,
                          onPress: () => setEditedType(o.value),
                        })).concat([{ text: '取消', style: 'cancel' as const }]),
                        { cancelable: true }
                      )
                    }
                  >
                    <Text style={styles.pickerRowText}>
                      {TYPE_OPTIONS.find((o) => o.value === editedType)?.label ?? ''}
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                  </TouchableOpacity>
                </View>
                <View style={[styles.row, styles.rowLast]}>
                  <Text style={styles.rowLabel}>负责人</Text>
                  <Text style={styles.rowValue}>{task?.users?.length ? task.users.join(', ') : '未指派'}</Text>
                </View>
              </View>

              <Text style={styles.sectionHeaderOuter}>时间</Text>
              <View style={[styles.card, styles.section]}>
                <TouchableOpacity
                  style={[styles.timeRow, showDateTimeEditor && styles.timeRowWithBorder]}
                  onPress={() => setShowDateTimeEditor((v) => !v)}
                >
                  <Ionicons
                    name={showDateTimeEditor ? 'chevron-down' : 'chevron-forward'}
                    size={14}
                    color="#6b7280"
                  />
                  <Text style={styles.timeRowLabel}>截止日期</Text>
                  <Text style={styles.timeRowValue} numberOfLines={1}>
                    {editedEndDateTime
                      ? editedStartDateTime
                        ? `${formatDateTimeShort(editedStartDateTime)} ~ ${formatDateTimeShort(editedEndDateTime)}`
                        : formatDateTimeShort(editedEndDateTime)
                      : '未设置'}
                  </Text>
                </TouchableOpacity>
                {showDateTimeEditor && (
                  <View style={styles.timeBody}>
                    {!editedEndDateTime ? (
                      <TouchableOpacity
                        style={[styles.row, styles.rowLast]}
                        onPress={setEndToToday}
                        activeOpacity={0.7}
                      >
                        <View style={styles.timeActionRow}>
                          <Ionicons name="calendar-outline" size={18} color="#0f172a" />
                          <Text style={styles.timeActionText}>设置截止日期</Text>
                        </View>
                      </TouchableOpacity>
                    ) : editedStartDateTime != null ? (
                      /* 起止时间模式：与 iOS 一致，两行可编辑 — 开始时间、结束时间 */
                      <>
                        <View style={styles.row}>
                          <Text style={styles.rowLabel}>开始时间</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <View ref={startDatePillRef} collapsable={false}>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker('start', 'date')}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.timePillText} numberOfLines={1}>
                                  {formatDatePill(editedStartDateTime)}
                                </Text>
                              </TouchableOpacity>
                            </View>
                            <View ref={startTimePillRef} collapsable={false}>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker('start', 'time')}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.timePillText} numberOfLines={1}>
                                  {formatTimePill(editedStartDateTime)}
                                </Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        </View>
                        <View style={styles.row}>
                          <Text style={styles.rowLabel}>结束时间</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <View ref={endDatePillRef} collapsable={false}>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker('end', 'date')}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.timePillText} numberOfLines={1}>
                                  {formatDatePill(editedEndDateTime)}
                                </Text>
                              </TouchableOpacity>
                            </View>
                            <View ref={endTimePillRef} collapsable={false}>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker('end', 'time')}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.timePillText} numberOfLines={1}>
                                  {formatTimePill(editedEndDateTime)}
                                </Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        </View>
                        <TouchableOpacity
                          style={styles.row}
                          onPress={() => {
                            if (editedStartDateTime) {
                              setEditedStartDateTime(null);
                            } else {
                              setEditedStartDateTime(new Date(editedEndDateTime.getTime()));
                              const end = new Date(editedEndDateTime.getTime());
                              end.setMinutes(end.getMinutes() + 30);
                              setEditedEndDateTime(end);
                            }
                          }}
                          activeOpacity={0.7}
                        >
                          <View style={styles.timeActionRow}>
                            <Ionicons name="swap-horizontal-outline" size={18} color="#111827" />
                            <Text style={[styles.timeActionText, { color: '#111827' }]}>
                              {editedStartDateTime ? '切换为截止时间' : '转为起止时间'}
                            </Text>
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.row, (editedDone && task?.completed_time) ? undefined : styles.rowLast]}
                          onPress={() => {
                            setEditedEndDateTime(null);
                            setEditedStartDateTime(null);
                          }}
                          activeOpacity={0.7}
                        >
                          <View style={styles.timeActionRow}>
                            <Ionicons name="trash-outline" size={18} color="#dc2626" />
                            <Text style={styles.timeActionTextDanger}>
                              清除所有时间
                            </Text>
                          </View>
                        </TouchableOpacity>
                      </>
                    ) : (
                      /* 截止日期模式：单行编辑截止日期 */
                      <>
                        <View style={styles.row}>
                          <Text style={styles.rowLabel}>截止日期</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <View ref={endDatePillRef} collapsable={false}>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker('end', 'date')}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.timePillText} numberOfLines={1}>
                                  {formatDatePill(editedEndDateTime)}
                                </Text>
                              </TouchableOpacity>
                            </View>
                            <View ref={endTimePillRef} collapsable={false}>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker('end', 'time')}
                                activeOpacity={0.7}
                              >
                                <Text style={styles.timePillText} numberOfLines={1}>
                                  {formatTimePill(editedEndDateTime)}
                                </Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        </View>
                        <TouchableOpacity
                          style={styles.row}
                          onPress={() => {
                            setEditedStartDateTime(new Date(editedEndDateTime.getTime()));
                            const end = new Date(editedEndDateTime.getTime());
                            end.setMinutes(end.getMinutes() + 30);
                            setEditedEndDateTime(end);
                          }}
                          activeOpacity={0.7}
                        >
                          <View style={styles.timeActionRow}>
                            <Ionicons name="swap-horizontal-outline" size={18} color="#111827" />
                            <Text style={[styles.timeActionText, { color: '#111827' }]}>
                              转为起止时间
                            </Text>
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.row, (editedDone && task?.completed_time) ? undefined : styles.rowLast]}
                          onPress={() => setEditedEndDateTime(null)}
                          activeOpacity={0.7}
                        >
                          <View style={styles.timeActionRow}>
                            <Ionicons name="trash-outline" size={18} color="#dc2626" />
                            <Text style={styles.timeActionTextDanger}>
                              清除截止日期
                            </Text>
                          </View>
                        </TouchableOpacity>
                      </>
                    )}
                    {editedDone && task?.completed_time && (
                      <View style={[styles.row, styles.rowLast]}>
                        <Text style={styles.rowLabel}>完成时间</Text>
                        <Text style={[styles.rowValue, { color: '#22c55e' }]}>
                          {formatCompletedTime(task.completed_time)}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>

              <Text style={styles.sectionHeaderOuter}>备注</Text>
              <View style={[styles.card, styles.section]}>
                <View style={styles.noteRow}>
                  <TextInput
                    style={[
                      styles.noteInput,
                      {
                        minHeight:
                          NOTE_MIN_LINES_EXPANDED * NOTE_LINE_HEIGHT,
                      },
                    ]}
                    value={editedNote}
                    onChangeText={setEditedNote}
                    multiline
                    placeholder=""
                  />
                </View>
              </View>
            </>
          ) : (
            /* 折叠状态：区域标题为简略 meta 一行字，备注卡片与标题行同框式、最少 5 行 */
            <>
              {summary ? (
                <Text style={styles.summaryText} numberOfLines={2}>
                  {summary}
                </Text>
              ) : (
                <Text style={styles.sectionHeaderOuter}>备注</Text>
              )}
              <View style={styles.card}>
                <View style={styles.noteRow}>
                  <TextInput
                    style={[
                      styles.noteInput,
                      {
                        minHeight:
                          NOTE_MIN_LINES_COLLAPSED * NOTE_LINE_HEIGHT,
                      },
                    ]}
                    value={editedNote}
                    onChangeText={setEditedNote}
                    multiline
                    placeholder=""
                  />
                </View>
              </View>
            </>
          )}

          {saving && !isCreate ? (
            <View style={styles.savingRow}>
              <ActivityIndicator size="small" color="#6b7280" />
              <Text style={styles.savingText}>保存中...</Text>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* 日期/时间选择器：第一个药丸选日期、第二个选时间，与 iOS 一致 */}
      {timePicker != null && (() => {
        const value =
          timePicker.field === 'start'
            ? (editedStartDateTime ?? new Date())
            : (editedEndDateTime ?? new Date());
        const handleChange = (event: { type: string }, date?: Date) => {
          if (Platform.OS === 'android' && event.type === 'dismissed') {
            setTimePicker(null);
            return;
          }
          if (date) {
            if (timePicker.field === 'start') {
              const base = editedStartDateTime ?? new Date();
              setEditedStartDateTime(
                timePicker.mode === 'date' ? mergeDateInto(base, date) : mergeTimeInto(base, date)
              );
            } else {
              const base = editedEndDateTime ?? new Date();
              setEditedEndDateTime(
                timePicker.mode === 'date' ? mergeDateInto(base, date) : mergeTimeInto(base, date)
              );
            }
          }
          // Android 选完即关；iOS 保持打开，由用户点「完成」或遮罩关闭
          if (Platform.OS === 'android') setTimePicker(null);
        };
        const picker = (
          <DateTimePicker
            value={value}
            mode={timePicker.mode}
            display={
              Platform.OS === 'ios'
                ? timePicker.mode === 'date'
                  ? 'inline'
                  : 'spinner'
                : 'default'
            }
            onChange={handleChange}
          />
        );
        if (Platform.OS === 'ios') {
          const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
          const cardWidth = Math.min(400, screenWidth - 48);
          const layout = timePicker.layout;
          const left = layout
            ? Math.max(24, Math.min(layout.x + layout.width / 2 - cardWidth / 2, screenWidth - cardWidth - 24))
            : undefined;
          const capsuleCenterY = layout ? layout.y + layout.height / 2 : 0;
          const inUpperHalf = layout && capsuleCenterY < screenHeight / 2;
          const cardPosition =
            layout && left != null
              ? inUpperHalf
                ? { position: 'absolute' as const, top: layout.y + layout.height + 8, left, width: cardWidth }
                : { position: 'absolute' as const, bottom: screenHeight - layout.y + 8, left, width: cardWidth }
              : { marginHorizontal: 24, alignSelf: 'center' as const };
          return (
            <Modal visible transparent animationType="fade">
              <TouchableOpacity
                style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]}
                activeOpacity={1}
                onPress={() => setTimePicker(null)}
              >
                <View
                  style={[styles.timePickerCard, cardPosition]}
                  onStartShouldSetResponder={() => true}
                >
                  {picker}
                </View>
              </TouchableOpacity>
            </Modal>
          );
        }
        return picker;
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
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
    backgroundColor: '#fff',
    ...shadowCircleButton,
  },
  circleBtnLeft: {},
  circleBtnRight: {},
  createBtn: { minWidth: 60 },
  createBtnText: { fontSize: 16, fontWeight: '600', color: '#0f172a' },
  createBtnTextDisabled: { color: '#9ca3af' },
  topBarCenter: { alignItems: 'center', flex: 1 },
  topBarTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: '#0f172a' },
  keyboardWrap: { flex: 1, backgroundColor: '#f2f2f7' },
  scroll: { flex: 1, backgroundColor: 'transparent' },
  scrollContent: { padding: 16, paddingBottom: 40, backgroundColor: '#f2f2f7' },
  /** 与 TaskFilterSheet 卡片圆角一致 */
  card: {
    backgroundColor: '#fff',
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 0,
    marginBottom: 16,
    ...shadowCard,
  },
  /** iOS 原生风格：相对胶囊定位的日期/时间选择器卡片，点周边关闭 */
  timePickerCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    ...shadowCard,
  },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f2f2f7' },
  loadingText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: '#6b7280' },

  /** 标题行（状态图标 + 任务名）：上边距固定 16，下边距由 titleLineCount 决定（1 行 14 / 多行 18） */
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingTop: 16,
  },
  statusIconWrap: { padding: 10, margin: -10 },
  statusRing: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  titleInputWrap: { flex: 1, position: 'relative' },
  /** 高度与 lineHeight 由 JS 按 titleLineCount × TITLE_LINE_HEIGHT 写死；marginTop -4 把整框上移，缓解贴底线 */
  titleInput: {
    flex: 1,
    fontSize: TASK_FONT_SIZE_TITLE,
    fontWeight: '600',
    color: '#111827',
    paddingVertical: 0,
  },
  /** 隐藏 Text 与标题同宽同字体，用于 onTextLayout 取 lines.length（TextInput 无行数 API） */
  titleMeasureWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
    zIndex: -1,
  },
  titleMeasureText: {
    fontSize: TASK_FONT_SIZE_TITLE,
    fontWeight: '600',
    color: '#111827',
  },

  section: {},
  /** 区域标题：卡片外上方灰色小字 */
  sectionHeaderOuter: {
    fontSize: TASK_FONT_SIZE_SMALL,
    fontWeight: '400',
    color: '#6b7280',
    marginLeft: 10,
    marginBottom: 12,
    marginTop: 8,
  },
  sectionHeader: {
    fontSize: TASK_FONT_SIZE_SMALL,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  rowFirst: { paddingTop: 16 },
  rowLast: { paddingBottom: 16, borderBottomWidth: 0 },
  rowLabel: { fontSize: TASK_FONT_SIZE_BODY, color: '#111827' },
  rowValue: { fontSize: TASK_FONT_SIZE_SMALL, color: '#6b7280' },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pickerRowText: { fontSize: TASK_FONT_SIZE_BODY, color: '#111827' },

  /** 时间卡片首行：与普通 row 一致 */
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 16,
    paddingBottom: 10,
  },
  timeRowWithBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  timeRowLabel: { fontSize: TASK_FONT_SIZE_BODY, color: '#111827', flex: 0 },
  timeRowValue: { flex: 1, fontSize: TASK_FONT_SIZE_SMALL, color: '#6b7280', textAlign: 'right' },
  timeBody: {},
  timePill: {
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timePillText: { fontSize: 15, color: '#111827' },
  timeActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  timeActionText: { fontSize: TASK_FONT_SIZE_BODY, color: '#0f172a', fontWeight: '500' },
  timeActionTextDanger: { fontSize: TASK_FONT_SIZE_BODY, color: '#dc2626', fontWeight: '500' },

  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111827',
  },
  /** 备注区与标题行同框式：上下 20、左右在 card 的 16 上再加 8 共 24 */
  noteRow: {
    paddingTop: 20,
    paddingBottom: 20,
    paddingHorizontal: 8,
  },
  /** 备注正文：与 Task 系统标准正文 17 一致 */
  noteInput: {
    textAlignVertical: 'top',
    fontSize: TASK_FONT_SIZE_BODY,
    fontWeight: '400',
    lineHeight: NOTE_LINE_HEIGHT,
    color: '#111827',
    paddingVertical: 0,
    paddingHorizontal: 0,
    minHeight: 0,
  },
  summaryText: { fontSize: TASK_FONT_SIZE_SMALL, fontWeight: '400', color: '#6b7280', marginLeft: 14, marginBottom: 10, lineHeight: 18 },

  savingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  savingText: { fontSize: TASK_FONT_SIZE_SMALL, color: '#6b7280' },
});
