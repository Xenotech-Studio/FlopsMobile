/**
 * composerAttachments - 聊天输入区「发送文件」的上传 + 出站消息拼装
 *
 * 数据流对齐 Web/Desktop：
 *   选文件 → POST /api/file_to_url（multipart）拿 COS URL → 作为 `flops_attachment`
 *   content part 放进**数组形态**的 message 发送（server `_extract_flops_attachments_from_raw_message`
 *   只在 message 是 list 时才解析附件）。
 *
 * 注意：文件附件走 `flops_attachment` 通道，与 FlowDoc 引用的 `flops_refs` 通道**互不相干**，
 * 不经过 composer 的 ref-pill / insertPill。
 */

import type { Session } from '../api';
import type { FlopsAttachment } from '../utils/chatLocalMessages';

/** composer 里待发送的附件（上传中 / 就绪 / 失败）；就绪后其 url 进 flops_attachment。 */
export type PendingAttachment = {
  id: string;
  name: string;
  mime: string;
  size?: number;
  status: 'uploading' | 'ready' | 'error';
  /** 本地源 URI（file:// / content://）：图片附件用它直接渲染缩略图，无需等 COS 上传完。 */
  uri?: string;
  /** 上传成功后的 COS URL */
  url?: string;
  error?: string;
};

/** 字节数格式化成 B / KB / MB / GB（对齐 Desktop 附件大小展示）。空/非法 → 空串。 */
export function formatFileSize(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const shown = i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0);
  return `${shown} ${units[i]}`;
}

/** 非图片附件的文件类型图标 + 配色（Ionicons 名 + 图标色 + 淡底色）。按 mime / 扩展名分类。 */
export function fileTypeMeta(
  mime: string,
  name: string,
): { icon: string; color: string; tint: string } {
  const m = (mime || '').toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  const mk = (icon: string, color: string) => ({ icon, color, tint: `${color}22` });
  if (m.startsWith('video/')) return mk('videocam', '#ec4899');
  if (m.startsWith('audio/')) return mk('musical-notes', '#8b5cf6');
  if (m === 'application/pdf' || ext === 'pdf') return mk('document-text', '#ef4444');
  if (/word|document/.test(m) || ['doc', 'docx'].includes(ext)) return mk('document-text', '#2563eb');
  if (/sheet|excel|csv/.test(m) || ['xls', 'xlsx', 'csv'].includes(ext)) return mk('grid', '#16a34a');
  if (/presentation|powerpoint/.test(m) || ['ppt', 'pptx'].includes(ext)) return mk('easel', '#ea580c');
  if (/zip|compressed|tar|rar|7z/.test(m) || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext))
    return mk('archive', '#d97706');
  if (
    /json|javascript|typescript|xml|html|css/.test(m) ||
    ['js', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'py', 'java', 'c', 'cpp', 'sh', 'md'].includes(ext)
  )
    return mk('code-slash', '#6366f1');
  return mk('document', '#64748b');
}

/** 出站 chat message 的 content part（对齐 web buildChatOutboundMessage）。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | {
      type: 'flops_attachment';
      url: string;
      filename: string;
      presentation: 'url_only';
      mime_type?: string;
    };

function ensureSlash(u: string): string {
  return u.endsWith('/') ? u : u + '/';
}

/**
 * 上传单个文件到 `/api/file_to_url`（multipart form：folder + file）。
 * 用 RN 的 FormData + fetch —— 原生网络层能直接吃 picker 给的 file:// / content:// URI，
 * 不用 blob-util 手动 wrap 路径。返回 COS URL。
 */
export async function uploadComposerFile(
  session: Session,
  file: { uri: string; name: string; mime: string },
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const url = `${ensureSlash(session.server_base_url)}api/file_to_url`;
  const fd = new FormData();
  fd.append('folder', '');
  // RN FormData 文件段：{ uri, name, type }（DOM 类型不认，cast 掉）
  fd.append('file', {
    uri: file.uri,
    name: file.name || 'attachment',
    type: file.mime || 'application/octet-stream',
  } as unknown as Blob);

  const res = await fetch(url, {
    method: 'POST',
    // 不手动设 Content-Type —— 让 RN 自动带上 multipart boundary
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: fd,
    signal,
  });
  if (!res.ok) {
    let detail = `上传失败: ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (j?.detail) {
        detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      }
    } catch {
      /* 响应不是 JSON，保留 HTTP 状态兜底文案 */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as { url?: string };
  if (!data?.url) throw new Error('上传未返回 URL');
  return { url: data.url };
}

const isImageMime = (m?: string): boolean => !!m && m.startsWith('image/');

/**
 * 把正文文本 + 已就绪附件拼成出站 message：
 *  - 无附件 → 返回纯字符串（保持旧行为，server 兼容 string）
 *  - 有附件 → 返回多模态数组（text part + 每个附件的 flops_attachment part；图片附件另加 image_url 让 LLM 看得见）
 * 对齐 web src/utils/chatImageAttachments.js buildChatOutboundMessage。
 */
export function buildOutboundChatMessage(
  textTrim: string,
  attachments: FlopsAttachment[],
): string | ChatContentPart[] {
  const items = attachments || [];
  if (items.length === 0) return textTrim;

  const hasImages = items.some((a) => isImageMime(a.mime_type));
  const hasFiles = items.some((a) => !isImageMime(a.mime_type));
  let text = textTrim;
  if (!text) {
    if (hasImages && !hasFiles) {
      text = '请结合图片回复。';
    } else if (hasFiles && !hasImages) {
      text = '请根据聊天附件处理（附件仅提供 URL，需时请用工具读取内容）。';
    } else {
      text = '请结合图片与附件处理（非图片附件仅提供 URL，需时请用工具读取内容）。';
    }
  }

  const parts: ChatContentPart[] = [{ type: 'text', text }];
  for (const it of items) {
    const isImage = isImageMime(it.mime_type);
    if (isImage) {
      // 视觉通道：让 LLM 真的"看见"图
      parts.push({ type: 'image_url', image_url: { url: it.url } });
    }
    const row: ChatContentPart = {
      type: 'flops_attachment',
      url: it.url,
      filename: it.filename || (isImage ? 'image' : 'attachment'),
      presentation: 'url_only',
    };
    if (it.mime_type) row.mime_type = it.mime_type;
    parts.push(row);
  }
  return parts;
}

/** 把已就绪的 PendingAttachment 收敛成 FlopsAttachment[]（发送 / 乐观渲染用）。 */
export function readyAttachmentsToFlops(pending: PendingAttachment[]): FlopsAttachment[] {
  return (pending || [])
    .filter((a) => a.status === 'ready' && a.url)
    .map((a) => ({
      url: a.url as string,
      filename: a.name || 'attachment',
      ...(a.mime ? { mime_type: a.mime } : {}),
      ...(typeof a.size === 'number' ? { size: a.size } : {}),
    }));
}
