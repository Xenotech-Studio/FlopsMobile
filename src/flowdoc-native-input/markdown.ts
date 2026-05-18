/**
 * FlowDocDocument ↔ Markdown 序列化
 *
 * 端口自 FlopsWeb src/flowdoc-editor-core/markdown.js 的核心格式约定：
 *  - paragraph：直接输出 inline；连续 paragraph 之间空一行
 *  - heading-N：`#` × N + 空格 + inline
 *  - code：``` 围栏
 *  - quote：每行加 `> `
 *  - divider：`---`
 *  - bulletlistblock：`- ` 前缀，按 depth 缩进 2 空格 / 层
 *  - numberedlistblock：`{order_in_list}. ` 前缀，同样缩进
 *  - image：`![alt](url)`
 *  - file_attachment：`[filename](url "flopsfile:card::-1")`
 *
 * Inline marks：
 *  - bold：`<b>…</b>`（web 用 HTML 标签避开 ** 歧义）
 *  - italic：`<i>…</i>`
 *  - bold+italic：`<b><i>…</i></b>`
 *  - inline code：`` `…` ``
 *  - color：纯文本（markdown 不带颜色，原信息在持久化时丢，跟 web 行为一致）
 *  - ref-pill：emit mention_text；真正 ref 数据在 metadata.flops_refs（这一层不处理）
 *
 * 反向解析 v1 只覆盖最常见 block（paragraph / heading-N / code / quote / divider /
 * bullet/numbered list），inline 仅 `…` 和 <b>/<i>。复杂场景（嵌套 list 多层、HTML
 * 混排）落到 paragraph 兜底，保留原文本。
 */
import type { Descendant } from 'slate';
import type {
  FlowDocBlock,
  FlowDocDocument,
} from './FlowDocBlocks';

/* ============================================================
 * doc → markdown
 * ============================================================ */

export function documentToMarkdown(doc: FlowDocDocument): string {
  return blocksToMarkdown(doc, 0).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function blocksToMarkdown(blocks: FlowDocDocument, depth: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const next = blocks[i + 1];
    const lines = blockToMarkdown(block, depth);
    for (const line of lines) out.push(line);
    // 段间空行：相邻两个 block 之间一律空一行（除非都是同类 list block，紧贴更自然）
    const isList = (b?: FlowDocBlock) =>
      b?.type === 'bulletlistblock' || b?.type === 'numberedlistblock';
    if (next && !(isList(block) && isList(next))) {
      out.push('');
    }
  }
  return out;
}

function blockToMarkdown(block: FlowDocBlock, depth: number): string[] {
  switch (block.type) {
    case 'paragraph':
      return [inlineToMarkdown(block.children)];
    case 'heading-one':
    case 'heading-two':
    case 'heading-three':
    case 'heading-four':
    case 'heading-five':
    case 'heading-six': {
      const level = headingLevelFromType(block.type);
      return ['#'.repeat(level) + ' ' + inlineToMarkdown(block.children)];
    }
    case 'code': {
      const text = extractPlainText(block.children);
      return ['```', ...text.split('\n'), '```'];
    }
    case 'quote': {
      // 内部 children 通常是 paragraph[]，递归再每行前加 "> "
      const inner = blocksToMarkdown(block.children as unknown as FlowDocDocument, depth);
      return inner.map((l) => (l.length > 0 ? `> ${l}` : '>'));
    }
    case 'divider':
      return ['---'];
    case 'bulletlistblock':
    case 'numberedlistblock': {
      const { inline, nested } = splitListChildren(block.children);
      const marker =
        block.type === 'numberedlistblock'
          ? `${(block as { order_in_list?: number }).order_in_list ?? 1}.`
          : '-';
      const indent = '  '.repeat(depth);
      const head = `${indent}${marker} ${inlineToMarkdown(inline)}`;
      const childLines = blocksToMarkdown(
        nested as unknown as FlowDocDocument,
        depth + 1,
      );
      return [head, ...childLines];
    }
    case 'image': {
      const b = block as { type: 'image'; url?: string; alt?: string };
      return [`![${escapeMd(b.alt ?? '')}](${b.url ?? ''})`];
    }
    case 'file_attachment': {
      const b = block as {
        type: 'file_attachment';
        url?: string;
        filename?: string;
        mime_type?: string;
        size?: number;
      };
      const fn = (b.filename ?? 'attachment').replace(/\]/g, '\\]');
      const url = b.url ?? '';
      const mime = b.mime_type ?? '';
      const size = typeof b.size === 'number' && b.size >= 0 ? String(b.size) : '';
      const title = `flopsfile:card:${mime}:${size}`.replace(/:+$/, '');
      return [`[${fn}](${url} "${title}")`];
    }
    default:
      return [];
  }
}

function inlineToMarkdown(children: Descendant[]): string {
  return children.map(inlineNodeToMarkdown).join('');
}

function inlineNodeToMarkdown(node: Descendant): string {
  const anyNode = node as Record<string, unknown>;
  // ref-pill：emit mention_text；真正 ref 由 metadata 持久化
  if (anyNode.type === 'ref-pill') {
    return String((anyNode as { mention?: string }).mention || '');
  }
  // text leaf
  const text = typeof anyNode.text === 'string' ? (anyNode.text as string) : '';
  if (anyNode.code) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/([*`#[\]])/g, '\\$1');
    return '`' + escaped + '`';
  }
  let wrapped = anyNode.bold || anyNode.italic ? escapeHtmlInTag(text) : escapeMd(text);
  if (anyNode.bold && anyNode.italic) {
    wrapped = `<b><i>${wrapped}</i></b>`;
  } else if (anyNode.bold) {
    wrapped = `<b>${wrapped}</b>`;
  } else if (anyNode.italic) {
    wrapped = `<i>${wrapped}</i>`;
  }
  return wrapped;
}

function escapeMd(s: string): string {
  // 跟 web 实现一致：只转义 markdown 真敏感的 `*` `` ` `` `#` `[` `]`，不转 `_`
  return s.replace(/\\/g, '\\\\').replace(/([*`#[\]])/g, '\\$1');
}

function escapeHtmlInTag(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractPlainText(children: Descendant[]): string {
  return children
    .map((n) => {
      const an = n as Record<string, unknown>;
      if (an.type && an.children) {
        return extractPlainText(an.children as Descendant[]);
      }
      return typeof an.text === 'string' ? (an.text as string) : '';
    })
    .join('');
}

function headingLevelFromType(t: string): number {
  switch (t) {
    case 'heading-one': return 1;
    case 'heading-two': return 2;
    case 'heading-three': return 3;
    case 'heading-four': return 4;
    case 'heading-five': return 5;
    case 'heading-six': return 6;
    default: return 1;
  }
}

function splitListChildren(children: Descendant[]): {
  inline: Descendant[];
  nested: Descendant[];
} {
  const blockTypes = new Set([
    'paragraph', 'heading-one', 'heading-two', 'heading-three',
    'heading-four', 'heading-five', 'heading-six',
    'code', 'quote', 'divider',
    'bulletlistblock', 'numberedlistblock', 'image', 'file_attachment',
  ]);
  let i = 0;
  for (; i < children.length; i++) {
    const c = children[i] as { type?: string };
    if (c && c.type && blockTypes.has(c.type)) break;
  }
  return { inline: children.slice(0, i), nested: children.slice(i) };
}

/* ============================================================
 * markdown → doc（v1 简版）
 *
 * 覆盖：heading / divider / code fence / blockquote / 简单 list / paragraph
 * inline：`code`、<b>/<i> 标签
 * 不覆盖：复杂嵌套 list / 表格 / image / file_attachment 反解
 * ============================================================ */

export function markdownToDocument(md: string): FlowDocDocument {
  const lines = md.split('\n');
  const out: FlowDocDocument = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 跳过空行
    if (trimmed === '') {
      i += 1;
      continue;
    }
    // 分割线
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      out.push({ type: 'divider', children: [{ text: '' }] });
      i += 1;
      continue;
    }
    // 代码块（``` 围栏）
    if (/^```/.test(trimmed)) {
      i += 1;
      const buf: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾的 ```
      out.push({ type: 'code', children: [{ text: buf.join('\n') }] });
      continue;
    }
    // heading
    const hm = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const lvl = hm[1].length;
      const types: FlowDocBlock['type'][] = [
        'heading-one', 'heading-two', 'heading-three',
        'heading-four', 'heading-five', 'heading-six',
      ];
      out.push({
        type: types[lvl - 1] as Exclude<FlowDocBlock['type'], 'divider' | 'image' | 'file_attachment'>,
        children: parseInlineMarkdown(hm[2]),
      } as FlowDocBlock);
      i += 1;
      continue;
    }
    // blockquote：累积所有连续 `> ` 开头的行
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      const inner = markdownToDocument(buf.join('\n'));
      out.push({
        type: 'quote',
        children: inner as unknown as Descendant[],
      } as FlowDocBlock);
      continue;
    }
    // bullet / numbered list（顶层一行；嵌套 v1 不展开）
    const lm = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (lm) {
      const isOrdered = /\d+\./.test(lm[2]);
      const num = isOrdered ? parseInt(lm[2], 10) : undefined;
      out.push({
        type: isOrdered ? 'numberedlistblock' : 'bulletlistblock',
        order_in_list: num,
        children: parseInlineMarkdown(lm[3]),
      } as unknown as FlowDocBlock);
      i += 1;
      continue;
    }
    // 默认：累积成一个 paragraph，吃到下一空行 / 特殊行为止
    const paraLines: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|_{3,}|\*{3,})$/.test(lines[i].trim()) &&
      !/^```/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i]) &&
      !lines[i].match(/^(\s*)([-*+]|\d+\.)\s+/)
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    out.push({
      type: 'paragraph',
      children: parseInlineMarkdown(paraLines.join('\n')),
    });
  }
  return out;
}

/** 内联解析：行内 code、<b>/<i> 标签 */
function parseInlineMarkdown(text: string): Descendant[] {
  /* 简单分词：找 `…`、<b>…</b>、<i>…</i>、<b><i>…</i></b>，其余作为普通文本。
     v1 不处理嵌套和 ** __ 之类。 */
  const out: Descendant[] = [];
  let cursor = 0;
  const len = text.length;
  const pushText = (s: string, marks?: Partial<{ bold: boolean; italic: boolean; code: boolean }>) => {
    if (s.length === 0) return;
    const leaf: Record<string, unknown> = { text: s };
    if (marks?.bold) leaf.bold = true;
    if (marks?.italic) leaf.italic = true;
    if (marks?.code) leaf.code = true;
    out.push(leaf as unknown as Descendant);
  };

  while (cursor < len) {
    // inline code: `...`（不含 \`）
    if (text[cursor] === '`') {
      const close = text.indexOf('`', cursor + 1);
      if (close > cursor) {
        pushText(text.slice(cursor + 1, close).replace(/\\([*`#[\]\\])/g, '$1'), { code: true });
        cursor = close + 1;
        continue;
      }
    }
    // <b><i>…</i></b>
    if (text.startsWith('<b><i>', cursor)) {
      const close = text.indexOf('</i></b>', cursor + 6);
      if (close > cursor) {
        pushText(unescapeHtmlInTag(text.slice(cursor + 6, close)), { bold: true, italic: true });
        cursor = close + '</i></b>'.length;
        continue;
      }
    }
    // <b>…</b>
    if (text.startsWith('<b>', cursor)) {
      const close = text.indexOf('</b>', cursor + 3);
      if (close > cursor) {
        pushText(unescapeHtmlInTag(text.slice(cursor + 3, close)), { bold: true });
        cursor = close + 4;
        continue;
      }
    }
    // <i>…</i>
    if (text.startsWith('<i>', cursor)) {
      const close = text.indexOf('</i>', cursor + 3);
      if (close > cursor) {
        pushText(unescapeHtmlInTag(text.slice(cursor + 3, close)), { italic: true });
        cursor = close + 4;
        continue;
      }
    }
    // 普通文本：吃到下一个标记起点
    const nextMark = nextMarkIndex(text, cursor + 1);
    const piece = text.slice(cursor, nextMark);
    pushText(piece.replace(/\\([*`#[\]\\])/g, '$1'));
    cursor = nextMark;
  }
  if (out.length === 0) out.push({ text: '' } as unknown as Descendant);
  return out;
}

function nextMarkIndex(text: string, from: number): number {
  const markers = ['`', '<b>', '<i>'];
  let best = text.length;
  for (const m of markers) {
    const at = text.indexOf(m, from);
    if (at >= 0 && at < best) best = at;
  }
  return best;
}

function unescapeHtmlInTag(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
