/**
 * 语义色板：浅色 / 深色共用同一套字段名，供各屏与 Chat 大样式表引用。
 */

export type AppColors = {
  background: string;
  backgroundSecondary: string;
  surface: string;
  surfaceMuted: string;
  inputBg: string;
  overlayScrim: string;

  textPrimary: string;
  textHeader: string;
  textSecondary: string;
  textBody: string;
  textMuted: string;
  textMutedSlate: string;
  textTertiary: string;
  textLabel: string;
  textStrong: string;
  textStrong2: string;
  textDark: string;
  textSlate: string;
  textDisabled: string;
  textQuaternary: string;
  placeholder: string;

  border: string;
  borderMuted: string;
  borderSubtle: string;
  borderCard: string;
  borderD4: string;
  borderD5: string;
  borderD8: string;

  toolCardBg: string;
  toolCardBgPressed: string;
  toolBadgeBg: string;
  toolBadgeBorder: string;
  toolBadgeText: string;
  toolInnerSurface: string;
  toolInnerSurface2: string;
  toolInnerSurface3: string;
  toolInnerSurface4: string;
  toolInnerSurface5: string;
  toolInnerSurface6: string;
  readPagesTrackBg: string;

  userBubble: string;
  onUserBubble: string;

  primary: string;
  onPrimary: string;
  danger: string;
  dangerDark: string;
  errorBg: string;
  roseBg: string;
  roseBorder: string;
  roseBorderStrong: string;
  dangerTextDark: string;
  link: string;
  accentLoadBar: string;
  accentPurple: string;

  gray404040: string;
  success: string;
  /** 输入框等细描边 */
  hairlineBorder: string;
};

export const lightColors: AppColors = {
  background: '#ffffff',
  backgroundSecondary: '#f9fafb',
  surface: '#ffffff',
  surfaceMuted: '#f3f4f6',
  inputBg: '#ffffff',
  overlayScrim: 'rgba(255,255,255,0.88)',

  textPrimary: '#111827',
  textHeader: '#0f172a',
  textSecondary: '#374151',
  textBody: '#1e293b',
  textMuted: '#6b7280',
  textMutedSlate: '#64748b',
  textTertiary: '#737373',
  textLabel: '#525252',
  textStrong: '#262626',
  textStrong2: '#171717',
  textDark: '#1f2937',
  textSlate: '#334155',
  textDisabled: '#a3a3a3',
  textQuaternary: '#d4d4d4',
  placeholder: '#9ca3af',

  border: '#e5e7eb',
  borderMuted: '#e5e5e5',
  borderSubtle: '#eeeeee',
  borderCard: '#eaeaea',
  borderD4: '#d4d4d4',
  borderD5: '#d5d5d5',
  borderD8: '#d8d8d8',

  toolCardBg: '#f5f5f5',
  toolCardBgPressed: '#e5e5e5',
  toolBadgeBg: '#e5e5e5',
  toolBadgeBorder: '#d4d4d4',
  toolBadgeText: '#525252',
  toolInnerSurface: '#f5f5f5',
  toolInnerSurface2: '#ebebeb',
  toolInnerSurface3: '#ececec',
  toolInnerSurface4: '#f0f0f0',
  toolInnerSurface5: '#c8c8c8',
  toolInnerSurface6: '#f8f8f8',
  readPagesTrackBg: '#c8c8c8',

  userBubble: '#000000',
  onUserBubble: '#ffffff',

  primary: '#0f172a',
  onPrimary: '#ffffff',
  danger: '#dc2626',
  dangerDark: '#b91c1c',
  errorBg: '#fef2f2',
  roseBg: '#fff1f2',
  roseBorder: '#fecdd3',
  roseBorderStrong: '#fecaca',
  dangerTextDark: '#991b1b',
  link: '#2563eb',
  accentLoadBar: '#667eea',
  accentPurple: '#667eea',

  gray404040: '#404040',
  success: '#0a7b0a',
  hairlineBorder: 'rgba(0,0,0,0.10)',
};

export const darkColors: AppColors = {
  background: '#000000',
  backgroundSecondary: '#0a0a0b',
  surface: '#1c1c1e',
  surfaceMuted: '#2c2c2e',
  inputBg: '#1c1c1e',
  overlayScrim: 'rgba(0,0,0,0.88)',

  textPrimary: '#f3f4f6',
  textHeader: '#f9fafb',
  textSecondary: '#d1d5db',
  textBody: '#e5e7eb',
  textMuted: '#9ca3af',
  textMutedSlate: '#94a3b8',
  textTertiary: '#a1a1aa',
  textLabel: '#d4d4d8',
  textStrong: '#e4e4e7',
  textStrong2: '#fafafa',
  textDark: '#e5e7eb',
  textSlate: '#cbd5e1',
  textDisabled: '#71717a',
  textQuaternary: '#52525b',
  placeholder: '#71717a',

  border: '#3f3f46',
  borderMuted: '#3f3f46',
  borderSubtle: '#27272a',
  borderCard: '#3f3f46',
  borderD4: '#52525b',
  borderD5: '#3f3f46',
  borderD8: '#52525b',

  toolCardBg: '#2c2c2e',
  toolCardBgPressed: '#3a3a3c',
  toolBadgeBg: '#3a3a3c',
  toolBadgeBorder: '#52525b',
  toolBadgeText: '#d4d4d8',
  toolInnerSurface: '#2c2c2e',
  toolInnerSurface2: '#3a3a3c',
  toolInnerSurface3: '#2c2c2e',
  toolInnerSurface4: '#27272a',
  toolInnerSurface5: '#52525b',
  toolInnerSurface6: '#27272a',
  readPagesTrackBg: '#52525b',

  userBubble: '#e5e7eb',
  onUserBubble: '#0f172a',

  primary: '#e2e8f0',
  onPrimary: '#0f172a',
  danger: '#f87171',
  dangerDark: '#fca5a5',
  errorBg: '#450a0a',
  roseBg: '#3f1d25',
  roseBorder: '#7f1d1d',
  roseBorderStrong: '#991b1b',
  dangerTextDark: '#fecaca',
  link: '#60a5fa',
  accentLoadBar: '#818cf8',
  accentPurple: '#818cf8',

  gray404040: '#a1a1aa',
  success: '#4ade80',
  hairlineBorder: 'rgba(255,255,255,0.15)',
};

/** 底部渐变条：透明 → 与背景融合 */
export function chatBottomGradientColors(isDark: boolean, c: AppColors): string[] {
  if (isDark) return ['rgba(0,0,0,0)', c.background];
  return [`rgba(245,245,245,0)`, c.toolCardBg];
}

/** RefreshControl 渐层（iOS） */
export function chatRefreshProgressColors(c: AppColors): string[] {
  return [c.textSecondary, c.textMuted];
}

/** 输入区底部白/黑渐变遮罩 */
export function chatInputOverlayGradient(isDark: boolean): string[] {
  if (isDark) {
    return [
      'rgba(0,0,0,0)',
      'rgba(0,0,0,0.5)',
      'rgba(0,0,0,0.9)',
      'rgba(0,0,0,0.98)',
    ];
  }
  return [
    'rgba(255,255,255,0)',
    'rgba(255,255,255,0.5)',
    'rgba(255,255,255,0.9)',
    'rgba(255,255,255,0.98)',
  ];
}

/** 工具卡片半折叠底部淡出 */
export function toolPreviewFadeGradient(isDark: boolean, c: AppColors): string[] {
  if (isDark) return ['rgba(0,0,0,0)', c.toolCardBg];
  return ['rgba(245,245,245,0)', c.toolCardBg];
}
