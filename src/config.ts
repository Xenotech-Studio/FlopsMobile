/**
 * 默认服务端地址，与 FlopsDesktop 一致；可通过登录页或环境覆盖。
 */
export const DEFAULT_SERVER_URL = 'http://flops.xenotech.studio/';

export function normalizeServerUrl(url: string): string {
  const u = (url || '').trim();
  if (!u) return DEFAULT_SERVER_URL;
  return u.endsWith('/') ? u : `${u}/`;
}
