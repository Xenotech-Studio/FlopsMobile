import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, TouchableOpacity, StyleSheet, PanResponder, Platform, Vibration } from 'react-native';
import { useAppTheme } from '../context/ThemeContext';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import type { TaskItem } from '../taskApi';
import { TaskRowContextMenu, type RowPreview } from './TaskRowContextMenu';
import { TaskRowContent } from './TaskRowContent';
import { SHADOW_COLOR } from '../theme/shadows';

const priorityColors: Record<string, string> = {
  now: '#dc2626',
  later: '#6b7280',
  default: '#6b7280',
};

const priorityLabels: Record<string, string> = {
  now: '紧急',
  later: '稍后',
  default: '',
};

function getTaskColor(task: TaskItem): string {
  if (task.type === 'milestone') {
    return task.done ? '#b8e0b8' : '#adadad';
  }
  if (task.type === 'delegation') {
    if (task.done) {
      if (task.done_quality === 'wasted') return '#f5b033';
      return task.done_quality === 'reviewing' ? '#22c55e' : '#8fec8f';
    }
    return '#9466f5';
  }
  if (task.done) {
    if (task.done_quality === 'wasted') return '#f5b033';
    return task.done_quality === 'reviewing' ? '#22c55e' : '#8fec8f';
  }
  if (task.priority === 'now') return '#fa5a17';
  if (task.priority === 'later') return '#6b7280';
  return '#d98f33';
}

/** 与 FlowTaskIOS 一致：今天/明天/昨天 + 时间，其它显示 M月d日 HH:mm */
function formatDateAndTime(d: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayDiff = Math.round((dDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (dayDiff === 0) return `今天 ${timeStr}`;
  if (dayDiff === 1) return `明天 ${timeStr}`;
  if (dayDiff === -1) return `昨天 ${timeStr}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`;
}

function formatTimeLabel(task: TaskItem): string {
  if (task.done && task.completed_time) {
    try {
      const d = new Date(task.completed_time);
      return `完成于 ${formatDateAndTime(d)}`;
    } catch {
      return '';
    }
  }
  const raw = task.enddatetime || task.startdatetime;
  if (!raw || raw === '2025-02-28T23:59:59Z' || raw === '2025-02-28T00:00:00Z') return '';
  try {
    const d = new Date(raw);
    return formatDateAndTime(d);
  } catch {
    return '';
  }
}

type TaskRowProps = {
  task: TaskItem;
  showProjectName?: boolean;
  showTimeLabel?: boolean;
  projectName?: string;
  onPress: () => void;
  onToggleCompletion: () => void;
  /** 今日页拖拽排序。500ms 可拖拽（iOS 直接进拖拽，Android 移动后拖拽）；同时开始剩余 500ms 计时，无大幅移动则满 1000ms 出菜单。 */
  drag?: () => void;
};

/** 直接拖拽前需按住的最短时间（ms） */
const DRAG_ACTIVATION_DELAY_MS = 500;
/** 长按打开上下文菜单的总时长（ms） */
const CONTEXT_MENU_DELAY_MS = 1000;
/** 进入可拖拽后的剩余计时（ms），到时无大幅移动则打开菜单 */
const REMAINING_FOR_MENU_MS = CONTEXT_MENU_DELAY_MS - DRAG_ACTIVATION_DELAY_MS;

export function TaskRow({
  task,
  showProjectName,
  showTimeLabel = true,
  projectName,
  onPress,
  onToggleCompletion,
  drag,
}: TaskRowProps) {
  const { colors } = useAppTheme();
  const rowDragReadyStyle = useMemo(
    () => ({
      backgroundColor: colors.surface,
      ...Platform.select({
        ios: {
          shadowColor: SHADOW_COLOR,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.06,
          shadowRadius: 6,
        },
        android: {
          elevation: 0,
          borderWidth: 1,
          borderColor: colors.androidCircleFabHairline,
        },
        default: {},
      }),
    }),
    [colors]
  );
  const [visualDone, setVisualDone] = useState(task.done);
  const [dragReadyVisual, setDragReadyVisual] = useState(false);
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [anchorLayout, setAnchorLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [rowPreview, setRowPreview] = useState<RowPreview | null>(null);
  const rowRef = useRef<View>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragActivationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragReadyRef = useRef(false);
  const contextMenuVisibleRef = useRef(false);
  const dragRef = useRef(drag);
  /** 本次触摸已触发了长按菜单，松手时不要再触发 onPress（避免进入详情） */
  const openedMenuThisTouchRef = useRef(false);
  contextMenuVisibleRef.current = contextMenuVisible;
  dragRef.current = drag;

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const clearDragActivationTimer = () => {
    if (dragActivationTimerRef.current != null) {
      clearTimeout(dragActivationTimerRef.current);
      dragActivationTimerRef.current = null;
    }
    dragReadyRef.current = false;
    setDragReadyVisual(false);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) =>
        dragReadyRef.current &&
        (Math.abs(gestureState.dx) > 8 || Math.abs(gestureState.dy) > 8),
      onPanResponderGrant: () => {
        clearLongPressTimer();
        clearDragActivationTimer();
        if (contextMenuVisibleRef.current) {
          setContextMenuVisible(false);
          setAnchorLayout(null);
          setRowPreview(null);
        }
        dragRef.current?.();
      },
    })
  ).current;

  const color = getTaskColor({ ...task, done: visualDone });
  const timeStr = showTimeLabel ? formatTimeLabel(task) : null;
  const priority = task.priority && task.priority !== 'default' ? task.priority : null;
  const parts: string[] = [];
  if (showProjectName && projectName) parts.push(projectName);
  if (timeStr) parts.push(timeStr);
  const subtitle = parts.join(' · ');
  const hasSubtitle = subtitle.length > 0;
  const doing = !visualDone && (task.doing === true);

  useEffect(() => {
    setVisualDone(task.done);
  }, [task.done]);

  const handleToggle = () => {
    if (!task.done) {
      if (Platform.OS === 'android') {
        Vibration.vibrate([0, 18, 55, 22]);
      } else {
        ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
        setTimeout(() => {
          ReactNativeHapticFeedback.trigger('impactMedium', { enableVibrateFallback: true });
        }, 55);
      }
      setVisualDone(true);
      setTimeout(() => onToggleCompletion(), 400);
    } else {
      setVisualDone(false);
      onToggleCompletion();
    }
  };

  const openContextMenu = () => {
    setDragReadyVisual(false);
    openedMenuThisTouchRef.current = true;
    setRowPreview({
      title: task.title,
      subtitle,
      color: getTaskColor({ ...task, done: visualDone }),
      visualDone,
      doing,
      priorityLabel: priority ? priorityLabels[priority] : null,
      priorityColor: priority ? priorityColors[priority] : null,
    });
    rowRef.current?.measureInWindow((x, y, width, height) => {
      setAnchorLayout({ x, y, width, height });
      setContextMenuVisible(true);
    });
  };

  return (
    <>
      <View
        ref={rowRef}
        collapsable={false}
        {...(drag ? panResponder.panHandlers : {})}
      >
        <TouchableOpacity
          style={[styles.row, drag && dragReadyVisual && rowDragReadyStyle]}
          onPress={() => {
            if (openedMenuThisTouchRef.current) {
              openedMenuThisTouchRef.current = false;
              return;
            }
            onPress();
          }}
          onPressIn={
            drag
              ? () => {
                  openedMenuThisTouchRef.current = false;
                  clearDragActivationTimer();
                  dragReadyRef.current = false;
                  dragActivationTimerRef.current = setTimeout(() => {
                    dragActivationTimerRef.current = null;
                    dragReadyRef.current = true;
                    setDragReadyVisual(true);
                    if (Platform.OS === 'android') {
                      Vibration.vibrate(15);
                    } else {
                      ReactNativeHapticFeedback.trigger('impactHeavy', { enableVibrateFallback: true });
                    }
                    if (Platform.OS === 'ios') {
                      dragRef.current?.();
                    }
                    longPressTimerRef.current = setTimeout(openContextMenu, REMAINING_FOR_MENU_MS);
                  }, DRAG_ACTIVATION_DELAY_MS);
                }
              : () => {
                  openedMenuThisTouchRef.current = false;
                }
          }
          onPressOut={
            drag
              ? () => {
                  clearDragActivationTimer();
                  clearLongPressTimer();
                }
              : undefined
          }
          onLongPress={drag ? undefined : openContextMenu}
          activeOpacity={0.7}
          delayLongPress={drag ? undefined : CONTEXT_MENU_DELAY_MS}
        >
          <TaskRowContent
            title={task.title}
            subtitle={hasSubtitle ? subtitle : null}
            color={color}
            visualDone={visualDone}
            doing={doing}
            onRingPress={handleToggle}
            priorityLabel={priority ? priorityLabels[priority] : null}
            priorityColor={priority ? priorityColors[priority] : null}
          />
        </TouchableOpacity>
      </View>
      <TaskRowContextMenu
        task={task}
        visible={contextMenuVisible}
        anchorLayout={anchorLayout}
        rowPreview={rowPreview}
        onClose={() => {
          setContextMenuVisible(false);
          setAnchorLayout(null);
          setRowPreview(null);
        }}
        onDragInstead={drag}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    alignSelf: 'stretch',
  },
});
