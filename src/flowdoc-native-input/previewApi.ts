/**
 * 视频预览镜像 API 客户端（mobile 版，对齐 web 的 flowdoc-editor-core/previewApi.js）。
 *
 * flowdoc 渲染引擎本身不耦合 session / api 层：宿主 app 在启动（且 session 就绪）时一次性注入
 * 真正的实现：
 *
 *   import { setPreviewApiImpl } from './flowdoc-native-input/previewApi';
 *   setPreviewApiImpl(session ? {
 *     readByUrl: (url) => getVideoPreviewByUrl(session, url),
 *     triggerForUrl: (url, fn, mt) => triggerVideoPreview(session, url, fn, mt),
 *   } : null);
 *
 * 没注入时（未登录 / 宿主无转码后端）所有调用静默返回 null，VideoPreviewPlayer 退化为
 * "直接播原始 URL"，与接入前行为一致。
 */

export type VideoPreview = {
  /** pending | ready | failed | skipped | ... */
  state: string;
  /** state==='ready' 时为转码后 H.264 镜像的 URL */
  url?: string;
  source_codec?: string;
  source_profile?: string;
  kind?: string;
  reason?: string;
  error?: string;
};

type PreviewApiImpl = {
  readByUrl: (url: string) => Promise<VideoPreview | null>;
  triggerForUrl: (
    url: string,
    filename: string,
    mimeType: string,
  ) => Promise<VideoPreview | null>;
};

let _impl: PreviewApiImpl | null = null;

export function setPreviewApiImpl(impl: PreviewApiImpl | null): void {
  _impl = impl;
}

/** 宿主是否接好了转码后端（= 是否注入了实现）。无后端时隐藏"重新生成"等按钮。 */
export function hasPreviewApiSupport(): boolean {
  return !!_impl;
}

/** GET /api/preview/by-url：读 sidecar 转码状态；无支持 / 失败返回 null。 */
export async function readPreviewByUrl(url: string): Promise<VideoPreview | null> {
  if (!url || !_impl) return null;
  try {
    return await _impl.readByUrl(url);
  } catch {
    return null;
  }
}

/** POST /api/preview/trigger：对一个原始视频 URL 触发后台 H.264 转码；无支持 / 失败返回 null。 */
export async function triggerPreviewForUrl(
  url: string,
  filename: string,
  mimeType: string,
): Promise<VideoPreview | null> {
  if (!url || !_impl) return null;
  try {
    return await _impl.triggerForUrl(url, filename, mimeType);
  } catch {
    return null;
  }
}
