/**
 * 对话列表行 —— 今日页 / 项目页 Chats 共用，保证两处视觉一致。
 * 左：标题（+ 运行中 spinner / 未读 check）+ 下方灰色时间；右：chevron。
 * 自带 paddingHorizontal:16，外层 list 容器不要再加横向 padding（各内容自 padding 架构）。
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { LIST_ROW_TITLE_SIZE } from '../theme/typography';
import { InboxRunSpinner, InboxUnreadCheck } from './InboxListIndicators';

type Props = {
  title: string;
  /** 灰色时间标签，已格式化；不传 / 空则不显示 */
  timeLabel?: string | null;
  running?: boolean;
  unread?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
};

export function ConversationRow({
  title,
  timeLabel,
  running,
  unread,
  onPress,
  onLongPress,
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      android_ripple={{ color: colors.surfaceMuted }}
    >
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {running ? <InboxRunSpinner /> : unread ? <InboxUnreadCheck /> : null}
        </View>
        {timeLabel ? (
          <Text style={styles.meta} numberOfLines={1}>
            {timeLabel}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 18,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    /** 按下：背景压暗（比 activeOpacity 渐隐反馈更强）。iOS 用半透明黑叠色；Android 走 ripple。 */
    rowPressed: { backgroundColor: 'rgba(0,0,0,0.04)' },
    main: { flex: 1, minWidth: 0 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    /** 字号/字重跟任务行标题统一（LIST_ROW_TITLE_SIZE / 400） */
    title: { flex: 1, minWidth: 0, fontSize: LIST_ROW_TITLE_SIZE, color: c.textPrimary, fontWeight: '400' },
    /** 灰色跟任务副标题同一个灰（placeholder） */
    meta: { fontSize: 12, color: c.placeholder, marginTop: 2 },
  });
}
