type ParseReadPagesArgs = { goal: string; urls: string[]; parseError: boolean };

/**
 * 解析 read_pages 的 arguments（含 pending 阶段未闭合的 JSON 串）。
 * 半成品 JSON 时从头部的有效字段解析 goal / URLs，不把原始 JSON 当作展示文案。
 */
export function parseReadPagesBlockArgs(block: { arguments?: unknown }): ParseReadPagesArgs {
  const a = block?.arguments;
  const base: ParseReadPagesArgs = { goal: '', urls: [], parseError: false };
  if (a == null) return { ...base, parseError: true };

  if (typeof a === 'object' && a !== null && !Array.isArray(a)) {
    return fillFromObject(a, { ...base });
  }

  if (typeof a !== 'string') return { ...base, parseError: true };
  const trimmed = a.trim();
  if (!trimmed) return { ...base, parseError: true };

  try {
    const o = JSON.parse(trimmed) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) return fillFromObject(o as Record<string, unknown>, { ...base });
  } catch {
    const goal = extractGoalFromPartialJson(trimmed);
    const urls = extractUrlsFromPartialReadPagesJson(trimmed);
    return { goal, urls, parseError: true };
  }

  return { ...base, parseError: true };
}

function fillFromObject(
  o: Record<string, unknown>,
  out: ParseReadPagesArgs
): ParseReadPagesArgs {
  out.goal = typeof o.goal === 'string' ? o.goal.trim() : '';

  if (Array.isArray(o.items)) {
    for (const it of o.items) {
      if (it && typeof it === 'object' && typeof (it as Record<string, unknown>).url === 'string') {
        const u = (it as Record<string, unknown>).url.trim();
        if (u) out.urls.push(u);
      }
    }
  }

  if (out.urls.length === 0 && Array.isArray(o.urls)) {
    for (const u of o.urls) {
      if (typeof u === 'string' && u.trim()) out.urls.push(u.trim());
    }
  }

  if (out.urls.length === 0 && typeof o.urls === 'string') {
    out.urls = o.urls.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  return out;
}

function extractGoalFromPartialJson(s: string): string {
  const closed = s.match(/"goal"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (closed) {
    return closed[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .slice(0, 800);
  }

  const open = s.match(/"goal"\s*:\s*"([^"]*)/);
  if (open) return open[1].slice(0, 800);
  return '';
}

function extractUrlsFromPartialReadPagesJson(s: string): string[] {
  const set = new Set<string>();

  // 完整 "url":"https://..." 片段（已闭合引号）
  const reClosed = /"url"\s*:\s*"((?:https?:\/\/)(?:[^"\\]|\\.)*)"/gi;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = reClosed.exec(s)) !== null) {
    const raw = m[1];
    const u = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (isOkUrl(u)) set.add(u);
  }

  // 未闭合 url 串（只捕获到第一个可能的结束符附近）
  const reOpen = /"url"\s*:\s*"(https?:\/\/[^\s"}\],\]]*)/gi;
  // eslint-disable-next-line no-cond-assign
  while ((m = reOpen.exec(s)) !== null) {
    let u = m[1].replace(/[,;.)}\]]+$/, '');
    if (isOkUrl(u)) set.add(u);
  }

  // 宽松匹配裸 https://...（用于半成品 JSON）
  const loose = /https?:\/\/[^\s"'}\],\]]+/gi;
  // eslint-disable-next-line no-cond-assign
  while ((m = loose.exec(s)) !== null) {
    let u = m[0].replace(/[,;.)}\]]+$/, '');
    if (isOkUrl(u)) set.add(u);
  }

  return [...set];
}

function isOkUrl(u: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

type FileToolArgs = {
  pathDisplay: string;
  oldString: string;
  newString: string;
  content: string;
};

const FILE_TOOL_KEYS = ['path', 'file_path', 'content', 'old_string', 'oldText', 'new_string', 'newText'];

function tryParsePartialToolArgs(rawStr: string): Record<string, string> {
  const partial = tryParsePartialJson(rawStr || '', FILE_TOOL_KEYS);
  const out: Record<string, string> = {};
  for (const k of FILE_TOOL_KEYS) out[k] = partial[k] ?? '';
  return out;
}

export function parseFileToolArgs(block: { tool_name?: string; arguments?: unknown }): FileToolArgs {
  const empty: FileToolArgs = { pathDisplay: '', oldString: '', newString: '', content: '' };
  if (!block || (block.tool_name !== 'local_edit_file' && block.tool_name !== 'local_write_file')) return empty;

  const raw = block.arguments;
  let obj: Record<string, unknown> = {};
  try {
    if (typeof raw === 'string') obj = JSON.parse(raw || '{}') as Record<string, unknown>;
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) obj = raw as Record<string, unknown>;
  } catch {
    const partial = tryParsePartialToolArgs(typeof raw === 'string' ? raw : '');
    obj = partial as unknown as Record<string, unknown>;
  }

  /** 流式参数：即使 JSON.parse 已成功，半成品里 path/content 往往比已解析对象更长（与 Web parseFileToolArgs + tryParsePartial 一致） */
  if (typeof raw === 'string' && raw.trim()) {
    const partial = tryParsePartialToolArgs(raw);
    const pPath = [partial.path, partial.file_path].find((p) => typeof p === 'string' && p.trim())?.trim() ?? '';
    if (pPath && !([obj.path, obj.file_path].find((p) => typeof p === 'string' && p.trim()) as string | undefined)) {
      obj = { ...obj, path: pPath };
    }
    if (block.tool_name === 'local_write_file') {
      const jsonContent = typeof obj.content === 'string' ? obj.content : '';
      if (partial.content.length > jsonContent.length) {
        obj = { ...obj, content: partial.content };
      }
    }
    if (block.tool_name === 'local_edit_file') {
      const pickOld = () =>
        [obj.old_string, obj.oldText].find((s) => typeof s === 'string')?.toString() ?? '';
      const pickNew = () =>
        [obj.new_string, obj.newText].find((s) => typeof s === 'string')?.toString() ?? '';
      const o0 = pickOld();
      const n0 = pickNew();
      const oP = partial.old_string || partial.oldText;
      const nP = partial.new_string || partial.newText;
      if (oP.length > o0.length) obj = { ...obj, old_string: oP };
      if (nP.length > n0.length) obj = { ...obj, new_string: nP };
    }
  }

  const pathDisplay =
    [obj.path, obj.file_path].find((p) => typeof p === 'string' && p.trim())?.toString().trim() ?? '';

  if (block.tool_name === 'local_edit_file') {
    const oldString =
      [obj.old_string, obj.oldText].find((s) => typeof s === 'string')?.toString() ?? '';
    const newString =
      [obj.new_string, obj.newText].find((s) => typeof s === 'string')?.toString() ?? '';
    return { pathDisplay, oldString, newString, content: '' };
  }

  const content = typeof obj.content === 'string' ? obj.content : '';
  return { pathDisplay, oldString: '', newString: '', content };
}

const LOCAL_EXEC_COMMAND_TIMEOUT_CAP_SECONDS = 86400;

/** 与 FlopsDesktop runtime_service._executor_timeout_seconds 对 payload 的解析一致；无有效字段时为 cap */
export function coerceExecutorTimeoutSecondsFromPayload(
  obj: Record<string, unknown>,
  rawFallback: string
): number {
  const v = obj.timeout_seconds;
  let n: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.floor(v);
  else if (typeof v === 'string' && v.trim()) {
    const p = parseInt(v.trim(), 10);
    if (Number.isFinite(p)) n = p;
  }
  if ((n == null || n <= 0) && rawFallback) {
    const m = rawFallback.match(/"timeout_seconds"\s*:\s*(\d+)/);
    if (m) {
      const p = parseInt(m[1], 10);
      if (Number.isFinite(p) && p > 0) n = p;
    }
  }
  if (n == null || n <= 0) n = LOCAL_EXEC_COMMAND_TIMEOUT_CAP_SECONDS;
  return Math.min(Math.max(1, n), LOCAL_EXEC_COMMAND_TIMEOUT_CAP_SECONDS);
}

type ExecCommandArgs = {
  command: string;
  cwd: string;
  description: string;
  programName: string;
  timeoutSeconds: number;
};

export function parseExecCommandArgs(block: { tool_name?: string; arguments?: unknown }): ExecCommandArgs {
  const empty: ExecCommandArgs = {
    command: '',
    cwd: '',
    description: '',
    programName: '',
    timeoutSeconds: coerceExecutorTimeoutSecondsFromPayload({}, ''),
  };
  if (!block || block.tool_name !== 'local_exec_command') return empty;

  const raw = block.arguments;
  const rawStr = typeof raw === 'string' ? raw : '';
  let obj: Record<string, unknown> = {};
  try {
    if (typeof raw === 'string') obj = JSON.parse(raw || '{}') as Record<string, unknown>;
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) obj = raw as Record<string, unknown>;
  } catch {
    // ignore
  }

  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  const desc = typeof obj.description === 'string' ? obj.description.trim() : '';
  const cwd = typeof obj.cwd === 'string' ? obj.cwd.trim() : '';
  return {
    command,
    cwd,
    description: desc,
    programName: command ? command.split(/\s+/)[0].replace(/^.*\//, '') : '',
    timeoutSeconds: coerceExecutorTimeoutSecondsFromPayload(obj, rawStr),
  };
}

// ---------- read_pages result helpers (align with Desktop readPagesParseArgs + utils) ----------

export function readPagesResultEntryCount(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const o = result as Record<string, unknown>;
  const raw = o.readings ?? (Array.isArray(o.result) ? o.result : null);
  if (!raw) return 0;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'object') return Object.keys(raw).length;
  return 0;
}

export function readPagesReadingEntries(result: unknown): Array<[string, Record<string, unknown>]> {
  if (!result || typeof result !== 'object') return [];
  const o = result as Record<string, unknown>;
  const res = o.result ?? o;
  const raw = o.readings ?? (Array.isArray(res) ? res : null);
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((r, i) => [
      String((r && typeof r === 'object' && (r as Record<string, unknown>).url) ?? i),
      (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}) as Record<string, unknown>,
    ]);
  }
  if (typeof raw === 'object') return Object.entries(raw as Record<string, Record<string, unknown>>);
  return [];
}

/** 已结束该页加载的条数（loading !== true 即视为已结束） */
export function readPagesFinishedCount(result: unknown): number {
  const entries = readPagesReadingEntries(result);
  let n = 0;
  for (const [, r] of entries) {
    if (r && typeof r === 'object' && r.loading !== true) n += 1;
  }
  return n;
}

const READING_SUMMARY_KEYS = ['brief', 'source_type', 'how_introduces', 'reliable'];

/** 已知的“无可用内容”错误/占位文案（出现在 brief 或 content 时视为失败，与 Web/服务端语义一致） */
const READ_PAGES_KNOWN_ERROR_PHRASES = [
  '页面无法加载',
  '无法提供有效信息',
  '页面未抽取出有效正文',
  '无有效',
  '抓取失败',
];

function isReadPagesKnownErrorText(s: string): boolean {
  const t = String(s).trim();
  if (!t) return false;
  return READ_PAGES_KNOWN_ERROR_PHRASES.some((phrase) => t.includes(phrase));
}

export function readPagesReadingEntryHasUsableContent(r: Record<string, unknown>): boolean {
  if (!r || typeof r !== 'object') return false;
  const bodyStr =
    (typeof r.content === 'string' && r.content.trim()) ||
    (typeof r.text === 'string' && r.text.trim()) ||
    '';
  const finS = r.summary && typeof r.summary === 'object' ? (r.summary as Record<string, unknown>) : {};
  const finT = r.takeaway && typeof r.takeaway === 'object' ? (r.takeaway as Record<string, unknown>) : {};
  const hasSummary = READING_SUMMARY_KEYS.some(
    (k) => finS[k] != null && String(finS[k]).trim()
  );
  const answers = Array.isArray(finT.answers) ? finT.answers.filter((x) => x != null && String(x).trim()) : [];
  const quotes = Array.isArray(finT.quotes) ? finT.quotes.filter((x) => x != null && String(x).trim()) : [];
  const links = Array.isArray(r.links) ? r.links : [];
  const hasTakeawayOrLinks = answers.length > 0 || quotes.length > 0 || links.length > 0;
  if (hasTakeawayOrLinks) return true;
  if (bodyStr) {
    if (isReadPagesKnownErrorText(bodyStr)) return false;
    return true;
  }
  if (hasSummary) {
    const brief = String(finS.brief ?? '').trim();
    if (brief && isReadPagesKnownErrorText(brief)) return false;
    return true;
  }
  return links.length > 0;
}

/** 横向列表排序桶：0 进行中 → 1 已完成 → 2 已失败（与 Web ReadPagesNiceResult 一致） */
export function getReadPagesListSortBucket(r: Record<string, unknown>): number {
  if (!r || typeof r !== 'object') return 2;
  if (r.loading === true) return 0;
  if (r.error && String(r.error).trim()) return 2;
  if (!readPagesReadingEntryHasUsableContent(r)) return 2;
  return 1;
}

export function readPagesSuccessStats(result: unknown): { total: number; success: number } {
  const entries = readPagesReadingEntries(result);
  const total = entries.length;
  let success = 0;
  for (const [, r] of entries) {
    if (r && typeof r === 'object') {
      const err = r.error && String(r.error).trim();
      if (!err && readPagesReadingEntryHasUsableContent(r)) success += 1;
    }
  }
  return { total, success };
}

/** URL 百分号解码，用于标题/链接展示 */
export function decodeUrlPctForDisplay(s: string): string {
  if (typeof s !== 'string' || !s.includes('%')) return s;
  if (!/%[0-9A-Fa-f]{2}/i.test(s)) return s;
  try {
    let t = s.replace(/\+/g, ' ');
    for (let k = 0; k < 4; k++) {
      if (!/%[0-9A-Fa-f]{2}/i.test(t)) break;
      const next = decodeURIComponent(t);
      if (next === t) break;
      t = next;
    }
    return t;
  } catch {
    return s;
  }
}

// ---------- 流式 llm_raw 解析（与 Web tryParsePartialReadingStream 对齐） ----------

function tryParsePartialJson(rawStr: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = '';
  if (typeof rawStr !== 'string' || !rawStr.trim()) return out;
  const s = rawStr.trim();
  for (const key of keys) {
    const quoted = `"${key}"`;
    const idx = s.indexOf(quoted);
    if (idx === -1) continue;
    const afterKey = s.slice(idx + quoted.length);
    const colonMatch = afterKey.match(/^\s*:\s*"/);
    if (!colonMatch) continue;
    let i = colonMatch[0].length;
    let value = '';
    while (i < afterKey.length) {
      const c = afterKey[i];
      if (c === '\\' && i + 1 < afterKey.length) {
        const next = afterKey[i + 1];
        if (next === 'n') value += '\n';
        else if (next === 'r') value += '\r';
        else if (next === 't') value += '\t';
        else if (next === '"') value += '"';
        else if (next === '\\') value += '\\';
        else value += next;
        i += 2;
        continue;
      }
      if (c === '"') break;
      value += c;
      i += 1;
    }
    out[key] = value;
  }
  return out;
}

function tryParsePartialStringArrayJson(s: string, key: string): string[] {
  const out: string[] = [];
  const needle = `"${key}"`;
  const idx = s.indexOf(needle);
  if (idx === -1) return out;
  const rest = s.slice(idx + needle.length);
  const m = rest.match(/^\s*:\s*\[/);
  if (!m) return out;
  let i = m[0].length;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (rest[i] === ']') break;
    if (rest[i] !== '"') break;
    i++;
    let val = '';
    let closed = false;
    while (i < rest.length) {
      const c = rest[i];
      if (c === '\\' && i + 1 < rest.length) {
        const n = rest[i + 1];
        if (n === 'n') val += '\n';
        else if (n === 'r') val += '\r';
        else if (n === 't') val += '\t';
        else if (n === '"') val += '"';
        else if (n === '\\') val += '\\';
        else val += n;
        i += 2;
        continue;
      }
      if (c === '"') {
        closed = true;
        i++;
        break;
      }
      val += c;
      i++;
    }
    if (val.length > 0 || closed) out.push(val);
    if (!closed) break;
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (rest[i] === ',') i++;
  }
  return out;
}

const READING_SUMMARY_STRING_KEYS = ['brief', 'source_type', 'how_introduces', 'reliable'];

/**
 * 从流式 llm_raw（半成品 JSON）中解析 summary 与 takeaway，用于读页卡片流式展示。
 */
export function tryParsePartialReadingStream(rawStr: string): {
  summary: Record<string, string>;
  takeaway: { answers: string[]; quotes: string[] };
} {
  const summary: Record<string, string> = {};
  for (const k of READING_SUMMARY_STRING_KEYS) summary[k] = '';
  const takeaway = { answers: [] as string[], quotes: [] as string[] };
  if (typeof rawStr !== 'string' || !rawStr.trim()) return { summary, takeaway };
  const flat = tryParsePartialJson(rawStr, READING_SUMMARY_STRING_KEYS);
  for (const k of READING_SUMMARY_STRING_KEYS) summary[k] = flat[k] || '';
  takeaway.answers = tryParsePartialStringArrayJson(rawStr, 'answers');
  takeaway.quotes = tryParsePartialStringArrayJson(rawStr, 'quotes');
  return { summary, takeaway };
}

