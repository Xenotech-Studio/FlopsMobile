/**
 * 与 FlopsWeb / FlopsDesktop flowdoc-editor-core 节点 schema 对齐的 mobile 端类型声明。
 * spike 阶段先只覆盖 paragraph / heading-two / code / ref-pill 四种，验证管线后再补齐。
 */
import type { BaseEditor, Descendant } from 'slate';
import type { HistoryEditor } from 'slate-history';

export type ParagraphElement = {
  type: 'paragraph';
  children: Descendant[];
};

export type HeadingTwoElement = {
  type: 'heading-two';
  children: Descendant[];
};

export type CodeElement = {
  type: 'code';
  children: Descendant[];
};

export type RefPillElement = {
  type: 'ref-pill';
  refKey: string;
  mention: string;
  title?: string;
  isPointer?: boolean;
  children: [{ text: '' }];
};

export type BlockElement = ParagraphElement | HeadingTwoElement | CodeElement;
export type InlineElement = RefPillElement;
export type CustomElement = BlockElement | InlineElement;

export type CustomText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** 任意 CSS-style 颜色字符串（"#ff0000" / "tomato" / "rgba(...)"），与 web 端 Leaf.jsx 行为一致 */
  color?: string;
};

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & HistoryEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}
