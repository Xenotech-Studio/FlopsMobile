/**
 * Markdown 渲染 + 可选复制按钮，与 FlopsDesktop 的 MarkdownContent 能力对齐
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, type ViewStyle } from 'react-native';
import Markdown from 'react-native-markdown-display';
import FitImage from 'react-native-fit-image';
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';

/* 默认 image 规则的实现里 imageProps 包含 key 然后做 spread，React 18+ 会 warn。
   我们这里自己实现一份等价规则、把 key 单独传，避免 console 噪声。
   规则签名跟 react-native-markdown-display 的 RenderRule 一致：
   (node, children, parent, styles, allowedImageHandlers, defaultImageHandler) */
const MD_RENDER_RULES = {
  image: (
    node: { key: string; attributes: { src?: string; alt?: string } },
    _children: unknown,
    _parent: unknown,
    styles: Record<string, unknown>,
    allowedImageHandlers: string[],
    defaultImageHandler: string | null,
  ) => {
    const src = String(node.attributes?.src ?? '');
    const alt = node.attributes?.alt;
    const show =
      allowedImageHandlers.some((v) => src.toLowerCase().startsWith(String(v).toLowerCase()));
    if (!show && defaultImageHandler == null) return null;
    const uri = show ? src : `${defaultImageHandler}${src}`;
    /* key 必须直接传 JSX 不能 spread；剩下 props 走 spread */
    const props: Record<string, unknown> = {
      indicator: true,
      style: (styles as { _VIEW_SAFE_image?: unknown })._VIEW_SAFE_image,
      source: { uri },
    };
    if (alt) {
      props.accessible = true;
      props.accessibilityLabel = alt;
    }
    return <FitImage key={node.key} {...props} />;
  },
};
import { UsageDetailModal } from './UsageDetailModal';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

function buildMarkdownStyles(c: AppColors) {
  return {
    body: { color: c.textPrimary, fontSize: 14, lineHeight: 20 },
    paragraph: { marginTop: 0, marginBottom: 12 },
    text: { color: c.textPrimary },
    code_inline: {
      backgroundColor: c.surfaceMuted,
      color: c.textPrimary,
      fontSize: 14,
      paddingHorizontal: 6,
      paddingVertical: 3,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: c.border,
    },
    code_block: {
      backgroundColor: c.surfaceMuted,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      padding: 12,
      marginVertical: 10,
    },
    /** 库默认 fence 带 #f5f5f5，合并时未覆盖的键会保留，须与 code_block 一样写满主题色 */
    fence: {
      backgroundColor: c.surfaceMuted,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      padding: 12,
      marginVertical: 10,
      color: c.textPrimary,
      fontSize: 13,
    },
    link: { color: c.link },
    strong: { fontWeight: '700' as const },
    em: { fontStyle: 'italic' as const },
    list_item: { marginVertical: 4 },
    heading1: { fontSize: 22, fontWeight: '700' as const, marginTop: 14, marginBottom: 8 },
    heading2: { fontSize: 20, fontWeight: '700' as const, marginTop: 12, marginBottom: 6 },
    heading3: { fontSize: 18, fontWeight: '600' as const, marginTop: 10, marginBottom: 4 },
    hr: { backgroundColor: c.border, height: 1, marginVertical: 14 },
    blockquote: {
      backgroundColor: c.backgroundSecondary,
      borderLeftWidth: 4,
      borderLeftColor: c.border,
      paddingLeft: 14,
      marginVertical: 10,
    },
    table: { borderWidth: 1, borderColor: c.border, borderRadius: 6 },
    th: {
      padding: 10,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.backgroundSecondary,
      fontWeight: '600' as const,
    },
    td: { padding: 10, borderWidth: 1, borderColor: c.border },
  };
}

function createMarkdownLayoutStyles(c: AppColors) {
  return StyleSheet.create({
    wrap: {
      flexDirection: 'column',
      gap: 10,
      width: '100%',
      alignSelf: 'stretch',
    },
    content: {
      flexDirection: 'column',
    },
    placeholder: {
      fontSize: 14,
      color: c.placeholder,
    },
    toolbarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
    },
    toolbarRowFull: {
      alignSelf: 'stretch',
      width: '100%',
    },
    toolbarLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    toolbarSpacer: {
      flex: 1,
      minWidth: 8,
    },
    usageChip: {
      flexShrink: 1,
      maxWidth: '72%',
      paddingVertical: 4,
      paddingHorizontal: 0,
      backgroundColor: 'transparent',
    },
    usageChipText: {
      fontSize: 12,
      color: c.textMuted,
    },
    toolbarRightChips: {
      flexDirection: 'row',
      flexShrink: 1,
      alignItems: 'center',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
      gap: 10,
      maxWidth: '100%',
    },
    compressChip: {
      flexShrink: 1,
      maxWidth: '48%',
      paddingVertical: 4,
      paddingHorizontal: 0,
      backgroundColor: 'transparent',
    },
    compressChipText: {
      fontSize: 12,
      color: c.textMuted,
    },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    actionBtnIconOnly: {
      paddingVertical: 8,
      paddingHorizontal: 8,
    },
    actionBtnDisabled: {
      opacity: 0.6,
    },
  });
}

type Props = {
  text: string;
  showCopyButton?: boolean;
  showRegenerateButton?: boolean;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
  /** 本段用量小字，与 Web/Desktop flops-chat-ui 对齐；点击查看详情 */
  usageHint?: string;
  /** 弹窗多行详情；不传则仅展示 usageHint */
  usageDetail?: string;
  /** 上下文压缩比例提示（如「42%已压缩」），与 Web/Desktop 对齐 */
  compressHint?: string;
  /** 点击压缩提示时滚动到摘要分界 */
  onCompressClick?: () => void;
  compressAriaLabel?: string;
  /** 仅作用于正文区域（不含底部工具栏），如「未回复」提示与 Web .assistant-empty-reply-block 一致弱化 */
  contentWrapperStyle?: ViewStyle;
};

export function MarkdownContent({
  text,
  showCopyButton = false,
  showRegenerateButton = false,
  onRegenerate,
  regenerateDisabled = false,
  usageHint,
  usageDetail,
  compressHint,
  onCompressClick,
  compressAriaLabel,
  contentWrapperStyle,
}: Props) {
  const { colors } = useAppTheme();
  const markdownStyles = useMemo(() => buildMarkdownStyles(colors), [colors]);
  const styles = useMemo(() => createMarkdownLayoutStyles(colors), [colors]);

  const [copied, setCopied] = useState(false);
  const [usageDetailOpen, setUsageDetailOpen] = useState(false);
  const source = String(text ?? '').trim();
  const hasUsage = typeof usageHint === 'string' && usageHint.trim().length > 0;
  const hasCompress = typeof compressHint === 'string' && compressHint.trim().length > 0;
  const detailText =
    typeof usageDetail === 'string' && usageDetail.trim().length > 0
      ? usageDetail.trim()
      : hasUsage
        ? usageHint!.trim()
        : '';

  const showUsagePress = () => {
    if (!detailText) return;
    setUsageDetailOpen(true);
  };

  const handleCopy = () => {
    if (!source) return;
    Clipboard.setString(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const showToolbar =
    showCopyButton ||
    (showRegenerateButton && typeof onRegenerate === 'function') ||
    hasUsage ||
    hasCompress;

  const iconMuted = colors.placeholder;
  const iconDefault = colors.textSecondary;

  return (
    <View style={styles.wrap}>
      <View style={[styles.content, contentWrapperStyle]}>
        {source ? (
          <Markdown style={markdownStyles} rules={MD_RENDER_RULES}>
            {source}
          </Markdown>
        ) : showToolbar ? null : (
          <Text style={styles.placeholder}>（无内容）</Text>
        )}
      </View>
      {showToolbar ? (
        <View style={[styles.toolbarRow, (hasUsage || hasCompress) && styles.toolbarRowFull]}>
          <View style={styles.toolbarLeft}>
            {showRegenerateButton && typeof onRegenerate === 'function' ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionBtnIconOnly, regenerateDisabled && styles.actionBtnDisabled]}
                onPress={onRegenerate}
                disabled={regenerateDisabled}
                accessibilityLabel="重新回答"
              >
                <Ionicons name="refresh" size={20} color={regenerateDisabled ? iconMuted : iconDefault} />
              </TouchableOpacity>
            ) : null}
            {showCopyButton ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionBtnIconOnly]}
                onPress={handleCopy}
                accessibilityLabel={copied ? '已复制' : '复制'}
              >
                <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={20} color={iconDefault} />
              </TouchableOpacity>
            ) : null}
          </View>
          {hasUsage || hasCompress ? (
            <>
              <View style={styles.toolbarSpacer} />
              <View style={styles.toolbarRightChips}>
                {hasUsage ? (
                  <TouchableOpacity
                    style={styles.usageChip}
                    onPress={showUsagePress}
                    disabled={!detailText}
                    accessibilityLabel="用量详情"
                    accessibilityRole="button"
                    hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  >
                    <Text style={styles.usageChipText} numberOfLines={1}>
                      {usageHint!.trim()}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {hasCompress ? (
                  onCompressClick ? (
                    <TouchableOpacity
                      style={styles.compressChip}
                      onPress={onCompressClick}
                      accessibilityLabel={compressAriaLabel || compressHint!.trim()}
                      accessibilityRole="button"
                      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                    >
                      <Text style={styles.compressChipText} numberOfLines={1}>
                        {compressHint!.trim()}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.compressChipText} numberOfLines={1}>
                      {compressHint!.trim()}
                    </Text>
                  )
                ) : null}
              </View>
            </>
          ) : null}
        </View>
      ) : null}
      <UsageDetailModal
        visible={usageDetailOpen}
        onClose={() => setUsageDetailOpen(false)}
        body={detailText}
      />
    </View>
  );
}
