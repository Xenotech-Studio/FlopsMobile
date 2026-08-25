import React from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import {
  parseReadPagesBlockArgs,
  readPagesResultEntryCount,
  readPagesFinishedCount,
  readPagesSuccessStats,
  readPagesReadingEntries,
  decodeUrlPctForDisplay,
  getReadPagesListSortBucket,
  tryParsePartialReadingStream,
} from '../../utils/toolCardParsers';
import { ToolCardFrame } from './ToolCardFrame';
import { toolCardPropsEqual } from './toolCardMemo';

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  arguments?: string;
  result?: unknown;
  review_id?: string;
};

type Props = {
  block: ToolBlock;
  cardKey: string;
  styles: Record<string, object>;
  setToolCardMode: (key: string, mode: 'collapsed' | 'preview' | 'full') => void;
  renderToolCardSafetyActions: (reviewId: string, isSubmitting: boolean) => React.ReactNode;
  onOpenEntry: (entryKey: string, entry: Record<string, unknown>) => void;
  getToolStatusLabel: (status: string) => string;
  viewMode: 'collapsed' | 'preview' | 'full';
  isSubmitting: boolean;
  renderHeaderLoadBar: () => React.ReactNode;
};

function readPagesPageCount(block: ToolBlock, parsed: { urls: string[] }): number {
  const fromResult = readPagesResultEntryCount(block.result);
  const fromArgs = parsed.urls.length;
  return Math.max(fromArgs, fromResult) || fromArgs || fromResult || 0;
}

function readPagesTitleLine(block: ToolBlock, parsed: { goal: string; urls: string[] }): string {
  const isPreparingArgs = block.status === 'pending';
  if (isPreparingArgs) {
    const q = parsed.goal.trim() || '…';
    return q !== '…'
      ? `Reading preparing: ${q}`
      : parsed.urls.length > 0
        ? `Reading preparing…（${parsed.urls.length} 个链接见下方）`
        : 'Reading preparing…';
  }
  const n = readPagesPageCount(block, parsed);
  const goal = parsed.goal.trim() || '—';
  const isCompleted = block.status === 'completed';
  if (isCompleted) {
    let { total, success } = readPagesSuccessStats(block.result);
    if (total === 0 && parsed.urls.length > 0) {
      total = parsed.urls.length;
      success = 0;
    }
    if (total > 0) {
      const pageWord = total === 1 ? 'page' : 'pages';
      const statusPart = success === total ? '(all success)' : `(${success} success)`;
      return `Read ${total} ${pageWord} ${statusPart}: ${goal}`;
    }
  }
  const total = n;
  const done = readPagesFinishedCount(block.result);
  const pageWord = total === 1 ? 'page' : 'pages';
  const prefix = total > 0 ? `Reading ${done}/${total} ${pageWord}:` : `Reading ${n} ${n === 1 ? 'page' : 'pages'}:`;
  return `${prefix} ${goal}`;
}

function readPagesCollapsedTail(block: ToolBlock, parsed: { goal: string; urls: string[] }): string {
  const isPreparingArgs = block.status === 'pending';
  if (isPreparingArgs) {
    const g = parsed.goal.trim();
    const t = g ? (g.slice(0, 48) + (g.length > 48 ? '…' : '')) : (parsed.urls.length > 0 ? `${parsed.urls.length} links` : '…');
    return `prep · ${t}`;
  }
  const g = parsed.goal.slice(0, 36);
  if (block.status === 'completed') {
    let { total, success } = readPagesSuccessStats(block.result);
    if (total === 0 && parsed.urls.length > 0) {
      total = parsed.urls.length;
      success = 0;
    }
    if (total > 0) {
      const head = success === total ? `${total}p all` : `${success}/${total}p`;
      return `${head}${g ? ` · ${g}` : ''}${parsed.goal.length > 36 ? '…' : ''}`;
    }
  }
  const n = readPagesPageCount(block, parsed);
  const total = n;
  const done = readPagesFinishedCount(block.result);
  const head = total > 0 ? `${done}/${total}p` : `${n}p`;
  return `${head}${g ? ` · ${g}` : ''}${parsed.goal.length > 36 ? '…' : ''}`;
}

function ReadPagesCardImpl({
  block,
  cardKey,
  styles,
  setToolCardMode,
  renderToolCardSafetyActions,
  onOpenEntry,
  getToolStatusLabel,
  viewMode,
  isSubmitting,
  renderHeaderLoadBar,
}: Props) {
  const parsed = parseReadPagesBlockArgs(block);
  const isPreparingArgs = block.status === 'pending';
  const hasReadings = readPagesResultEntryCount(block.result) > 0;
  const entries = readPagesReadingEntries(block.result).map(([urlKey, r]) => ({ key: urlKey, r }));

  const collapsedTail = readPagesCollapsedTail(block, parsed);

  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const titleLine = readPagesTitleLine(block, parsed);
  const urlOrderOf = (key: string) => {
    const i = parsed.urls.indexOf(key);
    return i >= 0 ? i : 999999;
  };
  const sortedEntries = entries
    .map((e, index) => ({ ...e, index, urlOrder: urlOrderOf(e.key) }))
    .sort((a, b) => {
      const ba = getReadPagesListSortBucket(a.r);
      const bb = getReadPagesListSortBucket(b.r);
      if (ba !== bb) return ba - bb;
      return a.urlOrder !== b.urlOrder ? a.urlOrder - b.urlOrder : a.index - b.index;
    });

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles}
      status={block.status}
      collapsedName="Reading"
      collapsedTail={collapsedTail}
      collapsedSuccessStyle="none"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
      hideExpandRow
    >
        <Text style={styles.toolCardHeader} numberOfLines={1} ellipsizeMode="tail">
          {titleLine}
        </Text>

        {isPreparingArgs ? (
          <View style={styles.readPagesUrlListWrap}>
            {parsed.urls.length === 0 ? (
              <Text style={styles.toolCardSafetyMeta}>（尚未解析到 URL，参数生成完成后将列出）</Text>
            ) : (
              parsed.urls.map((u) => (
                <Pressable key={u} onPress={() => Linking.openURL(u)} style={styles.readPagesUrlItem}>
                  <Text style={styles.readPagesUrlLink} numberOfLines={1}>{u}</Text>
                  <Ionicons name="open-outline" size={14} color="#64748b" />
                </Pressable>
              ))
            )}
          </View>
        ) : hasReadings ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.readPagesCardsScroll}
            style={styles.readPagesCardsScrollView}
          >
            {sortedEntries.map(({ key: ek, r }, i) => {
              const title = decodeUrlPctForDisplay(String(r.title || r.url || ek || `页面 ${i + 1}`));
              const loading = r.loading === true;
              const previewOk = typeof r.page_preview_data_url === 'string' && r.page_preview_data_url.startsWith('data:image/');
              const llmStarted = typeof r.llm_raw === 'string' && (r.llm_raw as string).trim().length > 0;
              const phase = typeof r.phase === 'string' ? r.phase : '';
              const showThumb = Boolean(loading && previewOk && !llmStarted);
              const showSpinner = loading && !showThumb && (phase === 'opening' || (phase === 'page_preview' && !previewOk));
              const error = typeof r.error === 'string' ? r.error : '';
              const partial = typeof r.llm_raw === 'string' && (r.llm_raw as string).trim() ? tryParsePartialReadingStream(r.llm_raw as string) : null;
              const summary = r.summary && typeof r.summary === 'object' ? (r.summary as Record<string, unknown>) : null;
              const brief = (summary && typeof summary.brief === 'string' ? summary.brief : '') || (partial?.summary?.brief ?? '');
              const takeover = r.takeaway && typeof r.takeaway === 'object' ? (r.takeaway as Record<string, unknown>) : null;
              const answersFin = takeover && Array.isArray(takeover.answers) ? (takeover.answers as string[]).filter((x) => x != null && String(x).trim()).slice(0, 4) : [];
              const quotesFin = takeover && Array.isArray(takeover.quotes) ? (takeover.quotes as string[]).filter((x) => x != null && String(x).trim()).slice(0, 4) : [];
              const answers = answersFin.length ? answersFin : (partial?.takeaway?.answers ?? []).slice(0, 4);
              const quotes = quotesFin.length ? quotesFin : (partial?.takeaway?.quotes ?? []).slice(0, 4);
              const urlStr = typeof r.url === 'string' ? r.url : '';
              const hasPartialLayout = Boolean(brief || answers.length || quotes.length);
              const loadBarThumbWait = Boolean(loading && previewOk && !llmStarted);
              const showCardHeaderLoadBar = hasPartialLayout || loadBarThumbWait;

              return (
                <Pressable
                  key={ek}
                  style={styles.readPagesSmallCard}
                  onPress={() => onOpenEntry(ek, r)}
                >
                  <View style={[styles.readPagesSmallCardHeader, loading && showCardHeaderLoadBar && styles.readPagesSmallCardHeaderStreaming]}>
                    <Text style={styles.readPagesSmallCardTitle} numberOfLines={1} ellipsizeMode="tail">{title}</Text>
                    {urlStr ? (
                      <Pressable onPress={(e) => { e.stopPropagation(); Linking.openURL(urlStr); }} hitSlop={8}>
                        <Ionicons name="open-outline" size={14} color="#64748b" />
                      </Pressable>
                    ) : null}
                    {loading && showCardHeaderLoadBar ? renderHeaderLoadBar() : null}
                  </View>
                  <View style={styles.readPagesSmallCardBodyWrap}>
                    {showThumb && r.page_preview_data_url ? (
                      <View style={styles.readPagesCardSquare}>
                        <Image source={{ uri: r.page_preview_data_url as string }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                      </View>
                    ) : showSpinner ? (
                      <View style={[styles.readPagesCardSquare, styles.readPagesCardSquareCenter]}>
                        <ActivityIndicator size="small" color="#64748b" />
                      </View>
                    ) : (
                      <ScrollView
                        style={[styles.readPagesCardSquare, styles.readPagesCardSquareBody]}
                        contentContainerStyle={styles.readPagesCardBodyScroll}
                        showsVerticalScrollIndicator={true}
                      >
                        {error ? (
                          <Text style={styles.readPagesErrorText} numberOfLines={5}>{error}</Text>
                        ) : brief || answers.length || quotes.length ? (
                          <>
                            {brief ? <Text style={styles.readPagesTextBlock}>{brief}</Text> : null}
                            {answers.length ? <Text style={styles.readPagesTextBlock}>要点: {answers.join('；')}</Text> : null}
                            {quotes.length ? <Text style={styles.readPagesTextBlock}>引用: {quotes.join('；')}</Text> : null}
                          </>
                        ) : loading ? (
                          <Text style={styles.toolCardSafetyMeta}>模型输出中…</Text>
                        ) : (
                          <Text style={styles.toolCardSafetyMeta}>无正文或结构化摘要。</Text>
                        )}
                      </ScrollView>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : parsed.urls.length > 0 ? (
          <View>
            <View style={styles.readPagesUrlListWrap}>
              {parsed.urls.map((u) => (
                <Pressable key={u} onPress={() => Linking.openURL(u)} style={styles.readPagesUrlItem}>
                  <Text style={styles.readPagesUrlLink} numberOfLines={1}>{u}</Text>
                  <Ionicons name="open-outline" size={14} color="#64748b" />
                </Pressable>
              ))}
            </View>
            <Text style={styles.toolCardSafetyMeta}>
              {block.status === 'waiting' ? '等待执行…' : '阅读中，摘要将随后显示…'}
            </Text>
          </View>
        ) : (
          <Text style={styles.toolCardSafetyMeta}>
            {block.result == null ? '暂无结果' : '结果结构未知（请检查 JSON）'}
          </Text>
        )}

        {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const ReadPagesCard = React.memo(
  ReadPagesCardImpl,
  toolCardPropsEqual<Props>(['block', 'cardKey', 'viewMode', 'styles', 'isSubmitting'])
);
