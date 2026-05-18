/**
 * FlowDocSlateAdapter
 *
 * 把 native FlowDocInput 接到 Slate 数据层：
 * - 输入：Slate document（paragraph[]，每个 paragraph 是 {type:'paragraph', children: [...]}）
 * - 输出：onChange 回调送回新的 Slate document
 *
 * Multi-paragraph 策略（v1）：单个 native input，paragraphs 之间用 `\n` 分隔。
 *  - serialize 时把 Slate 各 paragraph children 拍平为一段 FlowDocContent，paragraph 之间塞 {type:'text',text:'\n'}
 *  - deserialize 时按 `\n` 拆 text part，每个分段塞进新的 paragraph element；pill 跟在所在分段
 *
 * 局限：所有 paragraph 共享同一个 native input 的 block 样式（fontSize/textColor 等）。
 * 想要 per-paragraph block 类型（heading / list / code-block）就需要 Option B：
 * 每个 paragraph 一个独立 native input + 顶层 BlockEditor 组件管理。后续再做。
 *
 * Selection / cursor 反向映射（native offset ↔ Slate path+offset）尚未实现，deferred 到 v1.5。
 */
import React, { forwardRef, useCallback, useMemo } from 'react';
import type { ViewStyle } from 'react-native';
import { Element as SlateElement, type Descendant } from 'slate';
import {
  FlowDocInput,
  type FlowDocContent,
  type FlowDocContentPart,
  type FlowDocInputHandle,
} from './FlowDocInput';

type RefPillNode = {
  type: 'ref-pill';
  refKey: string;
  mention: string;
  title?: string;
  isPointer?: boolean;
  children: [{ text: '' }];
};

type SlateParagraphElement = {
  type: 'paragraph';
  children: Descendant[];
};

export type SlateDocument = SlateParagraphElement[];

type SlateMarkedText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  color?: string;
};

function slateLeafToTextPart(leaf: SlateMarkedText): FlowDocContentPart {
  const marks: NonNullable<Extract<FlowDocContentPart, { type: 'text' }>['marks']> = {};
  if (leaf.bold) marks.bold = true;
  if (leaf.italic) marks.italic = true;
  if (leaf.code) marks.code = true;
  if (typeof leaf.color === 'string' && leaf.color) marks.color = leaf.color;
  const hasMarks = Object.keys(marks).length > 0;
  return hasMarks
    ? { type: 'text', text: leaf.text, marks }
    : { type: 'text', text: leaf.text };
}

function paragraphChildrenToContent(children: Descendant[]): FlowDocContent {
  const out: FlowDocContent = [];
  for (const node of children) {
    if (SlateElement.isElement(node) && (node as { type?: string }).type === 'ref-pill') {
      const e = node as unknown as RefPillNode;
      out.push({
        type: 'pill',
        refKey: String(e.refKey || ''),
        mention: String(e.mention || ''),
        title: String(e.title || ''),
        isPointer: !!e.isPointer,
      });
    } else {
      const leaf = node as SlateMarkedText;
      if (typeof leaf.text === 'string' && leaf.text.length > 0) {
        out.push(slateLeafToTextPart(leaf));
      }
    }
  }
  return out;
}

/** Slate doc → 一段 FlowDocContent，paragraph 之间用 {type:'text',text:'\n'} 分隔 */
function slateDocumentToContent(doc: SlateDocument): FlowDocContent {
  const out: FlowDocContent = [];
  doc.forEach((para, i) => {
    for (const part of paragraphChildrenToContent(para.children)) {
      out.push(part);
    }
    if (i < doc.length - 1) {
      out.push({ type: 'text', text: '\n' });
    }
  });
  return out;
}

type TextPartMarks = Extract<FlowDocContentPart, { type: 'text' }>['marks'];

function textPartToSlateLeaf(text: string, marks?: TextPartMarks): Descendant {
  const leaf: Record<string, unknown> = { text };
  if (marks?.bold) leaf.bold = true;
  if (marks?.italic) leaf.italic = true;
  if (marks?.code) leaf.code = true;
  if (marks?.color) leaf.color = marks.color;
  return leaf as unknown as Descendant;
}

function pillPartToSlate(p: Extract<FlowDocContentPart, { type: 'pill' }>): Descendant {
  return {
    type: 'ref-pill',
    refKey: p.refKey,
    mention: p.mention,
    title: p.title,
    isPointer: p.isPointer,
    children: [{ text: '' }],
  } as unknown as Descendant;
}

/** FlowDocContent → Slate doc：按 text part 里的 `\n` 切 paragraph，pill 跟在所在分段 */
function contentToSlateDocument(content: FlowDocContent): SlateDocument {
  const paragraphs: SlateParagraphElement[] = [];
  let current: Descendant[] = [];

  const flushParagraph = () => {
    paragraphs.push({
      type: 'paragraph',
      children: current.length > 0 ? current : [{ text: '' } as unknown as Descendant],
    });
    current = [];
  };

  for (const part of content) {
    if (part.type === 'pill') {
      current.push(pillPartToSlate(part));
      continue;
    }
    // text part：拆 \n
    const segments = part.text.split('\n');
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.length > 0) {
        current.push(textPartToSlateLeaf(seg, part.marks));
      }
      if (i < segments.length - 1) {
        // 到换行边界，flush 当前段，开新段
        flushParagraph();
      }
    }
  }
  // 最后一个 paragraph（即便没内容也要 emit，Slate 不接受空 doc）
  flushParagraph();
  return paragraphs;
}

export type FlowDocSlateAdapterProps = {
  /** Slate document（paragraph[]）。只在首次 render 用作 initialContent；
   *  之后内容由 native 端为 truth，通过 onChange 反向同步。 */
  initialDocument: SlateDocument;
  onChange?: (document: SlateDocument) => void;
  onChangeSelection?: (start: number, end: number) => void;
  /** Native 把 Enter 拆段事件交给我们时 → 调用 onSubmitOnEnter 视为"发送本条消息"。
   *  设了这个 prop 之后用户就 *不能* 用 Enter 输入换行（多段必须通过别的方式凑齐，
   *  比如粘贴）。chat composer 场景下这是用户期望的行为。 */
  onSubmitOnEnter?: () => void;
  textColor?: string;
  pillBackgroundColor?: string;
  pillTextColor?: string;
  fontSize?: number;
  lineHeight?: number;
  /** Pill 视觉截短上限（iOS pt / Android dp）；默认 140，<=0 关视觉截短 */
  pillMaxLabelTextWidth?: number;
  placeholder?: string;
  placeholderColor?: string;
  editable?: boolean;
  style?: ViewStyle;
};

export const FlowDocSlateAdapter = forwardRef(
  (props: FlowDocSlateAdapterProps, ref: React.ForwardedRef<FlowDocInputHandle>) => {
    const initialContent = useMemo(
      () => slateDocumentToContent(props.initialDocument),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    const handleContent = useCallback(
      (content: FlowDocContent) => {
        props.onChange?.(contentToSlateDocument(content));
      },
      [props.onChange],
    );

    /* Native 拆段事件 = "用户按了 Enter"。caller 给了 onSubmitOnEnter 就当发送，
       不实际拆段；没给就 swallow（行为跟原 adapter 一致：Enter 当前不会插入 \n）。 */
    const onSubmit = props.onSubmitOnEnter;
    const handleSplit = useCallback(() => {
      if (onSubmit) onSubmit();
    }, [onSubmit]);

    return (
      <FlowDocInput
        ref={ref}
        style={props.style}
        initialContent={initialContent}
        textColor={props.textColor}
        pillBackgroundColor={props.pillBackgroundColor}
        pillTextColor={props.pillTextColor}
        fontSize={props.fontSize}
        lineHeight={props.lineHeight}
        pillMaxLabelTextWidth={props.pillMaxLabelTextWidth}
        placeholder={props.placeholder}
        placeholderColor={props.placeholderColor}
        editable={props.editable}
        onChangeContent={handleContent}
        onChangeSelection={props.onChangeSelection}
        onSplitRequest={handleSplit}
      />
    );
  },
);
FlowDocSlateAdapter.displayName = 'FlowDocSlateAdapter';
