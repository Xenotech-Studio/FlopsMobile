/** 仪表盘渲染共用的格式化 + 调色板（对齐 Web ChartRenderer 语义）。 */
import type { Field } from '../types';

export const CHART_PALETTE = [
  '#4f7cff',
  '#22b8a6',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#10b981',
  '#6366f1',
];

/** 数字友好格式：整数带千分位、其余最多两位小数；非数字原样。不用 Intl（Hermes 兼容）。 */
export function fmtNum(v: unknown): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const rounded = Number.isInteger(n) ? n : Math.round(n * 100) / 100;
  const neg = rounded < 0;
  const [intPart, decPart] = String(Math.abs(rounded)).split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withSep + (decPart ? '.' + decPart : '');
}

/** field_id → 显示名（找不到回落 id）。 */
export function fieldName(schema: Field[] | undefined, fid: string | undefined): string {
  if (!fid) return '';
  const f = (schema || []).find((x) => x.id === fid);
  return f ? f.name : fid;
}

/** 一组 group_by 键拼成类目标签（'East' / 'East · 2026'）。 */
export function groupLabel(group: Record<string, unknown> | undefined, groupBy: string[]): string {
  const keys = groupBy && groupBy.length ? groupBy : Object.keys(group || {});
  return keys
    .map((k) => {
      const v = group?.[k];
      return v == null || v === '' ? '(空)' : String(v);
    })
    .join(' · ');
}
