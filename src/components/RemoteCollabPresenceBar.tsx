import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../context/ThemeContext';
import { shadowCircleButtonThemed } from '../theme/shadows';
import type { TaskItem } from '../taskApi';
import type { RemoteCollabSession } from '../hooks/useProjectCollabSocket';

function formatTaskIdsForPresence(tasks: TaskItem[], taskIds: string[] | undefined): string {
  const ids = Array.isArray(taskIds) ? taskIds.filter(Boolean) : [];
  if (ids.length === 0) return '节点';
  if (ids.length === 1) {
    const t = tasks.find((x) => String(x.id) === String(ids[0]));
    return t?.title ? `「${t.title}」` : `任务 ${ids[0]}`;
  }
  const first = tasks.find((x) => String(x.id) === String(ids[0]));
  const firstLabel = first?.title ? `「${first.title}」` : `任务 ${ids[0]}`;
  return `${firstLabel} 等共 ${ids.length} 个节点`;
}

type Props = {
  sessions: RemoteCollabSession[];
  tasks: TaskItem[];
  /** floating：标题下悬浮胶囊，单行截断；bottom：底部条样式（可多行） */
  variant?: 'floating' | 'bottom';
};

export function RemoteCollabPresenceBar({ sessions, tasks, variant = 'bottom' }: Props) {
  const { colors } = useAppTheme();

  if (!sessions.length) return null;

  const wrapStyle = variant === 'floating' ? styles.wrapFloating : styles.wrapBottom;

  const lineContent = sessions.map((s, i) => {
    const uid = s.user_id || '';
    const nick = uid
      ? uid.length > 10
        ? `${uid.slice(0, 8)}…`
        : uid
      : '其他协作者';
    const isDrag = s.kind === 'node_drag';
    const detail = isDrag
      ? formatTaskIdsForPresence(tasks, s.task_ids)
      : (() => {
          const task = tasks.find((t) => String(t.id) === String(s.task_id));
          return task?.title
            ? `「${task.title}」`
            : s.task_id
              ? `任务 ${s.task_id}`
              : '任务';
        })();
    return (
      <Text key={s.client_instance_id ?? String(i)}>
        {i > 0 ? <Text style={{ color: colors.textSecondary }}> · </Text> : null}
        <Text style={[styles.nick, { color: colors.textPrimary }]}>{nick}</Text>
        <Text style={{ color: colors.textSecondary }}>
          {isDrag ? ' 正在移动 ' : ' 正在编辑 '}
          {detail}
        </Text>
      </Text>
    );
  });

  return (
    <View
      style={[
        wrapStyle,
        { backgroundColor: colors.surface },
        variant === 'floating'
          ? shadowCircleButtonThemed(colors)
          : { borderColor: colors.border },
      ]}
      accessibilityRole="text"
      accessible
    >
      {variant === 'floating' ? (
        <Text
          style={[styles.line, styles.lineFloating, { color: colors.textSecondary }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {lineContent}
        </Text>
      ) : (
        <Text style={[styles.line, { color: colors.textSecondary }]} numberOfLines={4}>
          {lineContent}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapBottom: {
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  /** 阴影/描边与顶栏圆形按钮一致：iOS shadowCircleButtonIos；Android androidCircleFabOutline */
  wrapFloating: {
    alignSelf: 'center',
    width: '70%',
    maxWidth: 280,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 11 : 10,
    borderRadius: 999,
  },
  line: {
    fontSize: 12,
    lineHeight: 16,
  },
  lineFloating: {
    fontSize: 13,
    lineHeight: Platform.OS === 'ios' ? 20 : 21,
  },
  nick: {
    fontWeight: '600',
  },
});
