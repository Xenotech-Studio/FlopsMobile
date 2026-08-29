/**
 * 把已转换好的 ChatMessage[] 以「普通对话消息列表」形态静态渲染——用户气泡 + assistant 正文/思考/工具块。
 *
 * 供 flops 子agent 的「查看对话」弹窗（SubagentViewOverlay 的 flops 分支）复用：不再套工具卡外壳，
 * 而是像主对话流那样把子对话铺开呈现。工具块复用 SubagentCard 里的 InnerToolStep（折叠单行、可展开）。
 *
 * 传入的 messages 已由 rawMessagesToLocal 转换：assistant 消息带 blocks（text/thinking/tool/…）；
 * 独立的 role:'tool' 消息在转换阶段已折叠进 assistant 的 tool block，这里不会再出现。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { InnerToolStep } from '../screens/chat-cards/SubagentCard';
import { ThinkingBlockView } from '../screens/chat/ThinkingBlockView';
import { MarkdownContent } from './MarkdownContent';

type Props = {
  messages: any[];
  styles: Record<string, any>;
  colors: Record<string, any>;
  getToolStatusLabel: (status: string) => string;
};

export function SubagentConversationMessages({
  messages,
  styles,
  colors,
  getToolStatusLabel,
}: Props): React.ReactElement {
  const list = Array.isArray(messages) ? messages : [];
  const local = useMemo(() => createLocalStyles(colors), [colors]);
  return (
    <View>
      {list.map((msg, mi) => {
        if (!msg || typeof msg !== 'object') return null;
        const role = String(msg.role || '');

        if (role === 'user') {
          const content = typeof msg.content === 'string' ? msg.content : '';
          return (
            <View key={`u-${mi}`} style={local.userWrap}>
              <Text style={local.roleLabel}>用户</Text>
              <View style={local.userBubble}>
                {content ? (
                  <MarkdownContent text={content} showCopyButton={false} />
                ) : null}
              </View>
            </View>
          );
        }

        if (role === 'assistant') {
          const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
          return (
            <View key={`a-${mi}`} style={local.assistantWrap}>
              {blocks.map((block: any, bi: number) => {
                if (!block || typeof block !== 'object') return null;
                const bt = String(block.type || '');
                if (bt === 'text') {
                  const text = typeof block.content === 'string' ? block.content : '';
                  if (!text) return null;
                  return (
                    <MarkdownContent
                      key={`t-${mi}-${bi}`}
                      text={text}
                      showCopyButton={false}
                    />
                  );
                }
                if (bt === 'thinking') {
                  const text = typeof block.content === 'string' ? block.content : '';
                  if (!text.trim()) return null;
                  // 主对话同款思考块（Brain 图标 + 标签 + 可折叠正文），视觉/交互与主对话一致。
                  return <ThinkingBlockView key={`th-${mi}-${bi}`} block={block} />;
                }
                if (bt === 'tool') {
                  return (
                    <InnerToolStep
                      key={`tool-${mi}-${bi}`}
                      blk={block}
                      k={`subagent-conv-${mi}-${bi}`}
                      styles={styles}
                      getToolStatusLabel={getToolStatusLabel}
                    />
                  );
                }
                // task_event / user_injection / 其他：这里作纯文本降级展示（有内容才渲）。
                const other = typeof block.content === 'string' ? block.content : '';
                if (!other.trim()) return null;
                return (
                  <Text key={`o-${mi}-${bi}`} style={local.thinking}>
                    {other}
                  </Text>
                );
              })}
            </View>
          );
        }

        // role:'tool' 独立消息 → 已折叠进 assistant，跳过；其余未知角色一并跳过。
        return null;
      })}
    </View>
  );
}

function createLocalStyles(colors: Record<string, any>) {
  const bubbleBg = (colors?.surfaceMuted as string) || (colors?.surface as string) || 'rgba(255,255,255,0.08)';
  const muted = (colors?.textMuted as string) || 'rgba(255,255,255,0.45)';
  return StyleSheet.create({
    userWrap: { marginBottom: 14, alignItems: 'flex-end' },
    roleLabel: {
      color: muted,
      fontSize: 11,
      marginBottom: 4,
      marginRight: 2,
    },
    userBubble: {
      maxWidth: '92%',
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 14,
      backgroundColor: bubbleBg,
    },
    assistantWrap: { marginBottom: 14, gap: 6 },
    thinking: {
      color: muted,
      fontStyle: 'italic',
      fontSize: 13,
      lineHeight: 19,
    },
  });
}
