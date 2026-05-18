/**
 * flopsRefs - 聊天里 user 消息的 `metadata.flops_refs` 引用项工具
 *
 * 数据模型对齐 Web/Desktop：
 *   {
 *     key: 'flowdoc_full:<docId>' | 'flowdoc_selection:<docId>:<lineRange>:<len>:<head>' | …
 *     kind: 'flowdoc_full' | 'flowdoc_selection' | …
 *     title: 'XX 文档'
 *     content_md: '<可选>选中片段的 markdown'
 *     char_count: number
 *     source: { doc_id, line_start?, line_end? }
 *     mention_text: '@XX 文档' | '@XX 文档 (12-34)' | '@XX·摘录'
 *     captured_at?: number
 *   }
 *
 * 与 native FlowDocInput 的 pill 互转：
 *   FlopsRef ↔ FlowDocContentPart('pill') / Slate ref-pill node
 */

import type { SlateDocument } from '../flowdoc-native-input';
import type { Descendant } from 'slate';

export type FlopsRefSource = {
  doc_id?: string;
  line_start?: number;
  line_end?: number;
  [k: string]: unknown;
};

export type FlopsRef = {
  key: string;
  kind: string;
  title?: string;
  content_md?: string;
  char_count?: number;
  source?: FlopsRefSource;
  mention_text?: string;
  captured_at?: number;
};

/** 把后端 metadata.flops_refs（unknown[]）安全收敛成本地 FlopsRef[]，丢掉无效项 */
export function normalizeFlopsRefs(raw: unknown): FlopsRef[] {
  if (!Array.isArray(raw)) return [];
  const out: FlopsRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const ref = r as Record<string, unknown>;
    const mention = typeof ref.mention_text === 'string' ? ref.mention_text : '';
    if (!mention) continue;
    const key =
      typeof ref.key === 'string' && ref.key
        ? ref.key
        : ensureFlopsRefKey({
            kind: typeof ref.kind === 'string' ? ref.kind : 'ref',
            mention_text: mention,
            source:
              ref.source && typeof ref.source === 'object'
                ? (ref.source as FlopsRefSource)
                : undefined,
          });
    out.push({
      key,
      kind: typeof ref.kind === 'string' ? ref.kind : 'ref',
      title: typeof ref.title === 'string' ? ref.title : undefined,
      content_md: typeof ref.content_md === 'string' ? ref.content_md : undefined,
      char_count: typeof ref.char_count === 'number' ? ref.char_count : undefined,
      source:
        ref.source && typeof ref.source === 'object'
          ? (ref.source as FlopsRefSource)
          : undefined,
      mention_text: mention,
      captured_at:
        typeof ref.captured_at === 'number' ? ref.captured_at : undefined,
    });
  }
  return out;
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** 与 Web 端 insertRefIntoComposer 的 key 规则对齐：旧消息缺 key 时尽力稳定推导 */
export function ensureFlopsRefKey(ref: {
  key?: string;
  kind?: string;
  mention_text?: string;
  source?: FlopsRefSource;
}): string {
  if (ref.key && ref.key.trim()) return ref.key.trim();
  const kind = String(ref.kind || 'ref');
  const docId =
    ref.source && typeof ref.source.doc_id === 'string'
      ? ref.source.doc_id.trim()
      : '';
  const mention = String(ref.mention_text || '');
  if (kind === 'flowdoc_full' && docId) return `flowdoc_full:${docId}`;
  if (docId) return `${kind}:${docId}:${mention.length}:${hashStr(mention)}`;
  return `${kind}:${hashStr(mention + JSON.stringify(ref.source || {}))}`;
}

/** 把一段纯文本按 refs 的 mention_text 子串切片：命中处替换为 'pill' 段，其它保持 'text' */
export type ContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'pill'; ref: FlopsRef };

export function splitContentByRefs(
  text: string,
  refs: FlopsRef[],
): ContentSegment[] {
  const refList = refs.filter(
    (r) => typeof r.mention_text === 'string' && r.mention_text.length > 0,
  );
  if (refList.length === 0 || !text) {
    return text ? [{ kind: 'text', text }] : [];
  }
  /* 长 mention 优先匹配，避免 "@DocA" 被 "@Doc" 截掉 */
  const sorted = [...refList].sort(
    (a, b) => String(b.mention_text).length - String(a.mention_text).length,
  );
  const escaped = sorted
    .map((r) => String(r.mention_text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const pattern = new RegExp(escaped, 'g');
  const byMention = new Map<string, FlopsRef>();
  for (const r of sorted) {
    const k = String(r.mention_text);
    if (!byMention.has(k)) byMention.set(k, r);
  }
  const out: ContentSegment[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > cursor) out.push({ kind: 'text', text: text.slice(cursor, m.index) });
    const ref = byMention.get(m[0]);
    if (ref) out.push({ kind: 'pill', ref });
    cursor = m.index + m[0].length;
    if (m[0].length === 0) pattern.lastIndex = cursor + 1;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}

/**
 * 把 content + flops_refs hydrate 成 SlateDocument（带 ref-pill）。
 * 切行：每个 '\n' → 新 paragraph。
 * 对齐 web composerHydrateFromUserMessage.buildSlateDocumentFromUserMessageContent。
 */
export function hydrateUserMessageToSlateDocument(
  content: string,
  refs: FlopsRef[],
): SlateDocument {
  const lines = (content ?? '').split('\n');
  const matchedKeys = new Set<string>();
  const paragraphs = lines.map((line) => {
    const pieces = splitContentByRefs(line, refs);
    const children: Descendant[] = [];
    for (const p of pieces) {
      if (p.kind === 'pill') {
        matchedKeys.add(p.ref.key);
        const mention =
          (p.ref.mention_text && p.ref.mention_text.trim()) ||
          `@${String(p.ref.title || '').trim()}`;
        children.push({
          type: 'ref-pill',
          refKey: p.ref.key,
          mention,
          title: p.ref.title || '',
          /* content_md 有内容 = 摘录引用；空 = 整篇指针 */
          isPointer: !p.ref.content_md,
          children: [{ text: '' }],
        } as unknown as Descendant);
      } else if (p.text.length > 0) {
        children.push({ text: p.text } as Descendant);
      }
    }
    if (children.length === 0) children.push({ text: '' } as Descendant);
    return { type: 'paragraph' as const, children };
  });
  /* mention_text 在正文里没匹配上的 ref：追加到末尾，避免编辑时丢失。 */
  const unmatched = refs.filter((r) => !matchedKeys.has(r.key));
  if (unmatched.length > 0) {
    if (paragraphs.length === 0) {
      paragraphs.push({ type: 'paragraph' as const, children: [{ text: '' } as Descendant] });
    }
    const last = paragraphs[paragraphs.length - 1];
    const kids = [...last.children];
    for (const r of unmatched) {
      const mention = r.mention_text || `@${r.title || ''}`;
      kids.push({
        type: 'ref-pill',
        refKey: r.key,
        mention,
        title: r.title || '',
        isPointer: !r.content_md,
        children: [{ text: '' }],
      } as unknown as Descendant);
      kids.push({ text: ' ' } as Descendant);
    }
    paragraphs[paragraphs.length - 1] = {
      type: 'paragraph' as const,
      children: kids,
    };
  }
  return paragraphs.length > 0
    ? paragraphs
    : [{ type: 'paragraph', children: [{ text: '' } as Descendant] }];
}

/**
 * 把编辑器里的 SlateDocument 序列化回 { content, flops_refs }：
 *  - content：把 ref-pill 还原为它的 mention_text；paragraphs 之间用 '\n' 拼起来
 *  - flops_refs：按 pill 出现顺序去重，去 refDataByKey 查完整记录
 *
 * @param refDataByKey - 编辑过程中应该一直维护这张表，键 = ref.key
 */
export function serializeSlateDocumentToUserMessage(
  doc: SlateDocument,
  refDataByKey: Map<string, FlopsRef>,
): { content: string; flops_refs: FlopsRef[] } {
  const lines: string[] = [];
  const seenKeys = new Set<string>();
  const flops_refs: FlopsRef[] = [];

  for (const para of doc) {
    let line = '';
    for (const node of para.children) {
      const anyNode = node as Record<string, unknown>;
      if (anyNode.type === 'ref-pill') {
        const refKey = String(anyNode.refKey || '');
        const mention = String(anyNode.mention || '');
        line += mention;
        if (refKey && !seenKeys.has(refKey)) {
          seenKeys.add(refKey);
          const rec = refDataByKey.get(refKey);
          if (rec) {
            flops_refs.push(rec);
          } else {
            /* 兜底：refDataByKey 缺记录时（理论不该），用 pill 上自带的最小信息留个占位 */
            flops_refs.push({
              key: refKey,
              kind: 'ref',
              title: typeof anyNode.title === 'string' ? anyNode.title : undefined,
              content_md: '',
              char_count: 0,
              source: {},
              mention_text: mention,
            });
          }
        }
      } else if (typeof anyNode.text === 'string') {
        line += anyNode.text;
      }
    }
    lines.push(line);
  }

  return { content: lines.join('\n'), flops_refs };
}

/** 给一个 FlopsRef 算出在 composer 里要 insertPill 的 (mention, title, isPointer)。 */
export function refToPillArgs(ref: FlopsRef): {
  refKey: string;
  mention: string;
  title: string;
  isPointer: boolean;
} {
  const mention = (ref.mention_text && ref.mention_text.trim()) || `@${ref.title || ''}`;
  return {
    refKey: ref.key,
    mention,
    title: ref.title || '',
    isPointer: !ref.content_md,
  };
}

/** 截短 mention 标题（与 Web `truncateMentionTitle` 对齐：12 个 Unicode 字符上限） */
export function truncateMentionTitle(s: string, maxChars = 12): string {
  const str = String(s || '').trim();
  if (!str) return '';
  const arr = Array.from(str);
  if (arr.length <= maxChars) return str;
  return arr.slice(0, maxChars).join('') + '…';
}

/** 整篇引用 helper：(docId, title) → 一条 flowdoc_full FlopsRef */
export function buildFlowDocFullRef(docId: string, title: string): FlopsRef {
  const id = docId.trim();
  const name = title.trim() || id;
  return {
    key: `flowdoc_full:${id}`,
    kind: 'flowdoc_full',
    title: name,
    content_md: '',
    char_count: 0,
    source: { doc_id: id },
    mention_text: `@${truncateMentionTitle(name)}`,
  };
}
