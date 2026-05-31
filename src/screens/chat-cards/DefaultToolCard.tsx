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

function DefaultToolCardImpl({
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

/**
 * memo 比较：只比影响渲染的 props（block 引用 / cardKey / viewMode / styles 引用 / isSubmitting），
 * 忽略 getToolStatusLabel / setToolCardMode / renderToolCardSafetyActions 的函数标识 —— 它们是
 * ChatScreen 里的稳定行为函数（纯映射 / useCallback / 仅 awaiting 态才用），忽略标识安全。
 * 这样工具卡片展开/折叠时，未变的卡片直接跳过；只有 viewMode 变的那张（或 block/isSubmitting 变的）重渲染。
 */
function toolCardPropsEqual(a: Props, b: Props): boolean {
  return (
    a.block === b.block &&
    a.cardKey === b.cardKey &&
    a.viewMode === b.viewMode &&
    a.styles === b.styles &&
    a.isSubmitting === b.isSubmitting
  );
}

export const DefaultToolCard = React.memo(DefaultToolCardImpl, toolCardPropsEqual);

