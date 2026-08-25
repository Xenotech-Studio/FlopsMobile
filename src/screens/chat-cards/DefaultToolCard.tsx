import React from 'react';
import { Text } from 'react-native';
import { ToolCardFrame } from './ToolCardFrame';
import { COMMON_TOOL_CARD_VALUE_KEYS, toolCardPropsEqual } from './toolCardMemo';

type AuthRequest = {
  kind: 'titles' | 'access';
  request_id: string;
  requester_conversation_id: string;
  count?: number;
  target_ids?: string[];
  target_conversation_id?: string;
  reason?: string;
};

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  arguments?: string;
  result?: unknown;
  streaming_content?: string;
  review_id?: string;
  auth_request?: AuthRequest;
  authorization_error?: string;
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
  renderToolCardAuthorizationActions?: (authReq: AuthRequest, isSubmitting: boolean, error?: string) => React.ReactNode;
  authSubmitting?: boolean;
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
  renderToolCardAuthorizationActions,
  authSubmitting,
}: Props) {
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isAwaitingAuth = block.status === 'awaiting_authorization' && Boolean(block.auth_request);
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
            : block.status === 'awaiting_authorization'
              ? '待授权'
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
        {isAwaitingAuth && block.auth_request && renderToolCardAuthorizationActions
          ? renderToolCardAuthorizationActions(block.auth_request, Boolean(authSubmitting), block.authorization_error)
          : null}
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

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   这样工具卡片展开/折叠时，未变的卡片直接跳过；只有 viewMode 变的那张（或 block/isSubmitting 变的）重渲染。 */
export const DefaultToolCard = React.memo(
  DefaultToolCardImpl,
  toolCardPropsEqual<Props>([...COMMON_TOOL_CARD_VALUE_KEYS, 'authSubmitting'])
);

