/**
 * 解析 search_engine 的 arguments，得到 queries、search_goal。
 * 与 FlopsDesktop `searchEngineParseArgs.js` 逻辑 1:1。
 */

export type SearchEngineParsedArgs = {
  queries: string[];
  search_goal: string;
  parseError: boolean;
};

function fillFromObject(o: Record<string, unknown>, out: SearchEngineParsedArgs): SearchEngineParsedArgs {
  if (Array.isArray(o.queries)) {
    for (const q of o.queries) {
      if (q != null && String(q).trim()) out.queries.push(String(q).trim());
    }
  }
  if (out.queries.length === 0 && typeof o.query === 'string' && o.query.trim()) {
    out.queries.push(o.query.trim());
  }
  if (typeof o.search_goal === 'string' && o.search_goal.trim()) {
    out.search_goal = o.search_goal.trim();
  }
  return out;
}

/** 从半成品 JSON 中提取 queries 数组项 */
function extractQueriesFromPartialJson(s: string): string[] {
  const list: string[] = [];
  const re = /"queries"\s*:\s*\[([\s\S]*?)(?:\]|$)/;
  const m = s.match(re);
  if (!m) return list;
  const inner = m[1];
  const quoted = /"(?:[^"\\]|\\.)*"/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(inner)) !== null) {
    const raw = match[0];
    const unescaped = raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
    if (unescaped.trim()) list.push(unescaped.trim());
  }
  return list;
}

function extractSearchGoalFromPartialJson(s: string): string {
  const m = s.match(/"search_goal"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').trim();
  }
  return '';
}

type BlockLike = {
  arguments?: string | Record<string, unknown> | null;
};

export function parseSearchEngineBlockArgs(block: BlockLike | null | undefined): SearchEngineParsedArgs {
  const a = block?.arguments;
  const base: SearchEngineParsedArgs = { queries: [], search_goal: '', parseError: false };
  if (a == null) {
    return { ...base, parseError: true };
  }
  if (typeof a === 'object' && a !== null && !Array.isArray(a)) {
    return fillFromObject(a as Record<string, unknown>, { ...base });
  }
  if (typeof a !== 'string') {
    return { ...base, parseError: true };
  }
  const trimmed = a.trim();
  if (!trimmed) {
    return { ...base, parseError: true };
  }
  try {
    const o = JSON.parse(trimmed) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      return fillFromObject(o as Record<string, unknown>, { ...base });
    }
  } catch {
    const queries = extractQueriesFromPartialJson(trimmed);
    const search_goal = extractSearchGoalFromPartialJson(trimmed);
    return { queries, search_goal, parseError: true };
  }
  return { ...base, parseError: true };
}
