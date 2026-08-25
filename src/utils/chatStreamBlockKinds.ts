/**
 * 流式块的种类判定（纯谓词，无渲染依赖）。
 *
 * 原本内联在 ChatScreen.tsx 模块级；消息区抽成 ChatMessageArea 后两边都要用，
 * 提到这里避免 ChatScreen ↔ ChatMessageArea 反向 import 成环。
 */

const TOOL_PACKAGE_NAV_NAMES = ['open_tool_packages', 'close_tool_packages'];

export function isToolPackageNavBlock(b: { type: string; tool_name?: string }): boolean {
  return b.type === 'tool' && b.tool_name != null && TOOL_PACKAGE_NAV_NAMES.includes(b.tool_name);
}

/* 闭合思考块作为前驱：下一段 markdown 文本应贴紧（对齐 FlopsWeb
   .tool-cards-wrap > .thinking-block.closed + .assistant-text-block 的紧凑处理） */
export function isClosedThinkingBlock(b: {
  type: string;
  closed?: boolean;
}): boolean {
  return b.type === 'thinking' && b.closed === true;
}
