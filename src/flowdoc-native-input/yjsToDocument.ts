/**
 * Yjs 二进制快照 → FlowDocDocument
 *
 * FlowDoc 的文档共享根是 ydoc.get('content', Y.XmlText)。我们用 @slate-yjs/core 的
 * `yTextToSlateElement` 把 Y.XmlText 转回 Slate 节点树（与 web 版 Editor 解析一致），
 * 然后把 web 的嵌套 schema 拍平成 mobile FlowDocBlocks 期望的扁平结构：
 *  - web `textblock(paragraph, ...nested)` → 一个 mobile `paragraph` + flatten 后续子块
 *  - web `headingblock(heading-N, ...nested)` → mobile `heading-N` + flatten 后续子块
 *  - web `quote(textblock(paragraph)...)` → 单段 mobile `quote`（多段用 \n 连接 inline）
 *  - web `bullet/numberedlistblock(paragraph, ...nested)` → 保留 listblock；inline 取主段
 *  - `code`/`image`/`divider`/`file_attachment` 直接保留
 * 这一层只读，写回去走 markdown 路线。
 */
import * as Y from 'yjs';
import { yTextToSlateElement } from '@slate-yjs/core';
import type { FlowDocBlock, FlowDocDocument } from './FlowDocBlocks';

type SlateNode = Record<string, any>;

function isTextLeaf(n: any): n is { text: string } & Record<string, unknown> {
  return n != null && typeof n.text === 'string' && typeof n.type !== 'string';
}

/** 从 paragraph / heading-N 节点的 children 取 mobile 兼容的 inline 数组。
 *  只保留 bold / italic / code / color marks；空段落给 [{text:''}]，避免 Slate normalize 错。 */
function inlineFromInlineParent(node: SlateNode | undefined): SlateNode[] {
  const children: SlateNode[] = Array.isArray(node?.children) ? node.children : [];
  const out: SlateNode[] = [];
  for (const c of children) {
    if (isTextLeaf(c)) {
      const leaf: SlateNode = { text: c.text };
      if (c.bold) leaf.bold = true;
      if (c.italic) leaf.italic = true;
      if (c.code) leaf.code = true;
      if (typeof c.color === 'string' && c.color) leaf.color = c.color;
      out.push(leaf);
    } else if (c && typeof c === 'object') {
      // unknown inline element (ref-pill 等)：原样塞进去，FlowDocBlocks 已经能渲染 ref-pill
      out.push(c);
    }
  }
  if (out.length === 0) out.push({ text: '' });
  return out;
}

const HEADING_TYPES = new Set([
  'heading-one',
  'heading-two',
  'heading-three',
  'heading-four',
  'heading-five',
  'heading-six',
]);

function collectAllText(node: SlateNode | undefined): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.children)) return '';
  let s = '';
  for (const c of node.children) s += collectAllText(c);
  return s;
}

/** 把 quote 内嵌套 textblock 的所有 paragraph 串成一段 inline（中间夹 '\n'）。 */
function flattenQuoteInline(quote: SlateNode): SlateNode[] {
  const inline: SlateNode[] = [];
  function visit(n: SlateNode) {
    if (!n || typeof n !== 'object') return;
    const t = (n as any).type;
    if (t === 'paragraph') {
      if (inline.length > 0) inline.push({ text: '\n' });
      inline.push(...inlineFromInlineParent(n));
      return;
    }
    if (Array.isArray((n as any).children)) {
      for (const c of (n as any).children) visit(c);
    }
  }
  visit(quote);
  return inline.length > 0 ? inline : [{ text: '' }];
}

function convertWebNode(n: SlateNode): FlowDocBlock[] {
  const t = String(n?.type || '');

  if (t === 'textblock') {
    const result: FlowDocBlock[] = [];
    const first = n.children?.[0];
    if (first?.type === 'paragraph') {
      result.push({
        type: 'paragraph',
        children: inlineFromInlineParent(first),
      } as FlowDocBlock);
    }
    if (Array.isArray(n.children)) {
      for (let i = 1; i < n.children.length; i++) {
        result.push(...convertWebNode(n.children[i]));
      }
    }
    return result;
  }

  if (t === 'headingblock') {
    const result: FlowDocBlock[] = [];
    const first = n.children?.[0];
    if (first && HEADING_TYPES.has(first.type)) {
      result.push({
        type: first.type as FlowDocBlock['type'],
        children: inlineFromInlineParent(first),
      } as FlowDocBlock);
    }
    if (Array.isArray(n.children)) {
      for (let i = 1; i < n.children.length; i++) {
        result.push(...convertWebNode(n.children[i]));
      }
    }
    return result;
  }

  if (t === 'bulletlistblock' || t === 'numberedlistblock') {
    const firstPara = n.children?.[0];
    const inline =
      firstPara?.type === 'paragraph'
        ? inlineFromInlineParent(firstPara)
        : [{ text: '' }];
    const nested: FlowDocBlock[] = [];
    if (Array.isArray(n.children)) {
      for (let i = 1; i < n.children.length; i++) {
        nested.push(...convertWebNode(n.children[i]));
      }
    }
    const block: any = {
      type: t,
      children: [...inline, ...nested],
    };
    if (typeof n.order_in_list === 'number') block.order_in_list = n.order_in_list;
    if (typeof n.numberingStyle === 'string') block.numberingStyle = n.numberingStyle;
    return [block as FlowDocBlock];
  }

  if (t === 'quote') {
    return [
      {
        type: 'quote',
        children: flattenQuoteInline(n),
      } as FlowDocBlock,
    ];
  }

  if (t === 'code') {
    return [
      {
        type: 'code',
        children: [{ text: collectAllText(n) }],
      } as FlowDocBlock,
    ];
  }

  if (t === 'paragraph') {
    return [
      {
        type: 'paragraph',
        children: inlineFromInlineParent(n),
      } as FlowDocBlock,
    ];
  }

  if (HEADING_TYPES.has(t)) {
    return [
      {
        type: t as FlowDocBlock['type'],
        children: inlineFromInlineParent(n),
      } as FlowDocBlock,
    ];
  }

  if (t === 'divider') {
    return [{ type: 'divider', children: [{ text: '' }] }];
  }

  if (t === 'image') {
    return [
      {
        type: 'image',
        url: typeof n.url === 'string' ? n.url : undefined,
        alt: typeof n.alt === 'string' ? n.alt : undefined,
        width: typeof n.width === 'number' ? n.width : undefined,
        height: typeof n.height === 'number' ? n.height : undefined,
        children: [{ text: '' }],
      } as FlowDocBlock,
    ];
  }

  if (t === 'file_attachment') {
    return [
      {
        type: 'file_attachment',
        url: typeof n.url === 'string' ? n.url : undefined,
        filename: typeof n.filename === 'string' ? n.filename : undefined,
        mime_type: typeof n.mime_type === 'string' ? n.mime_type : undefined,
        size: typeof n.size === 'number' ? n.size : undefined,
        children: [{ text: '' }],
      } as FlowDocBlock,
    ];
  }

  if (Array.isArray(n.children) && n.children.length > 0) {
    return n.children.flatMap((c: SlateNode) => convertWebNode(c));
  }

  return [];
}

/**
 * 把 FlowDoc 的 Y.Doc 二进制快照解码为 mobile 端的 FlowDocDocument。
 * 解析失败（坏字节 / 空快照）返回单个空段落，避免上层崩。
 */
export function decodeFlowDocSnapshotToDocument(bytes: Uint8Array): FlowDocDocument {
  const empty: FlowDocDocument = [{ type: 'paragraph', children: [{ text: '' }] }];
  if (!bytes || bytes.length === 0) return empty;
  const yDoc = new Y.Doc();
  try {
    Y.applyUpdate(yDoc, bytes);
  } catch {
    return empty;
  }
  let slateRoot: { children?: SlateNode[] };
  try {
    const xmlText = yDoc.get('content', Y.XmlText as any) as Y.XmlText;
    slateRoot = yTextToSlateElement(xmlText);
  } catch {
    return empty;
  }
  const children = slateRoot?.children;
  if (!Array.isArray(children) || children.length === 0) return empty;
  const blocks: FlowDocBlock[] = [];
  for (const c of children) {
    blocks.push(...convertWebNode(c));
  }
  return blocks.length > 0 ? blocks : empty;
}
