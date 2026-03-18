/**
 * 与 FlopsWeb toolResultPatch.js 对齐。
 * 框架统一推 SSE；工具侧决定 stream_sink 时机；此处仅合并 chunk → result。
 */

function getAtPath(root: Record<string, unknown>, pathStr: string): unknown {
  let cur: unknown = root;
  for (const p of pathStr.split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const o = cur as Record<string, unknown> | unknown[];
    cur = /^\d+$/.test(p) ? (o as unknown[])[Number(p)] : (o as Record<string, unknown>)[p];
  }
  return cur;
}

function setAtPath(root: Record<string, unknown>, pathStr: string, value: unknown): void {
  const parts = pathStr.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(next);
    if (/^\d+$/.test(p)) {
      const idx = Number(p);
      const arr = cur as unknown[];
      while (arr.length <= idx) arr.push(nextIsIndex ? [] : {});
      const el = arr[idx];
      if (el == null || typeof el !== 'object') arr[idx] = nextIsIndex ? [] : {};
      cur = arr[idx];
    } else {
      const o = cur as Record<string, unknown>;
      if (o[p] == null || typeof o[p] !== 'object') o[p] = nextIsIndex ? [] : {};
      cur = o[p];
    }
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    const idx = Number(last);
    const arr = cur as unknown[];
    while (arr.length <= idx) arr.push(null);
    arr[idx] = value;
  } else {
    (cur as Record<string, unknown>)[last] = value as never;
  }
}

function appendAtPath(root: Record<string, unknown>, pathStr: string, suffix: string): void {
  const cur = getAtPath(root, pathStr);
  const next =
    (typeof cur === 'string' ? cur : cur == null ? '' : String(cur)) + suffix;
  setAtPath(root, pathStr, next);
}

export function applyToolResultPatches(
  result: Record<string, unknown>,
  patches: unknown
): Record<string, unknown> {
  const out = { ...result };
  const list = Array.isArray(patches) ? patches : patches ? [patches] : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const op = (p as { op?: string }).op;
    const path = typeof (p as { path?: string }).path === 'string' ? (p as { path: string }).path : '';
    if (!path) continue;
    if (op === 'append') {
      appendAtPath(out, path, String((p as { value?: unknown }).value ?? ''));
    } else if (op === 'set') {
      setAtPath(out, path, (p as { value: unknown }).value);
    }
  }
  return out;
}

export function mergeToolResultChunk(
  prev: unknown,
  chunk: {
    patches?: unknown;
    readings_by_url?: Record<string, unknown>;
    stdout_append?: string;
    set?: Record<string, unknown>;
  }
): Record<string, unknown> {
  let result: Record<string, unknown> =
    prev != null && typeof prev === 'object' && !Array.isArray(prev)
      ? { ...(prev as Record<string, unknown>) }
      : {};
  if (chunk.patches != null) {
    result = applyToolResultPatches(result, chunk.patches);
  }
  if (typeof chunk.stdout_append === 'string') {
    result.stdout = String(result.stdout || '') + chunk.stdout_append;
  }
  if (chunk.set != null && typeof chunk.set === 'object') {
    result = { ...result, ...chunk.set };
  }
  if (chunk.readings_by_url != null && typeof chunk.readings_by_url === 'object') {
    const prevR = result.readings;
    const base =
      prevR != null && typeof prevR === 'object' && !Array.isArray(prevR)
        ? { ...(prevR as Record<string, unknown>) }
        : {};
    result = { ...result, readings: { ...base, ...chunk.readings_by_url } };
  }
  return result;
}
