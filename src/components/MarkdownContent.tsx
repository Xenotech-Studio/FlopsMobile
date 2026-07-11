/**
 * Markdown 渲染 + 可选复制按钮，与 FlopsDesktop 的 MarkdownContent 能力对齐
 */
import React, { useContext, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import FitImage from 'react-native-fit-image';
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { FlowDocAttachment } from '../flowdoc-native-input/FlowDocBlocks';
import { ConversationAttachmentsContext } from '../chat/ConversationAttachmentsContext';
import type { ConversationAttachment } from '../api';

/** react-native-markdown-display 的 AST 节点（只用到这几个字段）。 */
type MdNode = {
  type?: string;
  content?: string;
  attributes?: { href?: string };
  children?: MdNode[];
  key?: string;
};

/** markdown-it 会把链接 href percent-encode（原始 url 常含中文/空格），而会话附件 Map 的 key
 *  是服务端原始 url，两端形态不一致会导致 has() 恒 false。比较时对 href 做 decode 兜底，
 *  解码失败（非法编码序列）退回原值，保证编码差异不阻断匹配。 */
function safeDecodeHref(h: string): string {
  try {
    return decodeURIComponent(h);
  } catch {
    return h;
  }
}

/** 用原始 href 与 decode 后的 href 双形态查会话附件 Map（Map 侧也已存 decode key，双向归一）。 */
function resolveAttachment(
  attMap: Map<string, ConversationAttachment>,
  href: string,
): ConversationAttachment | undefined {
  if (attMap.has(href)) return attMap.get(href);
  const decoded = safeDecodeHref(href);
  if (decoded !== href && attMap.has(decoded)) return attMap.get(decoded);
  return undefined;
}

/** 该 inline 节点是否是「空白」（纯空格 text / 换行）——拆卡片时两侧只剩空白的文本段不单独成行。 */
function isBlankInline(n: MdNode | undefined): boolean {
  if (!n) return true;
  if (n.type === 'text') return !(typeof n.content === 'string' && n.content.trim());
  if (n.type === 'softbreak' || n.type === 'hardbreak') return true;
  return false;
}

const attachmentBlockStyles = StyleSheet.create({
  /* 含附件的 textgroup 拆分容器：文本段 <Text> 与文件卡片 <View> 纵向交替堆叠。 */
  split: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 6,
  },
});

/**
 * textgroup 渲染包装：对齐 web 逐链接把命中会话附件的链接替换成文件卡片，但因 RN 的 <Text> 不能嵌
 * <View>（卡片是块级 View），改在 textgroup（inline 内容的容器，其父恒为块级 View）层做拆分——
 * 把这一段 inline 拆成「文本段 <Text> + 卡片 <View>」纵向交替。textgroup 覆盖 paragraph / 紧凑列表项
 * （omitListItemParagraph 会去掉列表项内的 paragraph）/ 表格单元格等所有 inline 场景，因此列表/表格/
 * 句中的附件链接都能出卡片，解决「附件几乎全在行内、段级判定命不中」的根因。
 *
 * 无附件链接（绝大多数普通文本段）→ 原样返回库默认的 inline <Text>，不改任何布局。
 * 卡片用已 export 的 FlowDocAttachment（display='card'，自带预览弹窗），与文档里的文件卡片视觉一致。
 */
function AttachmentAwareTextgroup({
  node,
  rendered,
  textgroupStyle,
}: {
  node: MdNode;
  /** 库已渲染好的各 inline 子节点，与 node.children 一一对齐（AstRenderer 用 map 生成，下标不漂移）。 */
  rendered: React.ReactNode;
  textgroupStyle: TextStyle | undefined;
}) {
  const attMap = useContext(ConversationAttachmentsContext);
  const kids = node.children ?? [];
  // rendered 即 AstRenderer 的 node.children.map(...) 结果（含 null 占位、保序），直接按下标取，
  // 与 kids 一一对齐。不能用 React.Children.toArray——它会丢弃 null 并重排下标，破坏对齐。
  const renderedArr: React.ReactNode[] = Array.isArray(rendered) ? rendered : [rendered];

  // 先定位命中会话附件的链接子节点下标
  const attByIndex = new Map<number, ConversationAttachment>();
  if (attMap && attMap.size > 0) {
    kids.forEach((c, i) => {
      if (c?.type !== 'link') return;
      const href = typeof c.attributes?.href === 'string' ? c.attributes.href.trim() : '';
      const att = href ? resolveAttachment(attMap, href) : undefined;
      if (att) attByIndex.set(i, att);
    });
  }

  // 无附件 → 原样库默认 inline 文本，布局不变
  if (attByIndex.size === 0) {
    return <Text style={textgroupStyle}>{rendered}</Text>;
  }

  // 有附件 → 文本段 / 卡片交替拆分
  const out: React.ReactNode[] = [];
  let buf: React.ReactNode[] = [];
  let bufBlank = true;
  const flush = (seed: string | number) => {
    if (buf.length > 0 && !bufBlank) {
      out.push(
        <Text key={`tg-txt-${seed}`} style={textgroupStyle}>
          {buf}
        </Text>,
      );
    }
    buf = [];
    bufBlank = true;
  };
  kids.forEach((c, i) => {
    const att = attByIndex.get(i);
    if (att) {
      flush(i);
      out.push(
        <FlowDocAttachment
          key={`tg-att-${i}-${att.url}`}
          url={att.url}
          filename={att.filename}
          mimeType={att.mime_type}
          size={att.size_bytes}
          display="card"
        />,
      );
    } else {
      buf.push(renderedArr[i]);
      if (!isBlankInline(c)) bufBlank = false;
    }
  });
  flush('end');

  return <View style={attachmentBlockStyles.split}>{out}</View>;
}

/* 默认 image 规则的实现里 imageProps 包含 key 然后做 spread，React 18+ 会 warn。
   我们这里自己实现一份等价规则、把 key 单独传，避免 console 噪声。
   规则签名跟 react-native-markdown-display 的 RenderRule 一致：
   (node, children, parent, styles, allowedImageHandlers, defaultImageHandler) */
const MD_RENDER_RULES = {
  /* inline 内容容器：命中会话附件的链接 → 抽成块级文件卡片（display='card'），其余文本原样。
     textgroup 覆盖 paragraph / 紧凑列表项 / 表格单元格等所有 inline 场景，故列表/表格/句中的附件
     链接都能出卡片。非附件段原样返回库默认 inline <Text>，不改布局。 */
  textgroup: (
    node: MdNode & { key: string },
    children: React.ReactNode,
    _parent: unknown,
    styles: Record<string, unknown>,
  ) => (
    <AttachmentAwareTextgroup
      key={node.key}
      node={node}
      rendered={children}
      textgroupStyle={(styles as { textgroup?: TextStyle }).textgroup}
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
