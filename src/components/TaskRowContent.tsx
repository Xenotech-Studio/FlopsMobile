/**
 * 任务行内容：与 TaskRow 同一套排版，供列表行与长按菜单高亮共用，避免写两遍。
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import {
  TASK_ROW_MIN_HEIGHT,
  TASK_ROW_PADDING_VERTICAL,
  TASK_ROW_PADDING_LEFT,
  TASK_ROW_PADDING_RIGHT,
} from '../theme/layout';

const RING_SIZE = 24;
const RING_STROKE = 2;
const TAP_AREA_SIZE = 44;
const CHECKMARK_SIZE = 12;

export type TaskRowContentProps = {
  title: string;
  subtitle?: string | null;
  color: string;
  visualDone: boolean;
  doing: boolean;
  /** 点击圆环时回调；不传则圆环不可点（如菜单高亮） */
  onRingPress?: () => void;
  /** 优先级角标，不传则不显示 */
  priorityLabel?: string | null;
  priorityColor?: string | null;
};

export function TaskRowContent({
  title,
  subtitle,
  color,
  visualDone,
  doing,
  onRingPress,
  priorityLabel,
  priorityColor,
}: TaskRowContentProps) {
  const hasSubtitle = Boolean(subtitle && subtitle.length > 0);
  const showPriority = Boolean(priorityLabel && priorityColor);

  const ring = (
    <View style={[styles.ring, { borderColor: color }]}>
      {visualDone ? (
        <Ionicons name="checkmark" size={CHECKMARK_SIZE} color={color} />
      ) : doing ? (
        <Ionicons name="construct-outline" size={10} color={color} />
      ) : null}
    </View>
  );

  return (
    <View style={styles.row}>
      {onRingPress ? (
        <TouchableOpacity
          style={styles.iconTapArea}
          onPress={(e) => {
            e.stopPropagation();
            onRingPress();
          }}
          activeOpacity={1}
        >
          {ring}
        </TouchableOpacity>
      ) : (
        <View style={styles.iconTapArea}>{ring}</View>
      )}
      <View style={styles.body}>
        <Text
          style={[styles.title, visualDone && styles.titleDone]}
          numberOfLines={2}
        >
          {title}
        </Text>
        {hasSubtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {showPriority && priorityLabel && priorityColor ? (
          <View
            style={[
              styles.priorityBadge,
              { backgroundColor: `${priorityColor}20` },
            ]}
          >
            <Text style={[styles.priorityText, { color: priorityColor }]}>
              {priorityLabel}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TASK_ROW_MIN_HEIGHT,
    paddingVertical: TASK_ROW_PADDING_VERTICAL,
    paddingLeft: TASK_ROW_PADDING_LEFT,
    paddingRight: TASK_ROW_PADDING_RIGHT,
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
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, color: '#111827', fontWeight: '400' },
  titleDone: { textDecorationLine: 'line-through', color: '#6b7280' },
  subtitle: { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  priorityBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 4,
  },
  priorityText: { fontSize: 11, fontWeight: '600' },
});
