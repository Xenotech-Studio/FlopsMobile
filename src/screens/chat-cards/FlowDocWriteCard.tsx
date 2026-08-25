import React from 'react';
import { Text, View } from 'react-native';
import {
  formatFlowDocCardHeaderWithVerb,
  parseWriteDocAsMdArgs,
} from '../../utils/toolCardParsers';
import { useFlowDocItemTitle } from '../../context/FlowDocItemMetaContext';
import { ToolCardFrame } from './ToolCardFrame';
import { toolCardPropsEqual } from './toolCardMemo';

const PREVIEW_MAX = 2000;

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

function FlowDocWriteCardImpl({
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
  const args = parseWriteDocAsMdArgs(block);
  const docTitle = useFlowDocItemTitle(args.docId, conversationId);
  const headerDocLine = formatFlowDocCardHeaderWithVerb('全文写入', docTitle, args.docId);
  const collapsedTail =
    headerDocLine.length > 30 ? `${headerDocLine.slice(0, 28)}…` : headerDocLine || '…';
  const collapsedName = args.docId ? `${block.tool_name} · ${collapsedTail}` : block.tool_name;

  const isFull = viewMode === 'full';
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isStreaming = block.status === 'pending' || block.status === 'running';

  const headerMainText = args.docId ? headerDocLine || args.docId : block.tool_name;

  const mdPreview =
    args.markdown.length > PREVIEW_MAX
      ? `${args.markdown.slice(0, PREVIEW_MAX)}\n… (共 ${args.markdown.length} 字符)`
      : args.markdown;
  const mdFull =
    isFull && args.markdown.length > 2000
      ? `${args.markdown.slice(0, 2000)}\n… (共 ${args.markdown.length} 字符)`
      : mdPreview;

  const writeBody = args.docId ? (
    <View style={styles.toolCardWritePreview}>
      {args.markdown ? (
        <Text style={styles.toolCardDiffPre} selectable>
          {mdFull}
        </Text>
      ) : isStreaming ? (
        <Text style={styles.toolCardBodyMuted}>内容生成中…</Text>
      ) : (
        <Text style={styles.toolCardBodyMuted}>无内容预览</Text>
      )}
    </View>
  ) : block.arguments || block.status === 'pending' || block.status === 'waiting' ? (
    <Text style={styles.toolCardBodyMuted}>等待参数…</Text>
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

      {args.docId && writeBody ? (
        wrapFileToolPreviewBody(isFull, isStreaming, cardKey, writeBody)
      ) : !args.docId && writeBody ? (
        writeBody
      ) : null}

      {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const FlowDocWriteCard = React.memo(
  FlowDocWriteCardImpl,
  toolCardPropsEqual<Props>(['block', 'cardKey', 'viewMode', 'styles', 'isSubmitting', 'conversationId'])
);
