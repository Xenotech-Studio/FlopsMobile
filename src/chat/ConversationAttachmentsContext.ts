/**
 * 会话级附件 Map（url → attachment），供 MarkdownContent 段级识别附件链用。
 * 对齐 web src/flops-chat-ui/ConversationAttachmentsContext.js：ChatScreen 从
 * conversation.attachments 建 Map 后 Provider 下发；MarkdownContent 消费。
 * 默认 null = 无会话附件（如 Doc 页 / 摘要弹窗里的 MarkdownContent），走原样文本渲染。
 */
import { createContext } from 'react';
import type { ConversationAttachment } from '../api';

export const ConversationAttachmentsContext = createContext<Map<
  string,
  ConversationAttachment
> | null>(null);
