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
export const HEADER_CIRCLE_BTN_SIZE = 52;

/**
 * 聊天发送钮直径：稍大于 {@link HEADER_CIRCLE_BTN_SIZE}，深色实心钮视觉更重故略放大一圈。
 */
export const CHAT_COMPOSER_SEND_BTN_SIZE = 48;

/** 任务列表：第一行距离 header 下方的额外间距（iOS / 默认） */
export const LIST_TOP_EXTRA_BASE = 5;

/** 仅 Android：在 BASE 基础上再增加的间距，调大此项可单独拉大安卓任务列表第一项与顶部的距离 */
export const LIST_TOP_EXTRA_ANDROID_EXTRA = 10;

/** 任务列表：第一行距离 header 下方的额外间距（已按平台区分，今日页与项目详情列表均使用此值） */
export const LIST_TOP_EXTRA =
  Platform.OS === 'android'
    ? LIST_TOP_EXTRA_BASE + LIST_TOP_EXTRA_ANDROID_EXTRA
    : LIST_TOP_EXTRA_BASE;

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

/** 任务行：右侧内边距（略大以免文字贴边） */
export const TASK_ROW_PADDING_RIGHT = 44;
