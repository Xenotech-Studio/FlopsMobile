/**
 * 思考块视图：流式中默认展开、结束自动折叠，可点击重新展开。
 * 短思考（<3 秒且无内容时）隐去，让 UI 不被瞬时思考淹没。
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';

type ThinkingBlock = {
  type: 'thinking';
  content: string;
  closed: boolean;
  seconds?: number;
  startedAt?: number;
};

const SHORT_THINKING_MS = 3000;

function formatSeconds(s: number | undefined): string {
  if (s == null || !Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const mm = Math.floor(s / 60);
  const ss = Math.round(s - mm * 60);
  return `${mm}m${ss.toString().padStart(2, '0')}s`;
}

export function ThinkingBlockView({ block }: { block: ThinkingBlock }) {
  const { colors } = useAppTheme();
  const styles = createStyles(colors);

  /* 默认行为：流式中（!closed）保持展开；结束后自动折叠（用户可再点开）。
     一旦用户手动切过状态就以用户意图为准，不被自动折叠覆盖。 */
  const [expanded, setExpanded] = useState<boolean>(!block.closed);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) return;
    setExpanded(!block.closed);
  }, [block.closed, touched]);

  // 短思考（<3s 内已结束）默认隐藏；用户主动展开过则一直显示
  const startedAt = block.startedAt ?? 0;
  const isShortThinking =
    block.closed &&
    !touched &&
    !block.seconds &&
    startedAt > 0 &&
    Date.now() - startedAt < SHORT_THINKING_MS;
  if (isShortThinking) return null;

  const content = (block.content || '').trim();
  if (!content && block.closed) return null;

  const secondsText = formatSeconds(block.seconds);
  const headerLabel = block.closed
    ? secondsText
      ? `思考完成 · ${secondsText}`
      : '思考完成'
    : '思考中…';

  const onToggle = () => {
    setTouched(true);
    setExpanded((v) => !v);
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.header}
        onPress={onToggle}
        activeOpacity={0.7}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={14}
          color={colors.textMuted}
        />
        <Text style={styles.headerText}>{headerLabel}</Text>
      </TouchableOpacity>
      {expanded ? (
        <Text style={styles.content} selectable>
          {content || '…'}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: {
      marginTop: 4,
      marginBottom: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: c.surfaceMuted ?? c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    headerText: {
      fontSize: 13,
      color: c.textMuted,
      fontWeight: '500',
    },
    content: {
      marginTop: 6,
      fontSize: 13,
      lineHeight: 19,
      color: c.textMutedSlate ?? c.textMuted,
    },
  });
}
