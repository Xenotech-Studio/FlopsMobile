import { USD_TO_CNY_FIXED, normalizeUsageCurrencyMode, type UsageCurrencyMode } from '../constants/pricingDisplay';

export function formatUsdCnyEstimate(usd: number | string | null | undefined, mode: UsageCurrencyMode = 'both'): string {
  const m = normalizeUsageCurrencyMode(mode);
  const x = Number(usd);
  if (!Number.isFinite(x) || x <= 0) return '—';
  const cny = x * USD_TO_CNY_FIXED;
  if (m === 'usd') return `~$${x.toFixed(4)}`;
  if (m === 'cny') return `~¥${cny.toFixed(2)}`;
  return `~$${x.toFixed(4)} (~¥${cny.toFixed(2)})`;
}

export function formatUsdCnyHeaderMoney(
  usd: number | string | null | undefined,
  mode: UsageCurrencyMode = 'both'
): string {
  const m = normalizeUsageCurrencyMode(mode);
  const x = Number(usd);
  if (!Number.isFinite(x) || x <= 0) return '';
  const cny = x * USD_TO_CNY_FIXED;
  const fmtUsd = (v: number) => {
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(4);
    if (v >= 0.0001) return v.toFixed(6);
    return v.toFixed(8);
  };
  const fmtCny = (v: number) => {
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(4);
    return v.toFixed(6);
  };
  if (m === 'usd') return `~$${fmtUsd(x)}`;
  if (m === 'cny') return `~¥${fmtCny(cny)}`;
  return `~$${fmtUsd(x)} (~¥${fmtCny(cny)})`;
}
