import React, { useState, useEffect, useRef } from 'react';
import { View, TouchableOpacity, StyleSheet, PanResponder } from 'react-native';
import type { TaskItem } from '../taskApi';
import { TaskRowContextMenu, type RowPreview } from './TaskRowContextMenu';
import { TaskRowContent } from './TaskRowContent';

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
  /** 今日页拖拽排序：传入时右侧显示拖拽把手，长按把手可拖动 */
  drag?: () => void;
};

export function TaskRow({
  task,
  showProjectName,
  showTimeLabel = true,
  projectName,
  onPress,
  onToggleCompletion,
  drag,
}: TaskRowProps) {
  const [visualDone, setVisualDone] = useState(task.done);
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [anchorLayout, setAnchorLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [rowPreview, setRowPreview] = useState<RowPreview | null>(null);
  const rowRef = useRef<View>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dx) > 8 || Math.abs(gestureState.dy) > 8,
      onPanResponderGrant: () => {
        clearLongPressTimer();
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
      setVisualDone(true);
      setTimeout(() => onToggleCompletion(), 400);
    } else {
      setVisualDone(false);
      onToggleCompletion();
    }
  };

  const openContextMenu = () => {
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
          style={styles.row}
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
                  longPressTimerRef.current = setTimeout(openContextMenu, 400);
                }
              : () => {
                  openedMenuThisTouchRef.current = false;
                }
          }
          onPressOut={drag ? clearLongPressTimer : undefined}
          onLongPress={drag ? undefined : openContextMenu}
          activeOpacity={0.7}
          delayLongPress={drag ? undefined : 400}
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
