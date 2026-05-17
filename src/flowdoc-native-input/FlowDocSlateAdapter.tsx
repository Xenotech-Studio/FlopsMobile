/**
 * FlowDocSlateAdapter
 *
 * 把 native FlowDocInput 接到 Slate 数据层：
 * - 输入：Slate paragraph children（{text:...} 与 {type:'ref-pill',...} 混排）
 * - 输出：onChange 回调送回新的 Slate children
 *
 * 注意：当前只做内容层面的对应；Slate selection / cursor 的精确映射需要在
 * native 端选区 offset ↔ Slate (leafIdx, offset) 之间做转换，先 deferred 到 v1.5。
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

export type SlateParagraphChildren = Descendant[];

type SlateMarkedText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  color?: string;
};

function slateLeafToMarks(leaf: SlateMarkedText): FlowDocContentPart {
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

function slateToContent(children: SlateParagraphChildren): FlowDocContent {
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
        out.push(slateLeafToMarks(leaf));
      }
    }
  }
  return out;
}

function contentToSlate(content: FlowDocContent): SlateParagraphChildren {
  return content.map((p: FlowDocContentPart): Descendant => {
    if (p.type === 'pill') {
      return {
        type: 'ref-pill',
        refKey: p.refKey,
        mention: p.mention,
        title: p.title,
        isPointer: p.isPointer,
        children: [{ text: '' }],
      } as unknown as Descendant;
    }
    const leaf: Record<string, unknown> = { text: p.text };
    if (p.marks?.bold) leaf.bold = true;
    if (p.marks?.italic) leaf.italic = true;
    if (p.marks?.code) leaf.code = true;
    if (p.marks?.color) leaf.color = p.marks.color;
    return leaf as unknown as Descendant;
  });
}

export type FlowDocSlateAdapterProps = {
  /** Slate paragraph 的 children；只在首次 render 用作 initialContent。
   *  之后内容由 native 端为 truth，通过 onChange 反向同步到 Slate */
  initialChildren: SlateParagraphChildren;
  onChange?: (children: SlateParagraphChildren) => void;
  onChangeSelection?: (start: number, end: number) => void;
  textColor?: string;
  pillBackgroundColor?: string;
  pillTextColor?: string;
  fontSize?: number;
  lineHeight?: number;
  placeholder?: string;
  placeholderColor?: string;
  editable?: boolean;
  style?: ViewStyle;
};

export const FlowDocSlateAdapter = forwardRef(
  (props: FlowDocSlateAdapterProps, ref: React.ForwardedRef<FlowDocInputHandle>) => {
    const initialContent = useMemo(
      () => slateToContent(props.initialChildren),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    const handleContent = useCallback(
      (content: FlowDocContent) => {
        props.onChange?.(contentToSlate(content));
      },
      [props.onChange],
    );

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
        placeholder={props.placeholder}
        placeholderColor={props.placeholderColor}
        editable={props.editable}
        onChangeContent={handleContent}
        onChangeSelection={props.onChangeSelection}
      />
    );
  },
);
FlowDocSlateAdapter.displayName = 'FlowDocSlateAdapter';
