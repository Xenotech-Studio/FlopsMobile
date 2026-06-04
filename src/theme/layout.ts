import { Platform } from 'react-native';

/**
 * 统一配置：列表与行布局
 * 改这里的数字即可全局生效。
 */

/**
 * 全局 header 左右圆形按钮（返回 / 筛选 / 新建 / + 等）的直径。
 * Tasks / Docs / Chat / ConversationList 都用同一个值，视觉语言一致。
 *
 * 注：composer 胶囊高度（COMPOSER_PILL_SIZE，定义在 ChatScreen.styles.ts）
 *     在此基础上 +6 让 composer 略大于圆钮，输入区比按钮更显眼。
 */
export const HEADER_CIRCLE_BTN_SIZE = 48;

/**
 * 角钮内图标尺寸：由 {@link HEADER_CIRCLE_BTN_SIZE} 乘常数算出，跟按钮直径联动——
 * 改按钮大小时图标自动等比缩放，不用各处手填数字。
 *  - Ionicons（iOS<26 / Android 渲染）：≈ 0.42 × 直径
 *  - SF Symbol（iOS26 glass 原生 icon）：≈ 0.31 × 直径（系统 nav button 一贯偏小）
 */
export const HEADER_CIRCLE_IONICON_SIZE = Math.round(HEADER_CIRCLE_BTN_SIZE * 0.42);
export const HEADER_CIRCLE_SF_ICON_SIZE = Math.round(HEADER_CIRCLE_BTN_SIZE * 0.31);

/**
 * 聊天发送钮直径：深色实心钮视觉更重故略放大一圈。
 */
export const CHAT_COMPOSER_SEND_BTN_SIZE = 48;

/**
 * 底部漂浮 UI 统一高度 + 圆角锚点：chat composer 单行胶囊、今日页底部搜索框、FAB 都用这一套，
 * 视觉语言一致。**独立于 {@link HEADER_CIRCLE_BTN_SIZE}**（顶栏圆钮）——改顶栏钮直径不影响底部这套。
 */
export const COMPOSER_PILL_SIZE = 52;
export const COMPOSER_CARD_RADIUS = COMPOSER_PILL_SIZE / 2;

/** 任务列表：第一行距离 header 下方的额外间距（iOS / 默认） */
export const LIST_TOP_EXTRA_BASE = 5;

/** 仅 Android：在 BASE 基础上再增加的间距，调大此项可单独拉大安卓任务列表第一项与顶部的距离 */
export const LIST_TOP_EXTRA_ANDROID_EXTRA = 10;

/** 任务列表：第一行距离 header 下方的额外间距（已按平台区分，今日页与项目详情列表均使用此值） */
export const LIST_TOP_EXTRA =
  Platform.OS === 'android'
    ? LIST_TOP_EXTRA_BASE + LIST_TOP_EXTRA_ANDROID_EXTRA
    : LIST_TOP_EXTRA_BASE;

/**
 * 「完全没有底部导航条」时的底部间距下限（dp）。
 * 有导航条 / 安全区的设备（安卓三键 ≈48、屏幕内单键导航 ≈24、iOS 刘海/灵动岛 ≈34）：内容直接紧贴
 * inset —— 这些 nav bar / 单键条 / home indicator 内部本身就含留白，不需再额外加高度。
 * 只有「完全没有导航条」（系统上报 inset≈0：安卓全面屏手势导航、老款 home 键 / 方形屏 iPhone）才用
 * 这个值兜底，避免内容贴死屏幕物理底边 / composer 底部 meta chips（绝对定位 bottom 为负）被截到屏幕外。
 */
export const MIN_BOTTOM_INSET = 16;

/**
 * 计算底部贴边 UI 应留的总间距（距屏幕物理底边）= max(inset, 下限)。
 * 用设备底部安全区 inset（react-native-safe-area-context 的 insets.bottom）作判据：
 *   - 有导航条 / 安全区（inset ≥ 下限）：直接贴 inset（其内部已含留白，紧贴即可，不加额外高度）。
 *     · 安卓三键 ≈48→48；屏幕内单键导航 ≈24→24；iOS 刘海/灵动岛 ≈34→34。
 *   - 完全没有导航条（inset < 下限，≈0）：用下限兜底，避免贴死屏底 → 16
 *     （安卓全面屏手势导航、iOS home 键/方形屏）。
 */
export function bottomInsetTotal(insetBottom: number): number {
  return Math.max(insetBottom, MIN_BOTTOM_INSET);
}

/** 任务列表：有底部栏/ FAB 时的列表底部留白（今日页、对话列表等） */
export const LIST_PADDING_BOTTOM_WITH_FOOTER = 100;

/** 列表：无底部栏时的列表底部留白（项目详情、项目列表等） */
export const LIST_PADDING_BOTTOM_DEFAULT = 24;

/** 任务行：最小高度 */
export const TASK_ROW_MIN_HEIGHT = 76;

/** 任务行：上下内边距 */
export const TASK_ROW_PADDING_VERTICAL = 14;

/** 任务行：左侧内边距 */
export const TASK_ROW_PADDING_LEFT = 16;

/** 任务行：右侧内边距（行内，叠加在外层 list paddingHorizontal 之上；够防贴边即可，不必过大） */
export const TASK_ROW_PADDING_RIGHT = 18;
