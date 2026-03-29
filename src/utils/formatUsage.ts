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
