/**
 * Markdown 渲染 + 可选复制按钮，与 FlopsDesktop 的 MarkdownContent 能力对齐
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import Clipboard from '@react-native-clipboard/clipboard';

const markdownStyles = {
  body: { color: '#111827', fontSize: 16, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  text: { color: '#111827' },
  code_inline: {
    backgroundColor: '#f3f4f6',
    color: '#111827',
    fontSize: 14,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
  },
  code_block: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
  },
  fence: { color: '#111827', fontSize: 13 },
  link: { color: '#2563eb' },
  strong: { fontWeight: '700' as const },
  em: { fontStyle: 'italic' as const },
  list_item: { marginVertical: 2 },
  heading1: { fontSize: 22, fontWeight: '700' as const, marginTop: 12, marginBottom: 6 },
  heading2: { fontSize: 20, fontWeight: '700' as const, marginTop: 10, marginBottom: 4 },
  heading3: { fontSize: 18, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
  hr: { backgroundColor: '#e5e7eb', height: 1, marginVertical: 12 },
  blockquote: { backgroundColor: '#f9fafb', borderLeftWidth: 4, borderLeftColor: '#d1d5db', paddingLeft: 12, marginVertical: 6 },
  table: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 6 },
  th: { padding: 8, borderWidth: 1, borderColor: '#e5e7eb', backgroundColor: '#f9fafb', fontWeight: '600' as const },
  td: { padding: 8, borderWidth: 1, borderColor: '#e5e7eb' },
};

type Props = {
  text: string;
  showCopyButton?: boolean;
};

export function MarkdownContent({ text, showCopyButton = false }: Props) {
  const [copied, setCopied] = useState(false);
  const source = String(text ?? '').trim();

  const handleCopy = () => {
    if (!source) return;
    Clipboard.setString(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.content}>
        {source ? (
          <Markdown style={markdownStyles}>{source}</Markdown>
        ) : (
          <Text style={styles.placeholder}>（无内容）</Text>
        )}
      </View>
      {showCopyButton ? (
        <TouchableOpacity
          style={styles.copyBtn}
          onPress={handleCopy}
          accessibilityLabel="复制"
        >
          <Text style={styles.copyBtnText}>{copied ? '已复制' : '复制'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'column',
    gap: 6,
  },
  content: {
    flexDirection: 'column',
  },
  placeholder: {
    fontSize: 14,
    color: '#9ca3af',
  },
  copyBtn: {
    alignSelf: 'flex-end',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  copyBtnText: {
    fontSize: 12,
    color: '#4b5563',
  },
});
