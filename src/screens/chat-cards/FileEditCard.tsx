import React from 'react';
import { Text, View } from 'react-native';
import { ToolCardFrame } from './ToolCardFrame';
import { toolCardPropsEqual } from './toolCardMemo';

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  arguments?: string;
  review_id?: string;
};

type FileArgs = {
  pathDisplay?: string;
  oldString?: string;
  newString?: string;
};

type Props = {
  block: ToolBlock;
  cardKey: string;
  fileArgs: FileArgs;
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

function FileEditCardImpl({
  block,
  cardKey,
  fileArgs,
  viewMode,
  styles,
  getToolStatusLabel,
  setToolCardMode,
  renderToolCardSafetyActions,
  wrapFileToolPreviewBody,
  isSubmitting,
}: Props) {
  const collapsedLabel = fileArgs.pathDisplay || '等待参数…';

  const isFull = viewMode === 'full';
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isStreaming = block.status === 'pending' || block.status === 'running';

  const oldStr = fileArgs.oldString || '';
  const newStr = fileArgs.newString || '';
  const hasOldNew = Boolean(oldStr || newStr);
  const capPreview = (s: string) => (s.length > 50000 ? `${s.slice(0, 50000)}\n…` : s);
  const oldTrim = isFull ? (oldStr.length > 8000 ? `${oldStr.slice(0, 8000)}\n…` : oldStr) : capPreview(oldStr);
  const newTrim = isFull ? (newStr.length > 8000 ? `${newStr.slice(0, 8000)}\n…` : newStr) : capPreview(newStr);

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles}
      status={block.status}
      collapsedName={collapsedLabel}
      collapsedSuccessStyle="success"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
        <View style={styles.toolCardHeaderRow}>
          <View style={styles.toolCardHeaderMain}>
            <Text
              style={fileArgs.pathDisplay ? styles.toolCardHeaderFilename : styles.toolCardHeaderFilenamePlaceholder}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {fileArgs.pathDisplay || '等待路径…'}
            </Text>
          </View>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
              {getToolStatusLabel(block.status)}
            </Text>
          </View>
        </View>

        {hasOldNew ? (
          wrapFileToolPreviewBody(
            isFull,
            isStreaming,
            cardKey,
            <View style={[styles.toolCardDiff, styles.toolCardDiffPreview]}>
              <View style={[styles.toolCardDiffSide, styles.toolCardDiffOld]}>
                <Text style={styles.toolCardDiffLabel}>替换前</Text>
                <Text style={styles.toolCardDiffPre} selectable>
                  {oldTrim || '(无)'}
                </Text>
              </View>
              <View style={styles.toolCardDiffSide}>
                <Text style={styles.toolCardDiffLabel}>替换后</Text>
                <Text style={styles.toolCardDiffPre} selectable>
                  {newTrim || '(空)'}
                </Text>
              </View>
            </View>
          )
        ) : (block.arguments || block.status === 'pending' || block.status === 'waiting') ? (
          <Text style={styles.toolCardBodyMuted}>
            {fileArgs.pathDisplay ? '参数解析中…' : '等待参数…'}
          </Text>
        ) : null}

        {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const FileEditCard = React.memo(
  FileEditCardImpl,
  toolCardPropsEqual<Props>(['block', 'cardKey', 'viewMode', 'styles', 'isSubmitting'])
);
