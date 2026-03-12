/**
 * 统一配置：阴影与描边
 * 改这里的数字即可全局生效，无需在各 screen/component 里散落修改。
 */
import { Platform } from 'react-native';

/** 浅色描边，用于 Android 圆形按钮、FAB 等（替代 elevation 避免方向不一致） */
export const borderLight = {
  borderWidth: 1 as const,
  borderColor: 'rgba(0,0,0,0.10)' as const,
};

// --- 阴影预设（iOS 用 shadow*，Android 用 elevation）---

/** 底部 sheet 整体 */
export const shadowSheet = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
  },
  android: { elevation: 8 },
});

/** 白色卡片（筛选面板内卡片、任务详情卡片等）：iOS 轻阴影，Android 用 border */
export const shadowCard = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
  },
  android: {
    elevation: 0,
    ...borderLight,
  },
});

/** Header 圆形按钮：iOS 阴影，Android 仅描边 */
export const shadowCircleButton = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
  },
  android: {
    elevation: 0,
    ...borderLight,
  },
});

/** 右下角 FAB：iOS 阴影，Android 仅描边（样式里已带 borderLight） */
export const shadowFab = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
  },
  android: { elevation: 0 },
});

/** 下拉/浮层菜单 */
export const shadowMenu = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  },
  android: { elevation: 4 },
});

/**  softer 卡片/按钮（账户卡、结束今日按钮等） */
export const shadowSoft = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
  },
  android: { elevation: 2 },
});

/** 极轻阴影（如 Profile 用户卡） */
export const shadowSoftSubtle = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
  },
  android: { elevation: 2 },
});

/** 自定义开关 thumb */
export const shadowToggleThumb = Platform.select({
  ios: {
    shadowColor: '#000' as const,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  android: { elevation: 2 },
});
