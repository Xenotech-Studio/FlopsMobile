import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { TaskItem } from '../taskApi';

const RING_SIZE = 24;
const RING_STROKE = 2;
const TAP_AREA_SIZE = 44;
const CHECKMARK_SIZE = 12;

const priorityColors: Record<string, string> = {
  now: '#dc2626',
  later: '#2563eb',
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
  if (task.priority === 'later') return '#3b82f6';
  return '#d98f33';
}

function formatTimeLabel(task: TaskItem): string {
  if (task.done && task.completed_time) {
    try {
      const d = new Date(task.completed_time);
      return `完成于 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return '';
    }
  }
  const raw = task.enddatetime || task.startdatetime;
  if (!raw || raw === '2025-02-28T23:59:59Z' || raw === '2025-02-28T00:00:00Z') return '';
  try {
    const d = new Date(raw);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

type TaskRowProps = {
  task: TaskItem;
  showProjectName?: boolean;
  projectName?: string;
  onPress: () => void;
  onToggleCompletion: () => void;
};

export function TaskRow({
  task,
  showProjectName,
  projectName,
  onPress,
  onToggleCompletion,
}: TaskRowProps) {
  const [visualDone, setVisualDone] = useState(task.done);
  const color = getTaskColor({ ...task, done: visualDone });
  const timeStr = formatTimeLabel(task);
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

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <TouchableOpacity
        style={styles.iconTapArea}
        onPress={(e) => {
          e.stopPropagation();
          handleToggle();
        }}
        activeOpacity={1}
      >
        <View style={[styles.ring, { borderColor: color }]}>
          {visualDone ? (
            <Ionicons name="checkmark" size={CHECKMARK_SIZE} color={color} />
          ) : doing ? (
            <Ionicons name="construct-outline" size={10} color={color} />
          ) : null}
        </View>
      </TouchableOpacity>
      <View style={styles.body}>
        <Text
          style={[styles.title, visualDone && styles.titleDone]}
          numberOfLines={2}
        >
          {task.title}
        </Text>
        {hasSubtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {priority ? (
          <View style={[styles.priorityBadge, { backgroundColor: `${priorityColors[priority]}20` }]}>
            <Text style={[styles.priorityText, { color: priorityColors[priority] }]}>
              {priorityLabels[priority]}
            </Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  iconTapArea: {
    width: TAP_AREA_SIZE,
    height: TAP_AREA_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: RING_STROKE,
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkmark: {},
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, color: '#111827', fontWeight: '400' },
  titleDone: { textDecorationLine: 'line-through', color: '#6b7280' },
  subtitle: { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  priorityBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 4 },
  priorityText: { fontSize: 11, fontWeight: '600' },
});
