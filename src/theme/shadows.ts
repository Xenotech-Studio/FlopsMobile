/**
 * 统一配置：阴影与描边
 * 改这里的数字即可全局生效，无需在各 screen/component 里散落修改。
 */
import { Platform } from 'react-native';
import type { AppColors } from './appColors';

/** 浅色描边（与 light `androidCircleFabHairline` 同阶）；无主题时的 Android 圆钮/FAB 等 */
export const borderLight = {
  borderWidth: 1 as const,
  borderColor: 'rgba(0,0,0,0.06)' as const,
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

const shadowCardIos = {
  shadowColor: '#000' as const,
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
};

/** 白色卡片（筛选面板内卡片、任务详情卡片等）：iOS 轻阴影，Android 用 border */
export const shadowCard = Platform.select({
  ios: shadowCardIos,
  android: {
    elevation: 0,
    ...borderLight,
  },
});

/** 卡片阴影 + Android 描边随主题（任务详情、筛选 sheet 等） */
export function shadowCardThemed(c: AppColors) {
  return Platform.select({
    ios: shadowCardIos,
    android: {
      elevation: 0,
      borderWidth: 1 as const,
      borderColor: c.androidCircleFabHairline,
    },
  });
}

const shadowCircleButtonIos = {
  shadowColor: '#000' as const,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0.08,
  shadowRadius: 12,
};

/**
 * Android：顶栏圆钮、FAB、聊天输入框等统一替代阴影方案（无 elevation + 主题细描边）。
 */
export function androidCircleFabOutline(c: AppColors) {
  return {
    elevation: 0 as const,
    borderWidth: 1 as const,
    borderColor: c.androidCircleFabHairline,
  };
}

/** Header 圆形按钮：iOS 阴影，Android 仅描边（固定浅灰边，无主题时请用此） */
export const shadowCircleButton = Platform.select({
  ios: shadowCircleButtonIos,
  android: {
    elevation: 0,
    ...borderLight,
  },
});

/**
 * Header 圆形按钮（随主题）：Android 用 `androidCircleFabHairline`（浅色宜与 Tab 顶线同阶、极淡）。
 */
export function shadowCircleButtonThemed(c: AppColors) {
  return Platform.select({
    ios: shadowCircleButtonIos,
    android: androidCircleFabOutline(c),
  });
}

const shadowFabIos = {
  shadowColor: '#000' as const,
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.1,
  shadowRadius: 6,
};

/** 右下角 FAB：iOS 阴影；Android 无描边（常与 borderLight 组合） */
export const shadowFab = Platform.select({
  ios: shadowFabIos,
  android: { elevation: 0 },
});

/**
 * FAB（随主题）：Android 用 `androidCircleFabHairline`；iOS 同 shadowFab。
 */
export function shadowFabThemed(c: AppColors) {
  return Platform.select({
    ios: shadowFabIos,
    android: androidCircleFabOutline(c),
  });
}

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
