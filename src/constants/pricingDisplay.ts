/**
 * 与 FlopsWeb constants/pricingDisplay.js 一致：展示用固定汇率与币种枚举。
 */
export const USD_TO_CNY_FIXED = 7.25;

export const USD_CNY_REFERENCE_NOTE =
  '固定参考汇率 1 USD = 7.25 CNY（约 2025 年 3 月市场区间），仅供界面估算，非实时牌价。';

export const USAGE_CURRENCY_USD = 'usd';
export const USAGE_CURRENCY_CNY = 'cny';
export const USAGE_CURRENCY_BOTH = 'both';

export type UsageCurrencyMode = typeof USAGE_CURRENCY_USD | typeof USAGE_CURRENCY_CNY | typeof USAGE_CURRENCY_BOTH;

export function normalizeUsageCurrencyMode(raw: unknown): UsageCurrencyMode {
  if (raw === USAGE_CURRENCY_USD || raw === USAGE_CURRENCY_CNY || raw === USAGE_CURRENCY_BOTH) {
    return raw;
  }
  return USAGE_CURRENCY_BOTH;
}
