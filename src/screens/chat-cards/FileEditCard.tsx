import React from 'react';
import { Text, View } from 'react-native';
import { ToolCardFrame } from './ToolCardFrame';

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

export function FileEditCard({
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

  const editSummary =
    hasOldNew && oldStr
      ? oldStr.includes('\n')
        ? `${oldStr.split('\n')[0].slice(0, 40)}…`
        : oldStr.length > 40
          ? `${oldStr.slice(0, 40)}…`
          : oldStr
      : hasOldNew
        ? '(空)'
        : null;

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
            {editSummary !== null ? (
              <Text style={styles.toolCardHeaderEditSummary} numberOfLines={1} ellipsizeMode="tail">
                被替换: {editSummary}
              </Text>
            ) : null}
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

