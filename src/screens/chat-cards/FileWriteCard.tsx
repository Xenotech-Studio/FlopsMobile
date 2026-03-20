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
  content?: string;
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

export function FileWriteCard({
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

  const content = fileArgs.content ?? '';
  const contentDisplay =
    isFull && content.length > 2000
      ? `${content.slice(0, 2000)}\n… (共 ${content.length} 字符)`
      : content.length > 50000
        ? `${content.slice(0, 50000)}\n…`
        : content;

  const hasPath = Boolean(fileArgs.pathDisplay);
  const waitingPathOrArgs =
    !hasPath && (block.arguments || block.status === 'pending' || block.status === 'waiting')
      ? fileArgs.pathDisplay
        ? '参数解析中…'
        : '等待参数…'
      : null;
  const noContentHint =
    hasPath && !content
      ? isStreaming
        ? '内容生成中…'
        : '无内容预览'
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
          </View>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
              {getToolStatusLabel(block.status)}
            </Text>
          </View>
        </View>

        {waitingPathOrArgs ? <Text style={styles.toolCardBodyMuted}>{waitingPathOrArgs}</Text> : null}
        {noContentHint ? <Text style={styles.toolCardBodyMuted}>{noContentHint}</Text> : null}
        {hasPath && content
          ? wrapFileToolPreviewBody(
              isFull,
              isStreaming,
              cardKey,
              <View style={styles.toolCardWritePreview}>
                <Text
                  style={[styles.toolCardBody, styles.toolCardDiffPre, styles.toolCardWritePreviewText]}
                  selectable
                >
                  {contentDisplay}
                </Text>
              </View>
            )
          : null}

        {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}

