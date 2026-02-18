/**
 * HTTP 请求调试日志：封装 fetch 并打印完整请求/响应（可配置、可截断）。
 * 仅在 __DEV__ 时生效；可通过 ENABLE_HTTP_DEBUG 强制开启。
 */

const TAG = '[FlopsMobile HTTP]';
const MAX_BODY_LOG = 1200;
const MAX_HEADERS_LOG = 600;
const IN_APP_LOG_MAX_LINES = 80;

const ENABLE_HTTP_DEBUG = typeof __DEV__ !== 'undefined' ? __DEV__ : true;

/** 应用内可见的日志行（不依赖 Metro），便于在设备上直接查看 */
const inAppLogLines: string[] = [];

function pushInAppLog(line: string) {
  inAppLogLines.push(line);
  if (inAppLogLines.length > IN_APP_LOG_MAX_LINES) inAppLogLines.shift();
}

/** 获取当前缓存的 HTTP 调试日志（供应用内「查看日志」使用） */
export function getHttpDebugLogLines(): string[] {
  return [...inAppLogLines];
}

/** 清空应用内日志缓存 */
export function clearHttpDebugLog(): void {
  inAppLogLines.length = 0;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + ` … [截断，共 ${str.length} 字]`;
}

function headersToObject(h: Headers | Record<string, string> | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const o: Record<string, string> = {};
    h.forEach((v, k) => { o[k] = v; });
    return o;
  }
  return { ...h };
}

function maskSecretHeaders(obj: Record<string, string>): Record<string, string> {
  const out = { ...obj };
  if (out.Authorization) out.Authorization = 'Bearer ***';
  if (out.authorization) out.authorization = 'Bearer ***';
  return out;
}

/** 打日志时对请求体做脱敏（如 password） */
function sanitizeBodyForLog(body: string): string {
  return body.replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"');
}

function logLine(level: 'log' | 'warn', ...args: unknown[]) {
  (level === 'warn' ? console.warn : console.log)(...args);
}

function logRequest(method: string, url: string, headers: Record<string, string>, body: string | null) {
  const h = truncate(JSON.stringify(maskSecretHeaders(headers), null, 0), MAX_HEADERS_LOG);
  const b = body == null ? '(无)' : truncate(sanitizeBodyForLog(body), MAX_BODY_LOG);
  const lines = [`${TAG} >>> ${method} ${url}`, `${TAG}     Request Headers: ${h}`, `${TAG}     Request Body: ${b}`];
  lines.forEach((l) => { logLine('warn', l); pushInAppLog(l); });
}

function logResponse(status: number, statusText: string, headers: Record<string, string>, body: string | null) {
  const h = truncate(JSON.stringify(maskSecretHeaders(headers), null, 0), MAX_HEADERS_LOG);
  const b = body == null ? '(无)' : truncate(body, MAX_BODY_LOG);
  const lines = [`${TAG} <<< ${status} ${statusText}`, `${TAG}     Response Headers: ${h}`, `${TAG}     Response Body: ${b}`];
  lines.forEach((l) => { logLine('warn', l); pushInAppLog(l); });
}

/**
 * 带完整调试日志的 fetch：打印请求 URL/方法/头/体，以及响应状态/头/体（流式响应仅标 [streaming]）。
 * 使用方式：用 fetchWithDebugLog 替代 fetch，返回值与 fetch 一致。
 */
export async function fetchWithDebugLog(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method || 'GET').toUpperCase();
  const reqHeaders = headersToObject(init?.headers as Headers | Record<string, string> | undefined);
  let reqBody: string | null = null;
  if (init?.body != null) {
    if (typeof init.body === 'string') reqBody = init.body;
    else if (typeof (init.body as { toString?: () => string }).toString === 'function') reqBody = (init.body as { toString: () => string }).toString();
    else reqBody = '[非字符串 body]';
  }

  if (ENABLE_HTTP_DEBUG) {
    logRequest(method, url, reqHeaders, reqBody);
  }

  try {
    const res = await (fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(input, init);
    const resHeaders = headersToObject(res.headers);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    if (ENABLE_HTTP_DEBUG) {
      if (contentType.includes('event-stream') || contentType.includes('stream')) {
        logResponse(res.status, res.statusText, resHeaders, '[streaming，不打印 body]');
      } else {
        try {
          const clone = res.clone();
          const text = await clone.text();
          logResponse(res.status, res.statusText, resHeaders, text);
        } catch (e) {
          logResponse(res.status, res.statusText, resHeaders, `(读取 body 失败: ${e})`);
        }
      }
    }

    return res;
  } catch (err) {
    if (ENABLE_HTTP_DEBUG) {
      const msg = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : 'Error';
      const lines = [`${TAG} <<< 请求未得到响应（网络/超时等）`, `${TAG}     ${name}: ${msg}`];
      lines.forEach((l) => { logLine('warn', l); pushInAppLog(l); });
    }
    throw err;
  }
}
