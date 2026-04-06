import { Platform } from 'react-native';

/**
 * 统一配置：列表与行布局
 * 改这里的数字即可全局生效。
 */

/** 任务相关页 header 左右圆形按钮（返回、筛选等）的直径 */
export const HEADER_CIRCLE_BTN_SIZE = 54;

/**
 * 聊天页：顶栏返回/新建圆钮直径，与 composer 单行输入框 minHeight 对齐。
 */
export const CHAT_COMPOSER_CONTROL_SIZE = 52;

/**
 * 聊天发送钮直径：略小于 {@link CHAT_COMPOSER_CONTROL_SIZE}，深色实心钮视觉更重故收小一圈。
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
