import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { ContextSummary, ConversationMessage } from '../api';
import { ContextCompressSummaryModal } from './ContextCompressSummaryModal';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

type Props = {
  activeSummary: ContextSummary;
  rawMessages: ConversationMessage[];
  /** 供 ChatScreen 用 measureLayout 相对 chatContentWrap 计算滚动偏移（onLayout.y 相对父级，嵌套在气泡内会错） */
  anchorRef?: React.RefObject<View | null>;
};

function createDividerStyles(c: AppColors) {
  return StyleSheet.create({
    root: {
      flexDirection: 'row',
      alignItems: 'center',
      marginVertical: 14,
      paddingHorizontal: 4,
      gap: 10,
    },
    line: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
    },
    trigger: {
      flexDirection: 'row',
      alignItems: 'center',
      maxWidth: '78%',
      gap: 6,
    },
    icon: {
      flexShrink: 0,
    },
    label: {
      flex: 1,
      fontSize: 12,
      color: c.textMuted,
      lineHeight: 17,
    },
  });
}

export function ContextCompressDividerRow({ activeSummary, rawMessages, anchorRef }: Props) {
  const [open, setOpen] = useState(false);
  const { colors } = useAppTheme();
  const styles = useMemo(() => createDividerStyles(colors), [colors]);

  return (
    <>
      <View ref={anchorRef} style={styles.root} collapsable={false}>
        <View style={styles.line} />
        <TouchableOpacity
          style={styles.trigger}
          onPress={() => setOpen(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="上文已压缩为摘要，点击查看范围与全文"
        >
          <Ionicons name="layers-outline" size={18} color={colors.textMuted} style={styles.icon} />
          <Text style={styles.label} numberOfLines={2}>
            上文已压缩为摘要，点击查看范围与全文
          </Text>
        </TouchableOpacity>
        <View style={styles.line} />
      </View>
      <ContextCompressSummaryModal
        visible={open}
        onClose={() => setOpen(false)}
        activeSummary={activeSummary}
        rawMessages={rawMessages}
      />
    </>
  );
}
