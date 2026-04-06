/**
 * 上下文摘要详情：与 UsageDetailModal / ModelSelectSheet 同款 Bottom Sheet（顶栏、分隔线、滚动区）。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import type { ContextSummary, ConversationMessage } from '../api';
import { MarkdownContent } from './MarkdownContent';
import { getCompressedRegionLastMessagePreview } from '../utils/contextCompress';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY } from '../theme/typography';
import { useAppTheme } from '../context/ThemeContext';

type Props = {
  visible: boolean;
  onClose: () => void;
  activeSummary: ContextSummary;
  rawMessages: ConversationMessage[];
};

export function ContextCompressSummaryModal({ visible, onClose, activeSummary, rawMessages }: Props) {
  const { colors } = useAppTheme();
  const modalRef = useRef<BottomSheetModal>(null);

  useEffect(() => {
    if (visible) modalRef.current?.present();
    else modalRef.current?.dismiss();
  }, [visible]);

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose]
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={colors.bottomSheetBackdropOpacity}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    [colors.bottomSheetBackdropOpacity]
  );

  const e = activeSummary?.covers_exclusive_end;
  const ei = typeof e === 'number' && Number.isFinite(e) ? Math.floor(e) : 0;
  const summaryText = String(activeSummary?.summary_text || '').trim();
  const snippetPreview = getCompressedRegionLastMessagePreview(rawMessages, e);

  return (
    <BottomSheetModal
      ref={modalRef}
      snapPoints={['50%', '90%']}
      index={0}
      onChange={handleSheetChanges}
      onDismiss={onClose}
      enablePanDownToClose
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={[styles.sheetBg, styles.sheetShadow]}
      handleIndicatorStyle={styles.handle}
    >
      <View style={styles.header}>
        <View style={styles.headerTextCol}>
          <Text style={styles.title} accessibilityRole="header">
            摘要
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} style={styles.cancelBtn} activeOpacity={0.7}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
      </View>
      <View
        style={{
          height: colors.headerBarBottomBorderWidth,
          backgroundColor: colors.headerBarBottomBorderColor,
        }}
      />
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.rangeBox}>
          {ei > 0 ? (
            <View
              style={styles.rangeLineRow}
              accessibilityLabel={
                snippetPreview
                  ? `摘要范围：前 ${ei} 条 · 至「${snippetPreview}」`
                  : `摘要范围：前 ${ei} 条 · 至（无文本）`
              }
              accessible
            >
              <Text style={styles.rangeFixed} numberOfLines={1}>
                摘要范围：前{' '}
              </Text>
              <Text style={[styles.mono, styles.rangeFixed]} numberOfLines={1}>
                {ei}
              </Text>
              <Text style={styles.rangeFixed} numberOfLines={1}>
                {' '}
                条 · 至
              </Text>
              {snippetPreview ? (
                <>
                  <Text style={styles.rangeFixed} numberOfLines={1}>
                    「
                  </Text>
                  <View style={styles.rangeSnippetFlex}>
                    <Text
                      style={styles.rangeSnippetText}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {snippetPreview}
                    </Text>
                  </View>
                  <Text style={styles.rangeFixed} numberOfLines={1}>
                    」
                  </Text>
                </>
              ) : (
                <Text style={[styles.rangeMutedInline, styles.rangeFixed]} numberOfLines={1}>
                  （无文本）
                </Text>
              )}
            </View>
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
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  sheetBg: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
  },
  sheetShadow: { ...shadowSheet },
  handle: { backgroundColor: '#c7c7cc', width: 36 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 8,
  },
  headerTextCol: {
    flex: 1,
    minWidth: 0,
  },
  title: { fontSize: TASK_FONT_SIZE_BODY, fontWeight: '600', color: '#111827' },
  cancelBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  cancelText: { fontSize: TASK_FONT_SIZE_BODY, color: '#111827' },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 48,
    backgroundColor: '#fff',
  },
  rangeBox: {
    marginBottom: 12,
    minWidth: 0,
  },
  /** 与 Web .context-compress-meta-range-line：单行、预览段省略 */
  rangeLineRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    width: '100%',
    minWidth: 0,
    flexWrap: 'nowrap',
  },
  rangeFixed: {
    flexShrink: 0,
    fontSize: 11,
    lineHeight: 15,
    color: '#737373',
  },
  rangeSnippetFlex: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
  },
  rangeSnippetText: {
    fontSize: 11,
    lineHeight: 15,
    color: '#737373',
  },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
    color: '#525252',
  },
  rangeMutedInline: {
    fontSize: 11,
    lineHeight: 15,
    color: '#a3a3a3',
  },
  muted: {
    fontSize: TASK_FONT_SIZE_BODY,
    color: '#9ca3af',
  },
  summaryMarkdown: {
    marginTop: 4,
  },
});
