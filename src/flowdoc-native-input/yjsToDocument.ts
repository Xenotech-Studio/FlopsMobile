/**
 * Yjs 二进制快照 → FlowDocDocument
 *
 * FlowDoc 的文档共享根是 ydoc.get('content', Y.XmlText)。我们用 @slate-yjs/core 的
 * `yTextToSlateElement` 把 Y.XmlText 转回 Slate 节点树（与 web 版 Editor 解析一致），
 * 然后把 web 的嵌套 schema 转成 mobile FlowDocBlocks 期望的结构（**无损保留嵌套**）：
 *  - web `textblock(paragraph)`（无嵌套）→ 一个 mobile `paragraph`
 *  - web `textblock(paragraph, ...nested)`（有嵌套）→ mobile `textblock` 容器：inline 头 + 嵌套块尾
 *  - web `headingblock(heading-N, ...nested)` → mobile `heading-N` + flatten 后续子块（heading 嵌套罕见，暂拍平）
 *  - web `quote(textblock(paragraph)...)` → mobile `quote`，children 保留为真实嵌套块（段落/列表等）
 *  - web `bullet/numberedlistblock(paragraph, ...nested)` → 保留 listblock；inline 取主段
 *  - `code`/`image`/`divider`/`file_attachment` 直接保留；image 含 caption
 *  - 所有块的 `indent`（web 自主缩进级数）一并透传
 * 这一层只读，写回去走 markdown 路线。
 */
import * as Y from 'yjs';
import { yTextToSlateElement } from '@slate-yjs/core';
import type { FlowDocBlock, FlowDocDocument } from './FlowDocBlocks';

type SlateNode = Record<string, any>;

function isTextLeaf(n: any): n is { text: string } & Record<string, unknown> {
  return n != null && typeof n.text === 'string' && typeof n.type !== 'string';
}

/** 从一个 text leaf 取 mobile 兼容的 marks（bold/italic/code/color/link）。
 *  linkOverride：来自包裹的 link 元素的 url，优先于 leaf 自带的 link。 */
function textLeafFrom(c: SlateNode, linkOverride?: string): SlateNode {
  const leaf: SlateNode = { text: c.text };
  if (c.bold) leaf.bold = true;
  if (c.italic) leaf.italic = true;
  if (c.code) leaf.code = true;
  if (typeof c.color === 'string' && c.color) leaf.color = c.color;
  const link =
    linkOverride || (typeof c.link === 'string' && c.link ? c.link : '');
  if (link) leaf.link = link;
  return leaf;
}

/** 从 paragraph / heading-N 节点的 children 取 mobile 兼容的 inline 数组。
 *  - text leaf：保留 bold / italic / code / color / link marks
 *  - link 元素 `{type:'link', url, children}`：摊平为带 link mark 的文本（对齐 web 行内链接）
 *  - 其它未知 inline（ref-pill / equation / inline file_attachment 等）：原样透传
 *  空段落给 [{text:''}]，避免 Slate normalize 错。 */
function inlineFromInlineParent(node: SlateNode | undefined): SlateNode[] {
  const children: SlateNode[] = Array.isArray(node?.children) ? node.children : [];
  const out: SlateNode[] = [];
  for (const c of children) {
    if (isTextLeaf(c)) {
      out.push(textLeafFrom(c));
    } else if (c && typeof c === 'object' && c.type === 'link') {
      const url = typeof c.url === 'string' ? c.url : '';
      const sub: SlateNode[] = Array.isArray(c.children) ? c.children : [];
      for (const lc of sub) {
        if (isTextLeaf(lc)) out.push(textLeafFrom(lc, url));
      }
    } else if (c && typeof c === 'object') {
      // unknown inline element (ref-pill 等)：原样塞进去，FlowDocBlocks 已经能渲染 ref-pill
      out.push(c);
    }
  }
  if (out.length === 0) out.push({ text: '' });
  return out;
}

/** mobile 原生引擎只能行内渲染 text/pill，无法行内渲染附件卡片。所以把 inline-parent 里的
 *  file_attachment void 提升成独立块（用卡片渲染），返回去掉附件后的 inline + 提升出来的块。
 *  这样 web 里"段落内唯一一个 file_attachment void"（独占一行的附件）不会被丢成空行。 */
function extractInlineAttachments(node: SlateNode | undefined): {
  inline: SlateNode[];
  hoisted: FlowDocBlock[];
} {
  const children: SlateNode[] = Array.isArray(node?.children) ? node.children : [];
  const kept: SlateNode[] = [];
  const hoisted: FlowDocBlock[] = [];
  for (const c of children) {
    if (c && typeof c === 'object' && (c as any).type === 'file_attachment') {
      // 卡片 / 单行链接两种都提升成独立块（display 字段透传，渲染时按它分卡片 or 单行链接）。
      // 真·行内（嵌进文字流）需要原生 NSTextAttachment，后续再做。
      hoisted.push(...convertWebNode(c));
    } else {
      kept.push(c);
    }
  }
  if (hoisted.length === 0) return { inline: inlineFromInlineParent(node), hoisted };
  return { inline: inlineFromInlineParent({ children: kept }), hoisted };
}

/** inline 数组是否有"真实内容"（非空文本 / pill 等元素）；只有空文本 [{text:''}] 视为无内容 */
function inlineHasRealContent(inline: SlateNode[]): boolean {
  return inline.some(
    (p) =>
      (typeof p.text === 'string' && p.text.length > 0) ||
      (p && typeof p === 'object' && typeof p.type === 'string'),
  );
}

/** 读取 web block 的自主缩进级数（indent）；缺省 / 非正数视为无缩进。 */
function readIndent(n: SlateNode): number | undefined {
  const v = (n as any)?.indent;
  return typeof v === 'number' && v > 0 ? v : undefined;
}

/** 校验并取出图片裁剪矩形（0–1 归一化 {x,y,width,height}）；非法返回 undefined。 */
function readCropRect(
  c: any,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const { x, y, width, height } = c;
  if (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    width > 0 &&
    height > 0
  ) {
    return { x, y, width, height };
  }
  return undefined;
}

/** 把 web 节点的 indent 透传到 mobile block 上（原地写、返回同对象，方便链式）。 */
function withIndent(block: any, n: SlateNode): any {
  const ind = readIndent(n);
  if (ind !== undefined) block.indent = ind;
  return block;
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

function convertWebNode(n: SlateNode): FlowDocBlock[] {
  const t = String(n?.type || '');

  if (t === 'textblock') {
    const first = n.children?.[0];
    // 头部段落里的 file_attachment void 提升成独立卡片块（mobile 无法行内渲染附件）
    const { inline, hoisted: headAtt } =
      first?.type === 'paragraph'
        ? extractInlineAttachments(first)
        : { inline: [{ text: '' }] as SlateNode[], hoisted: [] as FlowDocBlock[] };
    const nested: FlowDocBlock[] = [];
    if (Array.isArray(n.children)) {
      for (let i = 1; i < n.children.length; i++) {
        nested.push(...convertWebNode(n.children[i]));
      }
    }
    // 无嵌套：等价于普通段落（保持顶层文档主体是 paragraph，不平白引入容器）。
    if (nested.length === 0) {
      const out: FlowDocBlock[] = [];
      if (headAtt.length === 0 || inlineHasRealContent(inline)) {
        out.push(withIndent({ type: 'paragraph', children: inline } as FlowDocBlock, n));
      }
      out.push(...headAtt);
      return out;
    }
    // 有嵌套：保留为 textblock 容器（inline 头 + 嵌套块尾，渲染时缩进 nested），无损。
    // 头部附件作为容器后的兄弟卡片块（罕见组合，简单处理）。
    return [
      withIndent({ type: 'textblock', children: [...inline, ...nested] } as FlowDocBlock, n),
      ...headAtt,
    ];
  }

  if (t === 'headingblock') {
    const result: FlowDocBlock[] = [];
    const first = n.children?.[0];
    if (first && HEADING_TYPES.has(first.type)) {
      result.push(
        withIndent(
          {
            type: first.type as FlowDocBlock['type'],
            children: inlineFromInlineParent(first),
          } as FlowDocBlock,
          n,
        ),
      );
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
    return [withIndent(block, n) as FlowDocBlock];
  }

  if (t === 'quote') {
    // 无损：把 quote 内部的 textblock/段落/列表等转成真实嵌套块，渲染交给 NestedBlocks 递归。
    const nested: FlowDocBlock[] = [];
    if (Array.isArray(n.children)) {
      for (const c of n.children) nested.push(...convertWebNode(c));
    }
    return [
      withIndent(
        {
          type: 'quote',
          children:
            nested.length > 0
              ? (nested as unknown as SlateNode[])
              : [{ type: 'paragraph', children: [{ text: '' }] }],
        } as FlowDocBlock,
        n,
      ),
    ];
  }

  if (t === 'table') {
    // 结构：table > tableRow > tableCell > block[]（cell 是 mini-doc，复用 convertWebNode 转单元格内块）。
    const rows: SlateNode[] = [];
    if (Array.isArray(n.children)) {
      for (const r of n.children) {
        if (r?.type !== 'tableRow') continue;
        const cells: SlateNode[] = [];
        if (Array.isArray(r.children)) {
          for (const c of r.children) {
            if (c?.type !== 'tableCell') continue;
            const cellBlocks: FlowDocBlock[] = [];
            if (Array.isArray(c.children)) {
              for (const cb of c.children) cellBlocks.push(...convertWebNode(cb));
            }
            if (cellBlocks.length === 0) {
              cellBlocks.push({ type: 'paragraph', children: [{ text: '' }] } as FlowDocBlock);
            }
            cells.push({
              type: 'tableCell',
              isHeader: !!c.isHeader,
              bgColor: typeof c.bgColor === 'string' && c.bgColor ? c.bgColor : undefined,
              children: cellBlocks as unknown as SlateNode[],
            });
          }
        }
        rows.push({ type: 'tableRow', children: cells });
      }
    }
    if (rows.length === 0) return [];
    const block: any = { type: 'table', children: rows };
    if (Array.isArray(n.align)) block.align = n.align;
    if (Array.isArray(n.colWidths)) block.colWidths = n.colWidths;
    return [withIndent(block as FlowDocBlock, n)];
  }

  if (t === 'code') {
    return [
      withIndent(
        {
          type: 'code',
          children: [{ text: collectAllText(n) }],
        } as FlowDocBlock,
        n,
      ),
    ];
  }

  if (t === 'paragraph') {
    const { inline, hoisted } = extractInlineAttachments(n);
    const out: FlowDocBlock[] = [];
    // 段落只有附件(无真实文本)时，不产出空段落，只留附件卡片
    if (hoisted.length === 0 || inlineHasRealContent(inline)) {
      out.push(withIndent({ type: 'paragraph', children: inline } as FlowDocBlock, n));
    }
    out.push(...hoisted);
    return out;
  }

  if (HEADING_TYPES.has(t)) {
    return [
      withIndent(
        {
          type: t as FlowDocBlock['type'],
          children: inlineFromInlineParent(n),
        } as FlowDocBlock,
        n,
      ),
    ];
  }

  if (t === 'divider') {
    return [withIndent({ type: 'divider', children: [{ text: '' }] }, n)];
  }

  if (t === 'image') {
    return [
      withIndent(
        {
          type: 'image',
          url: typeof n.url === 'string' ? n.url : undefined,
          alt: typeof n.alt === 'string' ? n.alt : undefined,
          caption:
            typeof n.caption === 'string' && n.caption ? n.caption : undefined,
          width: typeof n.width === 'number' ? n.width : undefined,
          height: typeof n.height === 'number' ? n.height : undefined,
          crop: readCropRect(n.crop),
          children: [{ text: '' }],
        } as FlowDocBlock,
        n,
      ),
    ];
  }

  if (t === 'file_attachment') {
    return [
      withIndent(
        {
          type: 'file_attachment',
          url: typeof n.url === 'string' ? n.url : undefined,
          filename: typeof n.filename === 'string' ? n.filename : undefined,
          mime_type: typeof n.mime_type === 'string' ? n.mime_type : undefined,
          display: n.display === 'inline' ? 'inline' : 'card',
          // web 字段是 size_bytes；兼容旧 size
          size:
            typeof n.size_bytes === 'number'
              ? n.size_bytes
              : typeof n.size === 'number'
                ? n.size
                : undefined,
          children: [{ text: '' }],
        } as FlowDocBlock,
        n,
      ),
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
