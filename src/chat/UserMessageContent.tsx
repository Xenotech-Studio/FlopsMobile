/**
 * UserMessageContent
 *
 * 把用户气泡里的 content 按 metadata.flops_refs 渲染成「正文 + inline pill」，
 * 正文下方再把 metadata.flops_attachments 渲染成可点击的附件链（对齐 web 的附件展示）。
 * 实现用 React Native 的 inline Text 嵌套：纯文本走 <Text>{text}</Text>，pill 走
 * 带圆角背景色的 <Text style={pillStyle}>{label}</Text>。pill 自然跟随正文换行。
 *
 * 对齐 web src/flops-chat-ui/UserMessageContent.jsx 的子串匹配 + 视觉。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import { splitContentByRefs, truncateMentionTitle, type FlopsRef } from './flopsRefs';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { FlowDocAttachment } from '../flowdoc-native-input/FlowDocBlocks';
import type { FlopsAttachment } from '../utils/chatLocalMessages';

export type UserMessageContentProps = {
  content: string;
  flopsRefs?: FlopsRef[];
  /** 用户消息附件（metadata.flops_attachments）；正文下方渲染成 inline 文件链，点击应用内预览 */
  attachments?: FlopsAttachment[];
  /** 气泡正文文本样式；pill 内的样式从这里继承字号 / 行高 */
  textStyle?: TextStyle | TextStyle[];
};

export function UserMessageContent({
  content,
  flopsRefs,
  attachments,
  textStyle,
}: UserMessageContentProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const segments = useMemo(
    () => splitContentByRefs(content ?? '', flopsRefs ?? []),
    [content, flopsRefs],
  );

  const hasText = segments.length > 0;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  const textNode = (
    <Text style={textStyle}>
      {hasText
        ? segments.map((seg, i) => {
            if (seg.kind === 'text') {
              return <Text key={`t-${i}`}>{seg.text}</Text>;
            }
            const label =
              (seg.ref.mention_text && seg.ref.mention_text.trim()) ||
              `@${truncateMentionTitle(seg.ref.title || '')}`;
            return (
              <Text key={`p-${i}-${seg.ref.key}`} style={styles.pill}>
                {label}
              </Text>
            );
          })
        : ' '}
    </Text>
  );

  // 无附件：保持原行为，直接返回 inline Text（不引入 View 包裹，避免改动既有布局）。
  if (!hasAttachments) {
    return textNode;
  }

  return (
    <View>
      {/* 纯附件、无正文时不渲染占位空 Text，省一行空白 */}
      {hasText ? textNode : null}
      <View style={styles.attachments}>
        {attachments!.map((a, i) => (
          <FlowDocAttachment
            key={`att-${i}-${a.url}`}
            url={a.url}
            filename={a.filename}
            mimeType={a.mime_type}
            size={a.size}
            display="inline"
          />
        ))}
      </View>
    </View>
  );
}

function createStyles(_c: AppColors) {
  return StyleSheet.create({
    /* 附件区：正文下方留一点间距，多个附件纵向堆叠（inline 链各占一行，跟 web 的附件链一致） */
    attachments: {
      marginTop: 6,
      gap: 4,
      alignItems: 'flex-start',
    },
    pill: {
      /* 用户气泡背景是 userBubble（深色），pill 用半透明白做 chip 既不抢戏也对比够用；
       *  字色继承父 Text（onUserBubble），不在这里重写。
       *  RN 行内 Text 不支持 borderRadius，这层 backgroundColor 在 iOS 上行内是矩形高亮；
       *  视觉上也算"pill-y"够用，跟 markdown code 行内态一致。 */
      backgroundColor: 'rgba(255,255,255,0.16)',
      /* 内边距用户感观上靠 fontVariant + 字号即可；不加 paddingHorizontal，避免 RN 行内 Text padding 被忽略导致 layout 错位 */
    },
  });
}
