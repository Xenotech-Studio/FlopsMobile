import React from 'react';
import { Text, View } from 'react-native';
import {
  formatFlowDocCardHeaderWithVerb,
  parsePatchDocAsMdArgs,
} from '../../utils/toolCardParsers';
import { useFlowDocItemTitle } from '../../context/FlowDocItemMetaContext';
import { ToolCardFrame } from './ToolCardFrame';

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  arguments?: string;
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

export function FlowDocPatchCard({
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
  const args = parsePatchDocAsMdArgs(block);
  const docTitle = useFlowDocItemTitle(args.docId, conversationId);
  const headerDocLine = formatFlowDocCardHeaderWithVerb('批量编辑', docTitle, args.docId);
  const collapsedTail =
    headerDocLine.length > 30 ? `${headerDocLine.slice(0, 28)}…` : headerDocLine || '…';
  const collapsedName = args.docId ? `${block.tool_name} · ${collapsedTail}` : block.tool_name;

  const isFull = viewMode === 'full';
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isStreaming = block.status === 'pending' || block.status === 'running';

  const capPreview = (s: string) => (s.length > 50000 ? `${s.slice(0, 50000)}\n…` : s);
  const trimSide = (s: string) =>
    isFull ? (s.length > 8000 ? `${s.slice(0, 8000)}\n…` : s) : capPreview(s);

  const headerMainText = args.docId ? headerDocLine || args.docId : block.tool_name;

  const bodyStack =
    args.edits.length > 0 ? (
      <View>
        {args.edits.map((ed, i) => (
          <View key={i} style={{ marginTop: i === 0 ? 0 : 12 }}>
            <View style={[styles.toolCardDiff, styles.toolCardDiffPreview]}>
            <View style={[styles.toolCardDiffSide, styles.toolCardDiffOld]}>
              <Text style={styles.toolCardDiffLabel}>
                替换 {i + 1}（前）{ed.replaceAll ? ' · 全部' : ''}
              </Text>
              <Text style={styles.toolCardDiffPre} selectable>
                {trimSide(ed.oldString || '(无)')}
              </Text>
            </View>
            <View style={styles.toolCardDiffSide}>
              <Text style={styles.toolCardDiffLabel}>替换 {i + 1}（后）</Text>
              <Text style={styles.toolCardDiffPre} selectable>
                {trimSide(ed.newString || '(空)')}
              </Text>
            </View>
            </View>
          </View>
        ))}
      </View>
    ) : null;

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles}
      status={block.status}
      collapsedName={collapsedName}
      collapsedSuccessStyle="success"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
      <View style={styles.toolCardHeaderRow}>
        <View style={styles.toolCardHeaderMain}>
          <Text
            style={args.docId ? styles.toolCardHeaderFilename : styles.toolCardHeaderFilenamePlaceholder}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {headerMainText}
          </Text>
        </View>
        <View style={styles.toolCardBadgeWrap}>
          <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
            {getToolStatusLabel(block.status)}
          </Text>
        </View>
      </View>

      {bodyStack ? (
        wrapFileToolPreviewBody(isFull, isStreaming, cardKey, bodyStack)
      ) : block.arguments || block.status === 'pending' || block.status === 'waiting' ? (
        <Text style={styles.toolCardBodyMuted}>{args.docId ? '参数解析中…' : '等待参数…'}</Text>
      ) : null}

      {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}
