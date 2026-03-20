import React from 'react';
import { Text } from 'react-native';
import { ToolCardFrame } from './ToolCardFrame';

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  arguments?: string;
  result?: unknown;
  streaming_content?: string;
  review_id?: string;
};

type Props = {
  block: ToolBlock;
  cardKey: string;
  viewMode: 'collapsed' | 'preview' | 'full';
  styles: Record<string, object>;
  getToolStatusLabel: (status: string) => string;
  setToolCardMode: (key: string, mode: 'collapsed' | 'preview' | 'full') => void;
  renderToolCardSafetyActions: (reviewId: string, isSubmitting: boolean) => React.ReactNode;
  isSubmitting: boolean;
};

export function DefaultToolCard({
  block,
  cardKey,
  viewMode,
  styles,
  getToolStatusLabel,
  setToolCardMode,
  renderToolCardSafetyActions,
  isSubmitting,
}: Props) {
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isFull = viewMode === 'full';
  const statusLabel =
    block.status === 'completed'
      ? '成功'
      : block.status === 'pending'
        ? '参数生成中'
        : block.status === 'waiting'
          ? '等待执行'
          : block.status === 'running'
            ? '执行中'
            : block.status;
  const resultText =
    block.result != null
      ? typeof block.result === 'string'
        ? block.result
        : JSON.stringify(block.result, null, 2)
      : '';

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles}
      status={block.status}
      collapsedName={block.tool_name}
      collapsedSuccessStyle="ok"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
        <Text style={styles.toolCardHeader}>
          {block.tool_name} · {statusLabel}
        </Text>
        {block.arguments ? (
          <Text style={styles.toolCardBody} numberOfLines={10}>
            args: {String(block.arguments)}
          </Text>
        ) : null}
        {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
        {block.streaming_content ? (
          <Text style={styles.toolCardBody} numberOfLines={15}>
            {block.streaming_content}
          </Text>
        ) : null}
        {block.result != null ? (
          <Text
            style={styles.toolCardBody}
            numberOfLines={isFull ? undefined : 3}
          >
            result: {resultText}
          </Text>
        ) : null}
    </ToolCardFrame>
  );
}

