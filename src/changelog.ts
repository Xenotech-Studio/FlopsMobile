export type ChangelogEntry = {
  version: string;
  date?: string;
  changes?: string[];
};

// 数据文件名不可为 changelog.json：Metro 解析 `from '../changelog'` 时 sourceExts 中 json 先于 ts，会错误绑定到 JSON 而非本文件。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const changelogData = require('./changelog.bundled.json') as ChangelogEntry[] | undefined;

export const CHANGELOG_ENTRIES: ChangelogEntry[] = Array.isArray(changelogData) ? changelogData : [];

export const CHANGELOG_BY_VERSION: Record<string, ChangelogEntry> = (() => {
  const map: Record<string, ChangelogEntry> = {};
  for (const entry of CHANGELOG_ENTRIES) {
    const key = entry?.version?.trim?.();
    if (!key) continue;
    map[key] = entry;
  }
  return map;
})();

export function getChangelogChanges(version: string | null | undefined): string[] {
  const v = version?.trim();
  if (!v) return [];
  const entry = CHANGELOG_BY_VERSION[v];
  const changes = entry?.changes;
  return Array.isArray(changes) ? changes.filter((x) => typeof x === 'string' && x.trim().length > 0) : [];
}

