import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { formatFlowDocCardHeaderTitle, parseFlowDocIdFromArgs } from '../../utils/toolCardParsers';
import { useFlowDocItemTitle } from '../../context/FlowDocItemMetaContext';
import { ToolCardFrame } from './ToolCardFrame';

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
  conversationId: string | undefined;
  viewMode: 'collapsed' | 'preview' | 'full';
  styles: Record<string, object>;
  getToolStatusLabel: (status: string) => string;
  setToolCardMode: (key: string, mode: 'collapsed' | 'preview' | 'full') => void;
  renderToolCardSafetyActions: (reviewId: string, isSubmitting: boolean) => React.ReactNode;
  wrapFileToolPreviewBody: (
    isFull: boolean,
    isStreaming: boolean,
    cardKey: string,
    children: React.ReactNode
  ) => React.ReactNode;
  isSubmitting: boolean;
};

export function FlowDocReadCard({
  block,
  cardKey,
  conversationId,
  viewMode,
  styles,
  getToolStatusLabel,
  setToolCardMode,
  renderToolCardSafetyActions,
  wrapFileToolPreviewBody,
  isSubmitting,
}: Props) {
  const docId = parseFlowDocIdFromArgs(block);
  const docTitle = useFlowDocItemTitle(docId, conversationId);
  const headerDocLine = formatFlowDocCardHeaderTitle(docTitle, docId);
  const collapsedTail =
    headerDocLine.length > 36 ? `${headerDocLine.slice(0, 34)}…` : headerDocLine || '…';

  const r = block.result && typeof block.result === 'object' ? (block.result as Record<string, unknown>) : null;
  const md = typeof r?.markdown === 'string' ? r.markdown : '';
  const err = r?.success === false || r?.error;
  const summaryHint =
    !err && md
      ? `${md.length} 字符`
      : typeof r?.message === 'string' && r.message.trim()
        ? r.message.trim()
        : '';

  const isFull = viewMode === 'full';
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isStreaming = block.status === 'pending' || block.status === 'running';

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!md) return;
    Clipboard.setString(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [md]);

  const capPreview = (s: string) => (s.length > 50000 ? `${s.slice(0, 50000)}\n…` : s);
  const mdShow = isFull ? (md.length > 8000 ? `${md.slice(0, 8000)}\n…` : md) : capPreview(md);

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles}
      status={block.status}
      collapsedName="读取文档"
      collapsedTail={collapsedTail}
      collapsedSuccessStyle="success"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
      <View style={styles.toolCardHeaderRow}>
        <View style={styles.toolCardHeaderMain}>
          <Text style={styles.toolCardHeaderFilename} numberOfLines={2} ellipsizeMode="tail">
            读取文档{docId ? ` · ${headerDocLine || docId}` : ''}
            {summaryHint ? `\n${summaryHint}` : ''}
          </Text>
        </View>
        <View style={styles.toolCardBadgeWrap}>
          <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
            {getToolStatusLabel(block.status)}
          </Text>
        </View>
      </View>

      {err ? (
        <Text style={styles.toolCardBodyMuted}>{String(r?.error ?? '失败')}</Text>
      ) : isStreaming ? (
        <Text style={styles.toolCardBodyMuted}>执行中…</Text>
      ) : md ? (
        wrapFileToolPreviewBody(
          isFull,
          false,
          cardKey,
          <View>
            <TouchableOpacity
              onPress={handleCopy}
              accessibilityLabel={copied ? '已复制' : '复制正文'}
              style={{ alignSelf: 'flex-end', padding: 4, marginBottom: 4 }}
            >
              <Ionicons name={copied ? 'checkmark-circle-outline' : 'copy-outline'} size={18} color="#64748b" />
            </TouchableOpacity>
            <Text style={styles.toolCardDiffPre} selectable>
              {mdShow}
            </Text>
          </View>
        )
      ) : null}

      {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}
