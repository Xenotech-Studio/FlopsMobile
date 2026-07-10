/**
 * Markdown 渲染 + 可选复制按钮，与 FlopsDesktop 的 MarkdownContent 能力对齐
 */
import React, { useContext, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, type ViewStyle } from 'react-native';
import Markdown from 'react-native-markdown-display';
import FitImage from 'react-native-fit-image';
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { FlowDocAttachment } from '../flowdoc-native-input/FlowDocBlocks';
import { ConversationAttachmentsContext } from '../chat/ConversationAttachmentsContext';

/** react-native-markdown-display 的 AST 节点（只用到这几个字段）。 */
type MdNode = {
  type?: string;
  content?: string;
  attributes?: { href?: string };
  children?: MdNode[];
  key?: string;
};

/**
 * 递归判定：段落是否「仅由链接（+空白）组成」，并收集所有链接 href。
 * - link：收 href，不下探其 label 文本（label 是链接文字，不算段落正文）
 * - 非空白 text / 其它 inline 节点（image/code/strong…）→ 判定不纯（clean=false）
 * - textgroup/paragraph：容器，继续下探；softbreak/hardbreak：视作空白
 */
function analyzeParagraphLinks(node: MdNode): { hrefs: string[]; clean: boolean } {
  const hrefs: string[] = [];
  let clean = true;
  const visit = (n: MdNode | undefined) => {
    if (!n || typeof n !== 'object') return;
    const t = n.type;
    if (t === 'link') {
      const href = typeof n.attributes?.href === 'string' ? n.attributes.href.trim() : '';
      if (href) hrefs.push(href);
      return;
    }
    if (t === 'text') {
      if (typeof n.content === 'string' && n.content.trim()) clean = false;
      return;
    }
    if (t === 'softbreak' || t === 'hardbreak') return;
    if (t === 'textgroup' || t === 'paragraph') {
      (n.children ?? []).forEach(visit);
      return;
    }
    clean = false;
  };
  visit(node);
  return { hrefs, clean };
}

const attachmentBlockStyles = StyleSheet.create({
  /* 附件卡片段落：纵向堆叠（卡片是块级），覆盖库默认 paragraph 的 row/wrap。
     paragraphStyle 里的 marginBottom 等间距仍保留（数组合并、后者只覆盖同名键）。 */
  block: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 8,
  },
});

/**
 * 段落渲染包装：命中「仅由会话附件链接组成」的段落时，抬成块级文件卡片（display='card'），
 * 否则回落库默认段落渲染（原样 <Text> 内联）。附件数据来自 ConversationAttachmentsContext，
 * 无 provider（如 Doc 页 / 摘要弹窗）时 attMap=null，永远走回落，不影响其它场景。
 */
function AttachmentAwareParagraph({
  node,
  fallback,
  paragraphStyle,
}: {
  node: MdNode;
  fallback: React.ReactNode;
  paragraphStyle: ViewStyle | undefined;
}) {
  const attMap = useContext(ConversationAttachmentsContext);
  if (attMap && attMap.size > 0) {
    const { hrefs, clean } = analyzeParagraphLinks(node);
    if (clean && hrefs.length >= 1 && hrefs.length <= 2 && hrefs.every((h) => attMap.has(h))) {
      return (
        <View style={[paragraphStyle, attachmentBlockStyles.block]}>
          {hrefs.map((h, i) => {
            const att = attMap.get(h)!;
            return (
              <FlowDocAttachment
                key={`att-${i}-${h}`}
                url={att.url}
                filename={att.filename}
                mimeType={att.mime_type}
                display="card"
              />
            );
          })}
        </View>
      );
    }
  }
  return <View style={paragraphStyle}>{fallback}</View>;
}

/* 默认 image 规则的实现里 imageProps 包含 key 然后做 spread，React 18+ 会 warn。
   我们这里自己实现一份等价规则、把 key 单独传，避免 console 噪声。
   规则签名跟 react-native-markdown-display 的 RenderRule 一致：
   (node, children, parent, styles, allowedImageHandlers, defaultImageHandler) */
const MD_RENDER_RULES = {
  /* 段级识别附件链接：仅由会话附件链接组成的段落 → 文件卡片（RN 的 <Text> 不能嵌 <View>，
     所以只能在段落级别、而非 web 那样内联替换）。其余段落走库默认（<View>{children}</View>）。 */
  paragraph: (
    node: MdNode & { key: string },
    children: React.ReactNode,
    _parent: unknown,
    styles: Record<string, unknown>,
  ) => (
    <AttachmentAwareParagraph
      key={node.key}
      node={node}
      fallback={children}
      paragraphStyle={(styles as { _VIEW_SAFE_paragraph?: ViewStyle })._VIEW_SAFE_paragraph}
    />
  ),
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
  /** 语音播放按钮（本条 assistant 消息有 TTS 音频时显示）。 */
  showPlayButton?: boolean;
  /** 本条正在播放（用于切换 播放/暂停 图标）。 */
  isPlaying?: boolean;
  /** 本条正在加载（缓冲）——按钮显示忙碌态。 */
  isPlayLoading?: boolean;
  onPlay?: () => void;
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

function MarkdownContentImpl({
  text,
  showCopyButton = false,
  showRegenerateButton = false,
  onRegenerate,
  regenerateDisabled = false,
  showPlayButton = false,
  isPlaying = false,
  isPlayLoading = false,
  onPlay,
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
    (showPlayButton && typeof onPlay === 'function') ||
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
            {showPlayButton && typeof onPlay === 'function' ? (
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionBtnIconOnly]}
                onPress={onPlay}
                accessibilityLabel={isPlaying ? '暂停语音' : '播放语音'}
              >
                <Ionicons
                  name={isPlayLoading ? 'ellipsis-horizontal' : isPlaying ? 'pause' : 'play'}
                  size={20}
                  color={iconDefault}
                />
              </TouchableOpacity>
            ) : null}
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

/**
 * memo 比较：只比"影响渲染的值 props"，忽略 onRegenerate / onCompressClick 的函数标识
 * —— 它们在调用点是内联箭头（每次 render 新建），但行为只取决于稳定的 afterUserIndex / 稳定 useCallback，
 * 忽略其标识是安全的。这样在工具卡片展开/折叠等不改 markdown 的重渲染里，未变的消息直接跳过、不重解析。
 * 主题(colors)走 useAppTheme context，不受 memo 阻断，仍会刷新。
 */
function markdownPropsEqual(a: Props, b: Props): boolean {
  return (
    a.text === b.text &&
    a.showCopyButton === b.showCopyButton &&
    a.showRegenerateButton === b.showRegenerateButton &&
    a.regenerateDisabled === b.regenerateDisabled &&
    a.showPlayButton === b.showPlayButton &&
    a.isPlaying === b.isPlaying &&
    a.isPlayLoading === b.isPlayLoading &&
    a.usageHint === b.usageHint &&
    a.usageDetail === b.usageDetail &&
    a.compressHint === b.compressHint &&
    a.compressAriaLabel === b.compressAriaLabel &&
    a.contentWrapperStyle === b.contentWrapperStyle
  );
}

export const MarkdownContent = React.memo(MarkdownContentImpl, markdownPropsEqual);
