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
  // 挂起等用户决策（安全确认 / 工具授权）时：允许/拒绝按钮只在展开态渲染，卡片默认折叠用户就看不到、
  // 必须先手动展开——很反直觉。故此类卡强制展开（collapsed→preview），保证按钮直接可见。
  const effViewMode: 'collapsed' | 'preview' | 'full' =
    (isAwaiting || isAwaitingAuth) && viewMode === 'collapsed' ? 'preview' : viewMode;
  // 会话编排类授权工具（子 agent 用 list_conversations / request_conversation_access 定位·访问对话）：
  // 参数对用户无意义，裸显示 {"limit":50,...} 反而干扰。给友好标题+说明，不显示参数/结果 JSON。
  const CONVERSATION_TOOL_LABELS: Record<string, { title: string; desc: string }> = {
    list_conversations: { title: '查看对话列表', desc: '在你的对话中检索定位（加密对话的标题需你授权后才解密）' },
    request_conversation_access: { title: '请求访问对话', desc: '读取另一条加密对话的内容（需你授权）' },
  };
  const friendly = CONVERSATION_TOOL_LABELS[block.tool_name] || null;
  const displayName = friendly ? friendly.title : block.tool_name;
  const isFull = effViewMode === 'full';
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
      viewMode={effViewMode}
      styles={styles}
      status={block.status}
      collapsedName={displayName}
      collapsedSuccessStyle="ok"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
        <Text style={styles.toolCardHeader}>
          {displayName} · {statusLabel}
        </Text>
        {friendly ? (
          // 授权挂起时下方已有完整解释文案+按钮，不重复；否则给一行友好说明，不裸显示参数 JSON。
          isAwaitingAuth ? null : (
            <Text style={styles.toolCardBody} numberOfLines={3}>
              {friendly.desc}
            </Text>
          )
        ) : block.arguments ? (
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
        {!friendly && block.result != null ? (
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

