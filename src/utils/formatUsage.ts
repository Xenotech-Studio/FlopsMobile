import { formatUsdCnyHeaderMoney } from './usageDisplay';
import type { UsageCurrencyMode } from '../constants/pricingDisplay';
import type { UsageStats, ConversationMessage, ContextSummary } from '../api';

function totalTokensFromUsage(u: UsageStats | null | undefined): number {
  if (!u || typeof u !== 'object') return 0;
  let tt = Number(u.total_tokens);
  if (!Number.isFinite(tt) || tt < 0) tt = 0;
  const pt = Number(u.prompt_tokens) || 0;
  const ct = Number(u.completion_tokens) || 0;
  if (tt === 0 && (pt > 0 || ct > 0)) tt = pt + ct;
  return tt;
}

export function formatUsageTiny(u: UsageStats | null | undefined, options?: { currencyMode?: UsageCurrencyMode }): string {
  const currencyMode = options?.currencyMode ?? 'both';
  if (!u || typeof u !== 'object') return '';
  const tt = totalTokensFromUsage(u);
  const cost = u.estimated_cost_usd;
  const costStr =
    cost != null && Number(cost) > 0 ? ` · ${formatUsdCnyHeaderMoney(Number(cost), currencyMode)}` : '';
  return `耗 ${tt} tok${costStr}`;
}

/**
 * 当前会话若有 active 上下文摘要，返回「按服务端原始消息条数」计的已压缩比例 0–100（null 表示无摘要或未生效）。
 * 与 FlopsDesktop `formatUsage.js` / flops-chat-ui 逻辑一致。
 */
export function getConversationContextCompressMessagePercent(conv: {
  messages?: ConversationMessage[] | null;
  active_context_summary_id?: string | null;
  context_summaries?: ContextSummary[] | null;
} | null | undefined): number | null {
  if (!conv || typeof conv !== 'object') return null;
  const aidRaw = conv.active_context_summary_id;
  const aid = typeof aidRaw === 'string' ? aidRaw.trim() : '';
  const raw = conv.messages;
  if (!aid || !Array.isArray(raw) || raw.length === 0) return null;
  const sums = conv.context_summaries;
  const active = Array.isArray(sums) ? sums.find((s) => s && typeof s === 'object' && s.id === aid) : null;
  if (!active) return null;
  const e = active.covers_exclusive_end;
  if (typeof e !== 'number' || !Number.isFinite(e)) return null;
  const ei = Math.floor(e);
  if (ei <= 0 || ei > raw.length) return null;
  const pct = Math.round((ei / raw.length) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** 将正整数格式化为简短中文单位（万），用于 L1 字符提示 */
function approxChineseChars(n: number): string {
  const x = Math.max(0, Math.round(Number(n)));
  if (!Number.isFinite(x)) return '';
  if (x < 10_000) return String(x);
  const wan = x / 10_000;
  const s = wan >= 100 ? wan.toFixed(0) : wan >= 10 ? wan.toFixed(1) : wan.toFixed(2);
  return `${s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}万`;
}

/** L1 合计：主 system + tools JSON + 摘要注入 + 消息尾；分母优先 verbatim_hard_max_chars，
 *  缺省回退 verbatim_max_chars（软上限）。null 表示数据不足。 */
function contextProjectionCombinedTotals(
  projection: Record<string, unknown> | null | undefined,
): { total: number; denom: number; pct: number } | null {
  if (!projection || typeof projection !== 'object') return null;
  const primary = Number(projection.primary_system_l1_chars);
  const sumInj = Number(projection.summary_injection_l1_chars);
  const tail = Number(projection.verbatim_tail_l1_chars);
  const tools = Number(projection.tools_schema_l1_chars);
  const hardCap = Number(projection.verbatim_hard_max_chars);
  const softCap = Number(projection.verbatim_max_chars);
  const cap =
    Number.isFinite(hardCap) && hardCap > 0
      ? hardCap
      : Number.isFinite(softCap) && softCap > 0
        ? softCap
        : NaN;
  const prim = Number.isFinite(primary) && primary > 0 ? primary : 0;
  const sumN = Number.isFinite(sumInj) && sumInj >= 0 ? sumInj : 0;
  const tailN = Number.isFinite(tail) && tail >= 0 ? tail : 0;
  const toolsN = Number.isFinite(tools) && tools >= 0 ? tools : 0;
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const total = prim + sumN + tailN + toolsN;
  const pct = Math.min(100, Math.max(0, Math.round((total / cap) * 100)));
  return { total, denom: cap, pct };
}

/**
 * 输入框旁环形进度的百分比：(主 system + 摘要注入 + 逐字尾 + tools) / verbatim 上限。
 * 无投影时退化为「消息条数已压缩」比例。null = 没数据，不显示进度条。
 */
export function getComposerContextRingPercent(
  conv: {
    messages?: ConversationMessage[] | null;
    active_context_summary_id?: string | null;
    context_summaries?: ContextSummary[] | null;
    context_projection_l1?: Record<string, unknown> | null;
  } | null | undefined,
): number | null {
  if (!conv || typeof conv !== 'object') return null;
  const p = conv.context_projection_l1;
  if (p && typeof p === 'object') {
    const c = contextProjectionCombinedTotals(p);
    if (c) {
      return Math.min(100, Math.max(0, (c.total / c.denom) * 100));
    }
  }
  return getConversationContextCompressMessagePercent(conv);
}

/**
 * 输入框旁环形进度的悬停 / 点击详情：上下文比例 + 消息已压缩比例。
 */
export function formatContextComposerHoverDetail(
  conv: {
    messages?: ConversationMessage[] | null;
    active_context_summary_id?: string | null;
    context_summaries?: ContextSummary[] | null;
    context_projection_l1?: Record<string, unknown> | null;
  } | null | undefined,
): string {
  const lines: string[] = [];
  const p = conv?.context_projection_l1;
  if (p && typeof p === 'object') {
    const c = contextProjectionCombinedTotals(p);
    if (c && c.denom > 0) {
      lines.push(`约 ${approxChineseChars(c.total)}/${approxChineseChars(c.denom)} · ${c.pct}%`);
    }
  }
  const msgPct = getConversationContextCompressMessagePercent(conv ?? null);
  if (msgPct != null) {
    lines.push(`约 ${msgPct}% 消息在摘要里`);
  }
  if (lines.length === 0) {
    const ringPct = getComposerContextRingPercent(conv ?? null);
    if (ringPct != null) lines.push(`约 ${Math.round(ringPct)}%`);
  }
  return lines.join('\n');
}

export function formatConversationUsageHeaderLine(
  us: UsageStats | null | undefined,
  options?: { currencyMode?: UsageCurrencyMode }
): string {
  const currencyMode = options?.currencyMode ?? 'both';
  if (!us || typeof us !== 'object') return '';
  const tt = totalTokensFromUsage(us);
  const money = formatUsdCnyHeaderMoney(us.estimated_cost_usd, currencyMode);
  const tok = `共 ${tt} tok`;
  return money ? `${tok} · ${money}` : tok;
}

function formatCatalogPriceForModel(
  modelId: string,
  modelPriceReference: Record<string, unknown>
): string {
  if (!modelId || !modelPriceReference || typeof modelPriceReference !== 'object') return '';
  const r = modelPriceReference[modelId] as unknown;
  if (r === 0) return '目录：免费';
  if (r && typeof r === 'object') {
    const o = r as { input?: number; output?: number };
    const inp = o.input;
    const out = o.output;
    if (inp != null && out != null) return `目录 $/M：in ${inp} · out ${out}`;
  }
  return '';
}

export function formatUsageHoverDetail(
  u: UsageStats | null | undefined,
  options: {
    currencyMode?: UsageCurrencyMode;
    modelPriceReference?: Record<string, unknown>;
    selectedModelId?: string;
    scope?: 'segment' | 'conversation';
  } = {}
): string {
  const currencyMode = options.currencyMode ?? 'both';
  const modelPriceReference = options.modelPriceReference || {};
  const scope = options.scope ?? 'segment';
  const refLabel = scope === 'conversation' ? '本对话累计参考费' : '本段参考费';

  if (!u || typeof u !== 'object') return '';
  const pt = Number(u.prompt_tokens) || 0;
  const ct = Number(u.completion_tokens) || 0;
  const tt = totalTokensFromUsage(u);
  const lines: string[] = [];
  lines.push(`输入: ${pt} tokens`);
  lines.push(`输出: ${ct} tokens`);
  lines.push(`合计: ${tt} tokens`);
  const cost = u.estimated_cost_usd;
  if (cost != null && Number(cost) > 0) {
    lines.push(`${refLabel}: ${formatUsdCnyHeaderMoney(Number(cost), currencyMode)}`);
  } else if (tt > 0 && cost != null && Number(cost) === 0) {
    lines.push(`${refLabel}: 免费（参考）`);
  }
  const bm = u.by_model && typeof u.by_model === 'object' ? u.by_model : null;
  if (bm && Object.keys(bm).length > 0) {
    lines.push('');
    lines.push(
      scope === 'conversation'
        ? '按模型（累计，含各轮主模型与读页/搜索/标题等辅助模型）：'
        : '按模型（本段含主模型步与工具内辅助模型）：'
    );
    const sortedEntries = Object.entries(bm).sort(([a], [b]) => String(a).localeCompare(String(b)));
    for (const [mid, row] of sortedEntries) {
      if (!row || typeof row !== 'object') continue;
      const rowObj = row as UsageStats;
      const mpt = Number(rowObj.prompt_tokens) || 0;
      const mct = Number(rowObj.completion_tokens) || 0;
      const mc = rowObj.estimated_cost_usd;
      lines.push(mid);
      lines.push(`  · 输入 ${mpt} · 输出 ${mct}`);
      if (mc != null && Number(mc) > 0) {
        lines.push(`  · 参考: ${formatUsdCnyHeaderMoney(Number(mc), currencyMode)}`);
      } else if ((mpt > 0 || mct > 0) && mc != null && Number(mc) === 0) {
        lines.push(`  · 参考: 免费`);
      }
      const cat = formatCatalogPriceForModel(mid, modelPriceReference);
      if (cat) lines.push(`  · ${cat}`);
    }
  } else {
    const sel = options.selectedModelId;
    if (sel && typeof sel === 'string' && sel.trim()) {
      lines.push('');
      lines.push('选用模型（目录价参考）');
      lines.push(sel);
      const cat = formatCatalogPriceForModel(sel, modelPriceReference);
      if (cat) lines.push(cat);
    }
  }
  return lines.join('\n');
}
