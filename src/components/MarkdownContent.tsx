/**
 * Markdown 渲染 + 可选复制按钮，与 FlopsDesktop 的 MarkdownContent 能力对齐
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';

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
  link: { color: '#2563eb' },
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
};

export function MarkdownContent({
  text,
  showCopyButton = false,
  showRegenerateButton = false,
  onRegenerate,
  regenerateDisabled = false,
}: Props) {
  const [copied, setCopied] = useState(false);
  const source = String(text ?? '').trim();

  const handleCopy = () => {
    if (!source) return;
    Clipboard.setString(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const showToolbar = showCopyButton || (showRegenerateButton && typeof onRegenerate === 'function');

  return (
    <View style={styles.wrap}>
      <View style={styles.content}>
        {source ? (
          <Markdown style={markdownStyles}>{source}</Markdown>
        ) : (
          <Text style={styles.placeholder}>（无内容）</Text>
        )}
      </View>
      {showToolbar ? (
        <View style={styles.toolbar}>
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
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'column',
    gap: 10,
  },
  content: {
    flexDirection: 'column',
  },
  placeholder: {
    fontSize: 14,
    color: '#9ca3af',
  },
  toolbar: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 8,
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
