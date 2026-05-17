/**
 * 创建 RN 版 Slate editor。与 web 的 withReact 等价：把 inline / void 等 schema 决策挂到 editor 上。
 * 注意：这里不引 slate-react —— 渲染 / 输入桥由我们自己写（per-leaf TextInput 路线）。
 */
import { createEditor as createSlateEditor, type Editor as SlateEditor } from 'slate';
import { withHistory } from 'slate-history';

export function createEditor(): SlateEditor {
  const editor = withHistory(createSlateEditor());

  const { isInline, isVoid } = editor;
  editor.isInline = (el) => (el.type === 'ref-pill' ? true : isInline(el));
  editor.isVoid = (el) => (el.type === 'ref-pill' ? true : isVoid(el));

  return editor;
}
