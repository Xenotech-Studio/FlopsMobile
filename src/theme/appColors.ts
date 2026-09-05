/**
 * 语义色板：浅色 / 深色共用同一套字段名，供各屏与 Chat 大样式表引用。
 */

export type AppColors = {
  background: string;
  backgroundSecondary: string;
  /** 抽屉外壳画布：比 chatScreenBackground 略暗，使主页面"浮"在抽屉之上的层次更明显 */
  drawerBackground: string;
  /** 聊天页主画布：亮模式极浅灰（与任务详情页底一致）；暗色同 background */
  chatScreenBackground: string;
  /** 列表类主画布（任务栈、Docs 占位等）；浅色与 chatScreenBackground 一致 */
  conversationListBackground: string;
  /** 会话/任务列表行底分割线；浅色须略深于 chat 列表底，避免与画布融在一起 */
  conversationListSeparator: string;
  /** 底部 Tab 栏顶部分割线（宜比通用 border 更淡） */
  tabBarTopBorder: string;
  /**
   * 顶栏圆钮、FAB、Android 卡片替代阴影等 1px 描边；浅色宜极淡（约 6% 黑）；暗色为低对比白边。
   */
  androidCircleFabHairline: string;
  surface: string;
  surfaceMuted: string;
  /** 骨架屏占位块底色。要求同时压得住三种画布：列表底(#f9fafb/#101010)、抽屉底(#ededef/#070708)、
   *  卡片底(surface)——所以浅色比 surfaceMuted 再深一档，暗色取 surface 与 surfaceMuted 之间。 */
  skeletonBase: string;
  /** 骨架屏扫光高亮：白色低透明，叠在 skeletonBase 上横扫。两端的 0 alpha 白由组件补。 */
  skeletonHighlight: string;
  /** 实心顶栏 / 顶栏条背景（不含毛玻璃头上的圆形操作钮，圆钮仍用 surface） */
  headerBarBackground: string;
  /** 顶栏、Modal/Sheet 标题栏底部分割线宽度；暗色为 0 */
  headerBarBottomBorderWidth: number;
  /** 与分割线宽度配对；Android 浅色下在 withLightPlatformListCanvas 中改为 androidCircleFabHairline */
  headerBarBottomBorderColor: string;
  inputBg: string;
  /** Composer 卡片"现代"半透明底色（Android 兜底 iOS 26 玻璃观感；无 blur，靠半透明 + 细边框）。 */
  composerModernBg: string;
  overlayScrim: string;
  /** 全屏 Modal、下拉菜单等自定义遮罩；暗色加重以压住底层 */
  modalBackdrop: string;
  /** @gorhom/bottom-sheet 背后 dim */
  bottomSheetBackdropOpacity: number;

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
  /**
   * 聊天输入区发送圆钮底色。深色略亮于 userBubble；浅色用柔化深灰（不必与 primary 同阶）。
   */
  chatComposerSendBackground: string;

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

/**
 * 浅色列表/聊天主画布：iOS 用极浅灰；Android 在 ThemeContext 中覆写为 `LIGHT_LIST_CANVAS_ANDROID`（略深）。
 */
export const LIGHT_LIST_CANVAS_IOS = '#f9fafb';
/** 浅色同语义画布：Android 略深于 iOS；仍浅于 surfaceMuted，避免与次要块面色黏连 */
export const LIGHT_LIST_CANVAS_ANDROID = '#f7f7f7';

/** 浅色抽屉画布：比主画布略暗一档，让主页面在抽屉打开时形成可见的"卡片在底色上"层次。 */
export const LIGHT_DRAWER_CANVAS_IOS = '#ededef';
export const LIGHT_DRAWER_CANVAS_ANDROID = '#e8e8e8';

/** 浅色 + Android：列表画布略加深，顶栏/Sheet 标题下分割线改为 androidCircleFabHairline（与圆钮描边一致）。 */
export function withLightPlatformListCanvas(
  isDark: boolean,
  colors: AppColors,
  platformOS: string
): AppColors {
  if (isDark || platformOS !== 'android') return colors;
  return {
    ...colors,
    backgroundSecondary: LIGHT_LIST_CANVAS_ANDROID,
    chatScreenBackground: LIGHT_LIST_CANVAS_ANDROID,
    conversationListBackground: LIGHT_LIST_CANVAS_ANDROID,
    /* 抽屉背景不再单独加深，跟 iOS 一致（用基础 LIGHT_DRAWER_CANVAS_IOS） */
    headerBarBottomBorderColor: colors.androidCircleFabHairline,
  };
}

export const lightColors: AppColors = {
  background: '#ffffff',
  backgroundSecondary: LIGHT_LIST_CANVAS_IOS,
  drawerBackground: LIGHT_DRAWER_CANVAS_IOS,
  chatScreenBackground: LIGHT_LIST_CANVAS_IOS,
  /** 与 chatScreenBackground 同色；Android 浅色下由 withLightPlatformListCanvas 同步加深 */
  conversationListBackground: LIGHT_LIST_CANVAS_IOS,
  conversationListSeparator: '#f3f3f3',
  tabBarTopBorder: 'rgba(0,0,0,0.06)',
  androidCircleFabHairline: 'rgba(0,0,0,0.04)',
  surface: '#ffffff',
  surfaceMuted: '#f3f4f6',
  skeletonBase: '#e0e1e5',
  skeletonHighlight: 'rgba(255,255,255,0.7)',
  headerBarBackground: '#ffffff',
  headerBarBottomBorderWidth: 1,
  headerBarBottomBorderColor: '#e5e7eb',
  inputBg: '#ffffff',
  composerModernBg: '#ffffff',
  overlayScrim: 'rgba(255,255,255,0.88)',
  modalBackdrop: 'rgba(0,0,0,0.38)',
  bottomSheetBackdropOpacity: 0.4,

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

  /* 与 FlopsWeb :root --chat-user-bubble-* 一致（柔化纯黑气泡） */
  userBubble: '#1c1c1c',
  onUserBubble: '#f0f0f0',
  /** 比 #0f172a 柔和，仍为深底 + 白标 */
  chatComposerSendBackground: '#374151',

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
  /** 聊天主画布、任务列表等与会话列表统一的深灰底 */
  background: '#101010',
  backgroundSecondary: '#0a0a0b',
  drawerBackground: '#070708',
  chatScreenBackground: '#101010',
  conversationListBackground: '#101010',
  /** 略亮于列表底，对比低于原 surfaceMuted，分割线更暗、更弱 */
  conversationListSeparator: '#222222',
  /** Tab 顶线：低透明白边，比 #3f3f46 的 border 更淡 */
  tabBarTopBorder: 'rgba(255,255,255,0.02)',
  androidCircleFabHairline: 'rgba(255,255,255,0.02)',
  surface: '#1f1f1f',
  surfaceMuted: '#2c2c2e',
  skeletonBase: '#252528',
  skeletonHighlight: 'rgba(255,255,255,0.07)',
  headerBarBackground: '#141414',
  headerBarBottomBorderWidth: 0,
  headerBarBottomBorderColor: '#3f3f46',
  inputBg: '#1c1c1e',
  composerModernBg: '#1c1c1e',
  overlayScrim: 'rgba(0,0,0,0.88)',
  modalBackdrop: 'rgba(0,0,0,0.82)',
  bottomSheetBackdropOpacity: 0.68,

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

  /* 与 FlopsDesktop theme-desktop --chat-user-bubble-* 一致（暗色底 + 浅字，避免近白气泡） */
  userBubble: '#34343a',
  onUserBubble: '#c9c9d1',
  /** 比 #34343a 略抬一档，避免与 primary 近白圆钮抢视觉 */
  chatComposerSendBackground: '#3e3e45',

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

function rgbaFromHex(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/** 底部渐变条：透明 → 与背景融合 */
export function chatBottomGradientColors(isDark: boolean, c: AppColors): string[] {
  if (isDark) return ['rgba(0,0,0,0)', c.background];
  return [rgbaFromHex(c.chatScreenBackground, 0), c.toolCardBg];
}

/** RefreshControl 渐层（iOS） */
export function chatRefreshProgressColors(c: AppColors): string[] {
  return [c.textSecondary, c.textMuted];
}

/** 输入区底部渐变遮罩（与 chatScreenBackground 同色阶融合） */
export function chatInputOverlayGradient(c: AppColors): string[] {
  const bg = c.chatScreenBackground;
  return [
    rgbaFromHex(bg, 0),
    rgbaFromHex(bg, 0.5),
    rgbaFromHex(bg, 0.9),
    rgbaFromHex(bg, 0.98),
  ];
}

/**
 * 协同工作区底部渐变遮罩（与 drawerBackground 同色阶融合 —— 工作区层底色就是它）。
 * 铺在聊天 sheet 上沿之上那一段：正文滚到这儿被柔和盖住，走马灯胶囊也不跟文字打架。
 * 末档给足实色（不像输入区那条留 0.98）：它的下沿正好压在 sheet 顶沿上，留缝会漏出一条正文。
 */
export function collabWorkspaceFadeGradient(c: AppColors): string[] {
  const bg = c.drawerBackground;
  return [rgbaFromHex(bg, 0), rgbaFromHex(bg, 0.5), rgbaFromHex(bg, 0.96), bg];
}

/**
 * 协同 sheet 顶部淡出（把手区 → 消息区）：与 sheet 面同色，往下淡到全透明。
 * 消息区是自带滚动的，内容会一路顶到把手下沿被 overflow 硬切；铺这一条让它淡出去，
 * 顺带把把手那块实色和下面的内容接上，不再是一道生硬的分界。
 */
/** 化开段采样多少段折线去逼近曲线。段数只影响每个停靠点上那点折角，16 段已经量不出来。 */
const COLLAB_FADE_RAMP_STEPS = 16;
/**
 * alpha 曲线的指数。**这是"生硬"的解药**，原理见下。
 *
 * 观察：alpha 直接就是这条带子盖在黑气泡上时的显示亮度（白底色 × alpha）。而人眼感知的
 * 明度 L* ≈ Y^(1/3) —— 对亮度的**暗端极其敏感**。所以一条 alpha 线性下降的带子，
 * 感知上根本不是匀速的：真机截图逐像素量过当时那版（两段线性、ramp 18pt），
 * 每 pt 的 ΔL* 是 1.7 → 2.4（前段几乎看不出在变）… 最后 1pt 直接 **31**。
 * 也就是说**最后一个 pt 承担的感知变化，比前面 15pt 加起来还多** —— 那道"说不出具体
 * 位置、但就是很明显"的断层就是它。（另有两处折角：平台→化开的拐点，和中点 0.6 那个
 * 斜率突变 2.4→3.8。）
 *
 * 解法：alpha = (1 - smoothstep(t))^γ。
 *  - smoothstep 让两端**导数为 0** → 平台接化开、化开接透明，两处折角都没了；
 *  - γ 次幂补掉 L* 的立方根压缩 → 感知明度不再前松后紧。
 *
 * γ 就是「软硬」旋钮，而 **3 是个有解析意义的点**：L* ∝ alpha^(1/3)，所以 γ=3 时
 * L* ∝ (1 - smoothstep(t)) —— **感知明度正好照着 smoothstep 走**，两端各带一段缓入缓出，
 * 是这条曲线族里最"软"的自然选择。γ=2 是感知**匀速**（中段最平但两端相对硬），
 * 实测反馈偏硬，故取 3：alpha 掉得更早、低 alpha 的尾巴更长，观感更松。
 * 代价是中点斜率略陡（同样 ramp 长度下最大 ΔL* 5.8 → 6.2），把 ramp 从 28 加到 30 正好抵掉。
 */
const COLLAB_FADE_RAMP_GAMMA = 3;
/**
 * 顶部淡出带的**颜色 + 停靠点**（两者必须同源，分开写迟早对不上）。
 *
 * 形状 = 前 plateauFraction 是 alpha 1 的实色平台，其余是上面那条曲线化到全透明。
 * 所有停靠点 RGB 全同、只有 alpha 在变 —— 插值不可能跑出色偏，末段也必须是
 * `rgba(bg, 0)` 而不是 transparent（后者在部分实现里是透明黑，会在尾巴上泛灰）。
 *
 * @param plateauFraction 实色平台占整条带子的比例（调用处按 平台/总长 算）
 */
export function collabSheetTopFadeStops(
  c: AppColors,
  plateauFraction: number,
): { colors: string[]; locations: number[] } {
  const bg = c.chatScreenBackground;
  /* 平台起点。平台终点就是化开段的第一个停靠点（alpha 仍是 1），不用单独给。 */
  const colors: string[] = [bg];
  const locations: number[] = [0];
  for (let i = 0; i <= COLLAB_FADE_RAMP_STEPS; i++) {
    const t = i / COLLAB_FADE_RAMP_STEPS;
    const smooth = t * t * (3 - 2 * t);
    const alpha = Math.pow(1 - smooth, COLLAB_FADE_RAMP_GAMMA);
    colors.push(rgbaFromHex(bg, alpha));
    locations.push(plateauFraction + (1 - plateauFraction) * t);
  }
  return { colors, locations };
}

/** 工具卡片半折叠底部淡出 */
export function toolPreviewFadeGradient(isDark: boolean, c: AppColors): string[] {
  if (isDark) return ['rgba(0,0,0,0)', c.toolCardBg];
  return [rgbaFromHex(c.chatScreenBackground, 0), c.toolCardBg];
}
