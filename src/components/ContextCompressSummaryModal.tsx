import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
} from 'react-native';
import type { ContextSummary, ConversationMessage } from '../api';
import { MarkdownContent } from './MarkdownContent';
import { getCompressedRegionLastMessagePreview } from '../utils/contextCompress';

type Props = {
  visible: boolean;
  onClose: () => void;
  activeSummary: ContextSummary;
  rawMessages: ConversationMessage[];
};

export function ContextCompressSummaryModal({ visible, onClose, activeSummary, rawMessages }: Props) {
  const e = activeSummary?.covers_exclusive_end;
  const ei = typeof e === 'number' && Number.isFinite(e) ? Math.floor(e) : 0;
  const summaryText = String(activeSummary?.summary_text || '').trim();
  const createdAt = activeSummary?.created_at ? String(activeSummary.created_at) : '';
  const sid = activeSummary?.id ? String(activeSummary.id) : '';
  const metaTitle = [sid && `id ${sid}`, createdAt].filter(Boolean).join(' · ');
  const snippetPreview = getCompressedRegionLastMessagePreview(rawMessages, e);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(ev) => ev.stopPropagation()}>
          <View style={styles.header}>
            <View style={styles.headerTextCol}>
              <Text style={styles.title} accessibilityRole="header">
                摘要
              </Text>
              {metaTitle ? (
                <Text style={styles.metaSubtitle} numberOfLines={2}>
                  {metaTitle}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeBtn}
              accessibilityLabel="关闭"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent}>
            <View style={styles.rangeBox}>
              {ei > 0 ? (
                <Text style={styles.rangeText}>
                  摘要范围：前 <Text style={styles.mono}>{ei}</Text> 条 · 至
                  {snippetPreview ? (
                    <>
                      <Text style={styles.rangeText}>「</Text>
                      <Text style={styles.snippet} numberOfLines={3}>
                        {snippetPreview}
                      </Text>
                      <Text style={styles.rangeText}>」</Text>
                    </>
                  ) : (
                    <Text style={styles.muted}>（无文本）</Text>
                  )}
                </Text>
              ) : (
                <Text style={styles.muted}>—</Text>
              )}
            </View>
            <View style={styles.summaryMarkdown}>
              {summaryText ? (
                <MarkdownContent text={summaryText} />
              ) : (
                <Text style={styles.muted}>（空）</Text>
              )}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  sheet: {
    maxHeight: '88%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.2,
        shadowRadius: 24,
      },
      android: { elevation: 12 },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    gap: 8,
  },
  headerTextCol: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
  },
  metaSubtitle: {
    marginTop: 4,
    fontSize: 12,
    color: '#9ca3af',
  },
  closeBtn: {
    marginLeft: 8,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  closeText: {
    fontSize: 28,
    lineHeight: 30,
    color: '#6b7280',
  },
  bodyScroll: {
    maxHeight: 480,
  },
  bodyContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: 24,
  },
  rangeBox: {
    marginBottom: 12,
  },
  rangeText: {
    fontSize: 14,
    color: '#374151',
    lineHeight: 22,
  },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 14,
    color: '#111827',
  },
  snippet: {
    fontSize: 14,
    color: '#4b5563',
    lineHeight: 22,
  },
  muted: {
    fontSize: 14,
    color: '#9ca3af',
  },
  summaryMarkdown: {
    marginTop: 4,
  },
});
