/**
 * read_pages 点击小卡片后的详情：与 Task 页筛选同款 BottomSheetModal，
 * 排版和配色与 Web 版一致：顶部大缩略图、原文卡片、摘要/正文/要点/引用/链接。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Image,
  Platform,
  useWindowDimensions,
} from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL } from '../theme/typography';
import { tryParsePartialReadingStream } from '../utils/toolCardParsers';

export type ReadPagesDetailEntry = Record<string, unknown>;

type ReadPagesDetailSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** 展示用标题（已解码） */
  title: string;
  entry: ReadPagesDetailEntry | null;
};

export function ReadPagesDetailSheet({
  visible,
  onClose,
  title,
  entry,
}: ReadPagesDetailSheetProps) {
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
        opacity={0.35}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    []
  );

  const { height: windowHeight } = useWindowDimensions();
  const heroHeight = Math.min(Math.max(windowHeight * 0.34, 130), 260);

  if (!entry) return null;

  const r = entry;
  const partial =
    typeof r.llm_raw === 'string' && (r.llm_raw as string).trim()
      ? tryParsePartialReadingStream(r.llm_raw as string)
      : null;
  const summary = r.summary && typeof r.summary === 'object' ? (r.summary as Record<string, unknown>) : null;
  const brief = (summary && typeof summary.brief === 'string' ? summary.brief : '') || (partial?.summary?.brief ?? '');
  const takeover = r.takeaway && typeof r.takeaway === 'object' ? (r.takeaway as Record<string, unknown>) : null;
  const answersFin = takeover && Array.isArray(takeover.answers) ? (takeover.answers as string[]) : [];
  const quotesFin = takeover && Array.isArray(takeover.quotes) ? (takeover.quotes as string[]) : [];
  const answers = answersFin.length ? answersFin : (partial?.takeaway?.answers ?? []);
  const quotes = quotesFin.length ? quotesFin : (partial?.takeaway?.quotes ?? []);
  const links = Array.isArray(r.links) ? r.links : [];
  const content = typeof r.content === 'string' ? r.content : typeof r.text === 'string' ? r.text : '';
  const errorMsg = r.error && typeof r.error === 'string' ? (r.error as string) : '';
  const urlStr = typeof r.url === 'string' ? r.url : '';
  const previewUrl =
    typeof r.page_preview_data_url === 'string' && r.page_preview_data_url.startsWith('data:image/')
      ? (r.page_preview_data_url as string)
      : '';

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
        <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
        <TouchableOpacity onPress={onClose} style={styles.doneBtnWrap} activeOpacity={0.7}>
          <Text style={styles.doneBtn}>{Platform.OS === 'android' ? '关闭' : '完成'}</Text>
        </TouchableOpacity>
      </View>
      <BottomSheetScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: 48 }]}>
        {/* 与 Web 一致：首屏大缩略图（有图铺满，无图占位「暂无页面截图」） */}
        <View style={[styles.heroWrap, { height: heroHeight }]}>
          {previewUrl ? (
            <Image
              source={{ uri: previewUrl }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.heroEmpty}>
              <Text style={styles.heroEmptyText}>
                {urlStr ? '暂无页面截图' : '无链接预览'}
              </Text>
            </View>
          )}
        </View>

        {/* 缩略图下方：原文卡片（与 Web flops-read-pages-modal-source-card 一致） */}
        {urlStr ? (
          <TouchableOpacity
            style={styles.sourceCard}
            onPress={() => Linking.openURL(urlStr)}
            activeOpacity={0.85}
          >
            <Text style={styles.sourceCardPrefix}>原文</Text>
            <Text style={styles.sourceCardUrl} numberOfLines={1}>
              {urlStr.length > 68 ? `${urlStr.slice(0, 66)}…` : urlStr}
            </Text>
            <Ionicons name="chevron-forward" size={15} color="#9ca3af" />
          </TouchableOpacity>
        ) : (
          <View style={styles.sourceCardDisabled}>
            <Text style={styles.sourceCardPrefix}>原文</Text>
            <Text style={styles.sourceCardUrlMuted}>无链接</Text>
          </View>
        )}

        {errorMsg ? (
          <View style={styles.section}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        ) : null}

        {brief ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>摘要</Text>
            <View style={styles.articleCard}>
              <Text style={styles.bodyText} selectable>
                {brief}
              </Text>
            </View>
          </View>
        ) : null}

        {content ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>正文</Text>
            <View style={styles.articleCard}>
              <Text style={styles.bodyText} selectable>
                {content}
              </Text>
            </View>
          </View>
        ) : null}

        {answers.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>要点</Text>
            <View style={styles.articleCard}>
              {answers.map((a, i) => (
                <View key={i} style={[styles.bulletRow, i > 0 && styles.bulletRowSpacer]}>
                  <Text style={styles.bullet}>•</Text>
                  <Text style={styles.bulletText} selectable>
                    {a}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {quotes.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>引用</Text>
            <View style={styles.articleCard}>
              {quotes.map((q, i) => (
                <View key={i} style={styles.quoteBlock}>
                  <Text style={styles.quoteText} selectable>
                    {q}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {links.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>相关链接</Text>
            <View style={styles.articleCard}>
              {links.slice(0, 20).map((l: unknown, i: number) => {
                if (!l || typeof l !== 'object') return null;
                const ll = l as Record<string, unknown>;
                const u = typeof ll.url === 'string' ? ll.url : typeof ll.href === 'string' ? ll.href : '';
                const label = typeof ll.title === 'string' ? ll.title : u || '';
                if (!u && !label) return null;
                return (
                  <TouchableOpacity
                    key={i}
                    style={[styles.linkRow, i > 0 && styles.linkRowBorder]}
                    onPress={() => u && Linking.openURL(u)}
                    activeOpacity={0.7}
                    disabled={!u}
                  >
                    <Ionicons name="link" size={16} color={u ? '#667eea' : '#9ca3af'} />
                    <Text style={[styles.linkLabel, !u && styles.linkLabelMuted]} numberOfLines={1}>
                      {label || u}
                    </Text>
                    {u ? <Ionicons name="chevron-forward" size={14} color="#9ca3af" /> : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  sheetBg: { backgroundColor: '#fafafa', borderTopLeftRadius: 32, borderTopRightRadius: 32 },
  sheetShadow: { ...shadowSheet },
  handle: { backgroundColor: '#c7c7cc', width: 36 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: '#fafafa',
  },
  title: {
    flex: 1,
    fontSize: TASK_FONT_SIZE_BODY,
    fontWeight: '600',
    color: '#333',
    marginRight: 12,
    minWidth: 0,
  },
  doneBtnWrap: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#e8e8ed',
    borderRadius: 22,
  },
  doneBtn: { fontSize: 16, fontWeight: '600', color: '#111827' },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: '#fafafa' },
  heroWrap: {
    width: '100%',
    minHeight: 130,
    backgroundColor: '#dedede',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#b0b0b0',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3 },
      android: { elevation: 2 },
    }),
  },
  heroEmpty: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#e0e0e0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroEmptyText: { fontSize: 14, color: '#666' },
  sourceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ebebeb',
    backgroundColor: '#f7f7f7',
  },
  sourceCardDisabled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#eaeaea',
    backgroundColor: '#f5f5f5',
  },
  sourceCardPrefix: { fontSize: 12, color: '#888', fontWeight: '500' },
  sourceCardUrl: { flex: 1, fontSize: 13, color: '#333', minWidth: 0 },
  sourceCardUrlMuted: { flex: 1, fontSize: 13, color: '#9ca3af', minWidth: 0 },
  section: { marginTop: 20 },
  sectionLabel: {
    fontSize: TASK_FONT_SIZE_SMALL,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  articleCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: '#ebebeb',
  },
  errorText: { fontSize: TASK_FONT_SIZE_BODY, color: '#c00' },
  bodyText: { fontSize: TASK_FONT_SIZE_BODY, color: '#333', lineHeight: 24 },
  bulletRow: { flexDirection: 'row', gap: 8 },
  bulletRowSpacer: { marginTop: 10 },
  bullet: { fontSize: TASK_FONT_SIZE_BODY, color: '#6b7280' },
  bulletText: { flex: 1, fontSize: TASK_FONT_SIZE_BODY, color: '#111827', lineHeight: 22, minWidth: 0 },
  quoteBlock: {
    marginTop: 12,
    paddingLeft: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#e5e7eb',
  },
  quoteText: { fontSize: TASK_FONT_SIZE_BODY, color: '#4b5563', fontStyle: 'italic', lineHeight: 22 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  linkRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e5e7eb' },
  linkLabel: { flex: 1, fontSize: TASK_FONT_SIZE_BODY, color: '#667eea', minWidth: 0 },
  linkLabelMuted: { color: '#9ca3af' },
});
