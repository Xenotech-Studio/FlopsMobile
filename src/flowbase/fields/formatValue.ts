/**
 * 单元格值 → 展示字符串（只读渲染 & 记录卡片摘要用）。
 * 对齐 web FlowBaseView 的格式化语义（checkbox→✓、multi_select→顿号拼接等）。
 * checkbox / select / multi_select 在 CellRenderer 里有专门的视觉呈现，这里给纯文本兜底。
 */
import type { Field } from '../types';

export function formatValue(field: Field, value: unknown): string {
  if (value == null || value === '') return '';
  switch (field.type) {
    case 'checkbox':
      return value ? '✓' : '';
    case 'multi_select':
      return Array.isArray(value) ? value.map((v) => String(v)).join('、') : String(value);
    case 'number':
      return typeof value === 'number' ? String(value) : String(value);
    case 'date':
      // "YYYY-MM-DD"，后端已是该形态，直接展示
      return String(value);
    case 'datetime':
      return formatDateTime(String(value));
    default:
      return String(value);
  }
}

/** ISO-8601 → 本地「MM-DD HH:mm」；解析失败则原样返回。 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** select 选项配色（若 field.options.choices 里带 color）；否则返回 undefined 走默认底色。 */
export function selectChoiceColor(field: Field, value: string): string | undefined {
  const choices = (field.options?.choices as unknown) as
    | Array<{ name?: string; value?: string; color?: string } | string>
    | undefined;
  if (!Array.isArray(choices)) return undefined;
  for (const c of choices) {
    if (typeof c === 'string') continue;
    if ((c.value ?? c.name) === value && typeof c.color === 'string') return c.color;
  }
  return undefined;
}

/** select / multi_select 的候选项（归一为 {label, value}）。 */
export function choiceOptions(field: Field): Array<{ label: string; value: string }> {
  const choices = (field.options?.choices as unknown) as
    | Array<{ name?: string; value?: string; label?: string } | string>
    | undefined;
  if (!Array.isArray(choices)) return [];
  return choices.map((c) =>
    typeof c === 'string'
      ? { label: c, value: c }
      : { label: String(c.label ?? c.name ?? c.value ?? ''), value: String(c.value ?? c.name ?? '') },
  );
}
