import React, { useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { parseSearchEngineBlockArgs } from '../../utils/searchEngineParseArgs';
import { ToolCardFrame } from './ToolCardFrame';
import { toolCardPropsEqual } from './toolCardMemo';

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  arguments?: string;
  streaming_content?: string;
  result?: unknown;
  review_id?: string;
};

type CardStyles = Record<string, StyleProp<ViewStyle | TextStyle>>;

type Props = {
  block: ToolBlock;
  cardKey: string;
  viewMode: 'collapsed' | 'preview' | 'full';
  styles: CardStyles;
  getToolStatusLabel: (status: string) => string;
  setToolCardMode: (key: string, mode: 'collapsed' | 'preview' | 'full') => void;
  onSafetyDecision: (reviewId: string, decision: 'approve' | 'reject') => void;
  submittingReviewId: string;
};

const HEADER_QUERIES_MAX = 5;
const COLLAPSED_QUERIES_MAX_LEN = 120;

function formatHeaderQueries(queries: string[]): string {
  const n = queries.length;
  if (n === 0) return 'Searching 0 queries';
  if (n <= HEADER_QUERIES_MAX) {
    return `Searching ${n} ${n === 1 ? 'query' : 'queries'}: ${queries.join(', ')}`;
  }
  const head = queries.slice(0, HEADER_QUERIES_MAX).join(', ');
  return `Searching ${n} queries: ${head}, …`;
}

function formatCollapsedTail(queries: string[]): string {
  if (!queries.length) return '0 queries';
  const joined = queries.join(', ');
  if (joined.length <= COLLAPSED_QUERIES_MAX_LEN) {
    return `${queries.length} queries: ${joined}`;
  }
  return `${queries.length} queries: ${joined.slice(0, COLLAPSED_QUERIES_MAX_LEN - 1)}…`;
}

function SearchEngineCardImpl({
  block,
  cardKey,
  viewMode,
  styles,
  getToolStatusLabel,
  setToolCardMode,
  onSafetyDecision,
  submittingReviewId,
}: Props) {
  const [expandedQueries, setExpandedQueries] = useState<string[]>([]);

  const parsed = parseSearchEngineBlockArgs(block);
  const queries = parsed.queries || [];
  const searchGoal = parsed.search_goal || '';
  const result =
    block.result && typeof block.result === 'object' && !Array.isArray(block.result)
      ? (block.result as Record<string, unknown>)
      : null;
  const mergedResults = Array.isArray(result?.results) ? (result.results as Record<string, unknown>[]) : [];
  const resultsByQuery =
    result?.results_by_query && typeof result.results_by_query === 'object' && !Array.isArray(result.results_by_query)
      ? (result.results_by_query as Record<string, unknown[]>)
      : null;
  const isRunning = block.status === 'running' || block.status === 'pending';
  const errStr = result && typeof result.error === 'string' ? result.error : '';
  const hasError = Boolean(result && errStr && result.success !== true);
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;

  const headerMain = useMemo(() => {
    const n = queries.length;
    if (n === 0 && block.status === 'pending') return 'Searching: …';
    if (n === 0) return 'Searching 0 queries';
    return formatHeaderQueries(queries);
  }, [queries, block.status]);

  const collapsedTail =
    queries.length > 0 ? formatCollapsedTail(queries) : result?.success === false ? '失败' : '…';

  const pickSearchItemFields = (item: Record<string, unknown>) => {
    const title = String(item?.title ?? item?.name ?? '').trim().replace(/\s+/g, ' ') || '（无标题）';
    const url = String(item?.url ?? item?.link ?? '').trim();
    const desc = String(item?.desc ?? item?.description ?? '').trim();
    return { title, url, desc };
  };

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles as Record<string, object>}
      status={block.status}
      collapsedName="Searching"
      collapsedTail={collapsedTail}
      collapsedSuccessStyle="success"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
      hideExpandRow
    >
        <View style={styles.toolCardHeaderRow}>
          <View style={styles.toolCardHeaderMain}>
            <Text style={styles.searchEngineHeaderMain} selectable>{headerMain}</Text>
          </View>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>{getToolStatusLabel(block.status)}</Text>
          </View>
        </View>

        <View style={styles.searchEngineWrap}>
          {queries.length > 0 ? (
            <View style={styles.searchEngineQueriesSection}>
              <View style={styles.searchEngineQueriesLine}>
                <Text style={styles.searchEngineQueriesPrefix}>搜索了</Text>
                {queries.map((q, qi) => {
                  const open = expandedQueries.includes(q);
                  return (
                    <Pressable
                      key={`${qi}-${q}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      onPress={() => {
                        setExpandedQueries((prev) => (prev.includes(q) ? prev.filter((x) => x !== q) : [...prev, q]));
                      }}
                    >
                      <Text style={[styles.searchEngineQueryChip, open && styles.searchEngineQueryChipOpen]} suppressHighlighting>{q}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {queries.map((q, qi) => {
                if (!expandedQueries.includes(q)) return null;
                const raw = resultsByQuery && Array.isArray(resultsByQuery[q]) ? resultsByQuery[q] : [];
                const results = raw.filter((x): x is Record<string, unknown> => x != null && typeof x === 'object');
                if (results.length === 0) return null;
                return (
                  <View key={`ex-${qi}-${q}`} style={styles.searchEngineQueryExpanded}>
                    <View style={styles.searchEnginePerQueryList}>
                      {results.map((item, i) => {
                        const { title, url, desc } = pickSearchItemFields(item);
                        return (
                          <View key={i} style={styles.searchEnginePerQueryItem}>
                            <Text style={styles.searchEnginePerQueryIndex}>{i + 1}.</Text>
                            <View style={styles.searchEnginePerQueryMain}>
                              {url ? (
                                <Pressable onPress={() => Linking.openURL(url)}>
                                  <Text style={styles.searchEnginePerQueryLink}>{title}</Text>
                                </Pressable>
                              ) : (
                                <Text style={styles.searchEnginePerQueryTitle}>{title}</Text>
                              )}
                              {desc ? <Text style={styles.searchEnginePerQueryDesc}>{desc}</Text> : null}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          <View style={styles.searchEngineHero}>
            {hasError ? (
              <Text style={styles.searchEngineError}>{errStr}</Text>
            ) : mergedResults.length > 0 ? (
              <>
                <View style={styles.searchEngineHeroHead}>
                  {searchGoal ? <Text style={styles.searchEngineGoalInline} numberOfLines={1}>精选目标：{searchGoal}</Text> : null}
                  {searchGoal ? <Text style={styles.searchEngineHeroSep}>·</Text> : null}
                  <Text style={styles.searchEngineHeroLabelInline}>AI 精选 {mergedResults.length} 条</Text>
                </View>
                <View style={styles.searchEngineHeroGrid}>
                  {mergedResults.map((item, i) => {
                    const { title, url, desc } = pickSearchItemFields(item);
                    return (
                      <View key={i} style={styles.searchEngineHeroItem}>
                        {url ? (
                          <Pressable onPress={() => Linking.openURL(url)}>
                            <Text style={styles.searchEngineHeroLink} numberOfLines={2}>{title}</Text>
                          </Pressable>
                        ) : (
                          <Text style={styles.searchEngineHeroTitle} numberOfLines={2}>{title}</Text>
                        )}
                        {desc ? <Text style={styles.searchEngineHeroDesc} numberOfLines={2}>{desc}</Text> : null}
                      </View>
                    );
                  })}
                </View>
              </>
            ) : isRunning ? (
              <Text style={styles.searchEngineMuted}>搜索中…</Text>
            ) : (
              <Text style={styles.searchEngineMuted}>暂无精选结果</Text>
            )}
          </View>
        </View>

        {isAwaiting && block.review_id ? (
          <View style={styles.safetyActions}>
            <Pressable style={styles.safetyBtn} onPress={() => onSafetyDecision(block.review_id!, 'reject')} disabled={Boolean(isSubmitting)}>
              <Text style={styles.safetyBtnText}>拒绝</Text>
            </Pressable>
            <Pressable style={[styles.safetyBtn, styles.safetyBtnPrimary]} onPress={() => onSafetyDecision(block.review_id!, 'approve')} disabled={Boolean(isSubmitting)}>
              <Text style={styles.safetyBtnPrimaryText}>{isSubmitting ? '提交中...' : '确认执行'}</Text>
            </Pressable>
          </View>
        ) : null}

        {block.streaming_content ? (
          <Text style={[styles.toolCardBody, styles.toolCardCodeText]} numberOfLines={15} selectable>
            {block.streaming_content}
          </Text>
        ) : null}
    </ToolCardFrame>
  );
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const SearchEngineCard = React.memo(
  SearchEngineCardImpl,
  toolCardPropsEqual<Props>(['block', 'cardKey', 'viewMode', 'styles', 'submittingReviewId'])
);
