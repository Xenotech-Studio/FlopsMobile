/**
 * FlowDocBlocks
 *
 * 文档级渲染器：把 Slate document（FlowDocBlock[]）拆成各 block 类型，分发给对应的渲染器。
 * v1 设计原则 —— **单一 inline rendering pipeline**：所有"包含文本 + ref-pill"的 block 都
 * 用 FlowDocInput 渲染（atomic pill + marks + native selection 都白嫖一份现成实现）。
 * `editable` prop 控制读写：默认 false（viewer），设 true 即变可编辑文档。
 *
 * 非文本 block（divider / image / file_attachment）走朴素 RN 组件，简单不重复。
 *
 * 容器 block（quote / list / textblock）：内部 children 是嵌套 block，递归 FlowDocBlocks。
 *
 * v1 支持：paragraph / heading-1..6 / code / quote / divider
 * v2 待补：bulletlistblock / numberedlistblock / image / file_attachment
 */
import React from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { Element as SlateElement, type Descendant } from 'slate';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import {
  FlowDocInput,
  type FlowDocContent,
  type FlowDocContentPart,
} from './FlowDocInput';

/* ============================================================
 * 类型
 * ============================================================ */

type SlateMarkedText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  color?: string;
};

type RefPillNode = {
  type: 'ref-pill';
  refKey: string;
  mention: string;
  title?: string;
  isPointer?: boolean;
  children: [{ text: '' }];
};

type SlateBlockBase<T extends string> = {
  type: T;
  children: Descendant[];
};

type ParagraphBlock = SlateBlockBase<'paragraph'>;
type HeadingBlock = SlateBlockBase<
  'heading-one' | 'heading-two' | 'heading-three' | 'heading-four' | 'heading-five' | 'heading-six'
>;
type CodeBlock = SlateBlockBase<'code'>;
type QuoteBlock = SlateBlockBase<'quote'>;
type DividerBlock = { type: 'divider'; children: [{ text: '' }] };

export type FlowDocBlock =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | QuoteBlock
  | DividerBlock;

export type FlowDocDocument = FlowDocBlock[];

/* ============================================================
 * 主组件
 * ============================================================ */

export type FlowDocBlocksProps = {
  document: FlowDocDocument;
  /** 是否可编辑。默认 false（viewer）；true 时每个文本 block 变成可编辑 input
   *  v1 限制：仅 block 内部可编辑，跨 block 操作（Enter 拆段、退格合段）未接 */
  editable?: boolean;
  /** 点 pill 触发；不传则 pill 不可点 */
  onPillPress?: (refKey: string) => void;
  style?: ViewStyle;
};

export function FlowDocBlocks({
  document,
  editable = false,
  onPillPress,
  style,
}: FlowDocBlocksProps) {
  const { colors } = useAppTheme();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={style}>
      {document.map((block, i) => (
        <BlockRenderer
          key={i}
          block={block}
          editable={editable}
          styles={styles}
          colors={colors}
          onPillPress={onPillPress}
        />
      ))}
    </View>
  );
}

/* ============================================================
 * Block dispatch
 * ============================================================ */

type RendererCtx = {
  block: FlowDocBlock;
  editable: boolean;
  styles: BlocksStyles;
  colors: AppColors;
  onPillPress?: (refKey: string) => void;
};

function BlockRenderer(ctx: RendererCtx) {
  const { block } = ctx;
  switch (block.type) {
    case 'paragraph':
      return (
        <View style={ctx.styles.paragraphWrap}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children)}
            fontSize={16}
          />
        </View>
      );
    case 'heading-one':
    case 'heading-two':
    case 'heading-three':
    case 'heading-four':
    case 'heading-five':
    case 'heading-six': {
      const level = headingLevel(block.type);
      const size = HEADING_FONT_SIZES[level];
      const tight = level <= 2;
      return (
        <View style={tight ? ctx.styles.headingWrapTight : ctx.styles.headingWrap}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children, { headingForceBold: true })}
            fontSize={size}
          />
        </View>
      );
    }
    case 'code':
      return (
        <View style={ctx.styles.codeBlockWrap}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children)}
            fontSize={13}
            fontFamily={Platform.OS === 'ios' ? 'Menlo' : 'monospace'}
          />
        </View>
      );
    case 'quote':
      return (
        <View style={ctx.styles.quoteWrap}>
          <NestedBlocks ctx={ctx} children={block.children} />
        </View>
      );
    case 'divider':
      return <View style={ctx.styles.divider} />;
    default:
      return null;
  }
}

/** quote 这种容器 block：内部 children 通常本身又是 paragraph 等 block，递归渲染 */
function NestedBlocks({ ctx, children }: { ctx: RendererCtx; children: Descendant[] }) {
  return (
    <>
      {children.map((child, i) => {
        if (SlateElement.isElement(child) && isBlockType((child as { type?: string }).type)) {
          return <BlockRenderer key={i} {...ctx} block={child as FlowDocBlock} />;
        }
        // 不认识的：兜底当 inline 走 paragraph
        return (
          <View key={i} style={ctx.styles.paragraphWrap}>
            <TextBlockInput
              ctx={ctx}
              content={inlineToContent([child])}
              fontSize={16}
            />
          </View>
        );
      })}
    </>
  );
}

/** 单个文本 block 的实际渲染：调 FlowDocInput，按 block 类型给 fontSize / fontFamily */
function TextBlockInput({
  ctx,
  content,
  fontSize,
  fontFamily,
}: {
  ctx: RendererCtx;
  content: FlowDocContent;
  fontSize: number;
  fontFamily?: string;
}) {
  return (
    <FlowDocInput
      initialContent={content}
      editable={ctx.editable}
      fontSize={fontSize}
      fontFamily={fontFamily}
      textColor={ctx.colors.textPrimary}
      pillBackgroundColor={ctx.colors.surfaceMuted}
      pillTextColor={ctx.colors.textMuted}
      onPillPress={ctx.onPillPress}
    />
  );
}

/* ============================================================
 * 工具
 * ============================================================ */

const HEADING_FONT_SIZES: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 26,
  2: 22,
  3: 20,
  4: 18,
  5: 16,
  6: 14,
};

function headingLevel(t: HeadingBlock['type']): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (t) {
    case 'heading-one': return 1;
    case 'heading-two': return 2;
    case 'heading-three': return 3;
    case 'heading-four': return 4;
    case 'heading-five': return 5;
    case 'heading-six': return 6;
  }
}

function isBlockType(t: string | undefined): boolean {
  return (
    t === 'paragraph' ||
    t === 'heading-one' ||
    t === 'heading-two' ||
    t === 'heading-three' ||
    t === 'heading-four' ||
    t === 'heading-five' ||
    t === 'heading-six' ||
    t === 'code' ||
    t === 'quote' ||
    t === 'divider'
  );
}

/** Slate inline children → FlowDocContent（text 部分 + pill 部分） */
function inlineToContent(
  nodes: Descendant[],
  opts: { headingForceBold?: boolean } = {},
): FlowDocContent {
  const out: FlowDocContent = [];
  for (const node of nodes) {
    if (SlateElement.isElement(node) && (node as { type?: string }).type === 'ref-pill') {
      const e = node as unknown as RefPillNode;
      out.push({
        type: 'pill',
        refKey: String(e.refKey || ''),
        mention: String(e.mention || ''),
        title: String(e.title || ''),
        isPointer: !!e.isPointer,
      });
      continue;
    }
    const leaf = node as SlateMarkedText;
    if (typeof leaf.text !== 'string' || leaf.text.length === 0) continue;
    const marks: NonNullable<Extract<FlowDocContentPart, { type: 'text' }>['marks']> = {};
    if (leaf.bold || opts.headingForceBold) marks.bold = true;
    if (leaf.italic) marks.italic = true;
    if (leaf.code) marks.code = true;
    if (typeof leaf.color === 'string' && leaf.color) marks.color = leaf.color;
    const hasMarks = Object.keys(marks).length > 0;
    out.push(
      hasMarks
        ? { type: 'text', text: leaf.text, marks }
        : { type: 'text', text: leaf.text },
    );
  }
  return out;
}

/* ============================================================
 * Styles
 * ============================================================ */

type BlocksStyles = ReturnType<typeof createStyles>;

function createStyles(c: AppColors) {
  return StyleSheet.create({
    paragraphWrap: { marginVertical: 4 } as ViewStyle,
    headingWrap: { marginTop: 14, marginBottom: 6 } as ViewStyle,
    headingWrapTight: { marginTop: 18, marginBottom: 8 } as ViewStyle,
    codeBlockWrap: {
      backgroundColor: c.surfaceMuted,
      padding: 10,
      borderRadius: 6,
      marginVertical: 8,
    } as ViewStyle,
    quoteWrap: {
      borderLeftWidth: 3,
      borderLeftColor: c.borderMuted,
      paddingLeft: 12,
      marginVertical: 8,
    } as ViewStyle,
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.borderMuted,
      marginVertical: 12,
    } as ViewStyle,
  });
}
