/**
 * 任务行内容：与 TaskRow 同一套排版，供列表行与长按菜单高亮共用，避免写两遍。
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import {
  TASK_ROW_MIN_HEIGHT,
  TASK_ROW_PADDING_VERTICAL,
  TASK_ROW_PADDING_RIGHT,
} from '../theme/layout';
import { LIST_ROW_TITLE_SIZE, TASK_FONT_SIZE_SMALL } from '../theme/typography';
import { useAppTheme } from '../context/ThemeContext';

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
  /** 行左内边距覆盖（不传 = 默认 2）。外层 list 有/无 paddingHorizontal 时各页自己定，
   *  让圆环左缘对齐该页内容左缘：今日页 list 已给 16 → 默认 2；项目页 list 无内边距 → 传更大值。 */
  rowPaddingLeft?: number;
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
  rowPaddingLeft,
}: TaskRowContentProps) {
  const { colors } = useAppTheme();
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
    <View style={[styles.row, rowPaddingLeft != null && { paddingLeft: rowPaddingLeft }]}>
      {onRingPress ? (
        <TouchableOpacity
          style={styles.iconTapArea}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
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
          style={[
            styles.title,
            { color: colors.textPrimary },
            visualDone && [styles.titleDone, { color: colors.textMuted }],
          ]}
          numberOfLines={2}
        >
          {title}
        </Text>
        {hasSubtitle ? (
          <Text style={[styles.subtitle, { color: colors.placeholder }]}>{subtitle}</Text>
        ) : null}
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
    /* 默认 16：standalone / 长按预览卡片里圆环到卡片左缘的舒适内边距。
       列表里圆环要跟段标题/对话行左缘对齐时，由各页 callsite 传 rowPaddingLeft 覆盖成小值
       （list 无横向 padding 的页面用此默认；有 padding 的页面传 rowPaddingLeft 覆盖）。 */
    paddingLeft: 18,
    paddingRight: TASK_ROW_PADDING_RIGHT,
    gap: 12,
  },
  iconTapArea: {
    /* 宽度收到圆环本身（不再 44）——否则圆环左对齐后右侧空 20pt，标题被推太远。
       触摸面积靠下方 TouchableOpacity 的 hitSlop 补回（视觉 24、可点 ~44）。
       height 保留 44 给纵向触摸 + 行内纵向居中。 */
    width: RING_SIZE,
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
  title: { fontSize: LIST_ROW_TITLE_SIZE, fontWeight: '400' },
  titleDone: { textDecorationLine: 'line-through' },
  subtitle: { fontSize: TASK_FONT_SIZE_SMALL, marginTop: 2 },
  priorityBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 4,
  },
  priorityText: { fontSize: 11, fontWeight: '600' },
});
