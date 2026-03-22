/**
 * Markdown 渲染 + 可选复制按钮，与 FlopsDesktop 的 MarkdownContent 能力对齐
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { UsageDetailModal } from './UsageDetailModal';

const markdownStyles = {
  body: { color: '#111827', fontSize: 16, lineHeight: 26 },
  paragraph: { marginTop: 0, marginBottom: 12 },
  text: { color: '#111827' },
  code_inline: {
    backgroundColor: '#f3f4f6',
    color: '#111827',
    fontSize: 14,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  code_block: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 12,
    marginVertical: 10,
  },
  fence: { color: '#111827', fontSize: 13 },
  link: { color: '#111827' },
  strong: { fontWeight: '700' as const },
  em: { fontStyle: 'italic' as const },
  list_item: { marginVertical: 4 },
  heading1: { fontSize: 22, fontWeight: '700' as const, marginTop: 14, marginBottom: 8 },
  heading2: { fontSize: 20, fontWeight: '700' as const, marginTop: 12, marginBottom: 6 },
  heading3: { fontSize: 18, fontWeight: '600' as const, marginTop: 10, marginBottom: 4 },
  hr: { backgroundColor: '#e5e7eb', height: 1, marginVertical: 14 },
  blockquote: { backgroundColor: '#f9fafb', borderLeftWidth: 4, borderLeftColor: '#d1d5db', paddingLeft: 14, marginVertical: 10 },
  table: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 6 },
  th: { padding: 10, borderWidth: 1, borderColor: '#e5e7eb', backgroundColor: '#f9fafb', fontWeight: '600' as const },
  td: { padding: 10, borderWidth: 1, borderColor: '#e5e7eb' },
};

type Props = {
  text: string;
  showCopyButton?: boolean;
  showRegenerateButton?: boolean;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
  /** 本段用量小字，与 Web/Desktop flops-chat-ui 对齐；点击查看详情 */
  usageHint?: string;
  /** 弹窗多行详情；不传则仅展示 usageHint */
  usageDetail?: string;
};

export function MarkdownContent({
  text,
  showCopyButton = false,
  showRegenerateButton = false,
  onRegenerate,
  regenerateDisabled = false,
  usageHint,
  usageDetail,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [usageDetailOpen, setUsageDetailOpen] = useState(false);
  const source = String(text ?? '').trim();
  const hasUsage = typeof usageHint === 'string' && usageHint.trim().length > 0;
  const detailText =
    typeof usageDetail === 'string' && usageDetail.trim().length > 0
      ? usageDetail.trim()
      : hasUsage
        ? usageHint!.trim()
        : '';

  const showUsagePress = () => {
    if (!detailText) return;
    setUsageDetailOpen(true);
  };

  const handleCopy = () => {
    if (!source) return;
    Clipboard.setString(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const showToolbar =
    showCopyButton ||
    (showRegenerateButton && typeof onRegenerate === 'function') ||
    hasUsage;

  return (
    <View style={styles.wrap}>
      <View style={styles.content}>
        {source ? (
          <Markdown style={markdownStyles}>{source}</Markdown>
        ) : hasUsage ? null : (
          <Text style={styles.placeholder}>（无内容）</Text>
        )}
      </View>
      {showToolbar ? (
        <View style={[styles.toolbarRow, hasUsage && styles.toolbarRowFull]}>
          <View style={styles.toolbarLeft}>
            {showRegenerateButton && typeof onRegenerate === 'function' ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionBtnIconOnly, regenerateDisabled && styles.actionBtnDisabled]}
                onPress={onRegenerate}
                disabled={regenerateDisabled}
                accessibilityLabel="重新回答"
              >
                <Ionicons name="refresh" size={20} color={regenerateDisabled ? '#9ca3af' : '#4b5563'} />
              </TouchableOpacity>
            ) : null}
            {showCopyButton ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionBtnIconOnly]}
                onPress={handleCopy}
                accessibilityLabel={copied ? '已复制' : '复制'}
              >
                <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={20} color="#4b5563" />
              </TouchableOpacity>
            ) : null}
          </View>
          {hasUsage ? (
            <>
              <View style={styles.toolbarSpacer} />
              <TouchableOpacity
                style={styles.usageChip}
                onPress={showUsagePress}
                disabled={!detailText}
                accessibilityLabel="用量详情"
                accessibilityRole="button"
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              >
                <Text style={styles.usageChipText} numberOfLines={1}>
                  {usageHint!.trim()}
                </Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      ) : null}
      <UsageDetailModal
        visible={usageDetailOpen}
        onClose={() => setUsageDetailOpen(false)}
        body={detailText}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'column',
    gap: 10,
    width: '100%',
    alignSelf: 'stretch',
  },
  content: {
    flexDirection: 'column',
  },
  placeholder: {
    fontSize: 14,
    color: '#9ca3af',
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  toolbarRowFull: {
    alignSelf: 'stretch',
    width: '100%',
  },
  toolbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toolbarSpacer: {
    flex: 1,
    minWidth: 8,
  },
  usageChip: {
    flexShrink: 1,
    maxWidth: '72%',
    paddingVertical: 4,
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
  },
  usageChipText: {
    fontSize: 12,
    color: '#6b7280',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  actionBtnIconOnly: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  actionBtnDisabled: {
    opacity: 0.6,
  },
});
