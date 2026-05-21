/**
 * 统一配置：阴影与描边
 * 改这里的数字即可全局生效，无需在各 screen/component 里散落修改。
 */
import { Platform } from 'react-native';
import type { ViewStyle } from 'react-native';
import type { AppColors } from './appColors';

/** Platform.select 在 ios/android 两支字段不同时会 TS overload 失败；统一 cast 成 ViewStyle 兜住。 */
type S = ViewStyle;

/**
 * 全局阴影颜色（含 alpha）。改这里 = 全局调阴影的"黑度"。
 *  - iOS：跟 shadowOpacity 联乘（shadowColor 给颜色 + alpha，shadowOpacity 再乘一层）。
 *  - Android：API 28+ 把 alpha 透到 OutlineAmbient/SpotShadowColor —— 整 elevation 阴影
 *    都按这个 alpha 整体变淡 / 变深。elevation 仍只能控形状大小，颜色由它单独管。
 *  - Android 7/8（< API 28）会忽略 alpha 落到系统默认黑（约 5% 用户）。
 *
 * 建议：iOS 把 shadowOpacity 维持 0.04-0.2 那种习惯不动；
 *       想统一把 Android 调淡就降这里的 alpha（如 0.6 → 0.4）。 */
export const SHADOW_COLOR = 'rgba(0,0,0,0.35)';

/** 浅色描边（与 light `androidCircleFabHairline` 同阶）；无主题时的 Android 圆钮/FAB 等 */
export const borderLight = {
  borderWidth: 1 as const,
  borderColor: 'rgba(0,0,0,0.06)' as const,
};

// --- 阴影预设（iOS 用 shadow*，Android 用 elevation）---

/** 底部 sheet 整体 */
export const shadowSheet = Platform.select<S>({
  ios: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
  },
  android: { elevation: 16, shadowColor: SHADOW_COLOR },
});

const shadowCardIos: S = {
  shadowColor: SHADOW_COLOR,
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
};

/** 白色卡片（筛选面板内卡片、任务详情卡片等）：iOS 轻阴影，Android 用 border */
export const shadowCard = Platform.select<S>({
  ios: shadowCardIos,
  android: {
    elevation: 0,
    ...borderLight,
  },
});

/** 卡片阴影 + Android 描边随主题（任务详情、筛选 sheet 等） */
export function shadowCardThemed(c: AppColors): S | undefined {
  return Platform.select<S>({
    ios: shadowCardIos,
    android: {
      elevation: 0,
      borderWidth: 1,
      borderColor: c.androidCircleFabHairline,
    },
  });
}

const shadowCircleButtonIos: S = {
  shadowColor: SHADOW_COLOR,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0.08,
  shadowRadius: 12,
};

/**
 * Android：顶栏圆钮、FAB、聊天输入框等统一替代阴影方案。
 * elevation + SHADOW_COLOR 就够让形状跟画布分离了，不再额外挂细描边。
 *
 * elevation 默认 5（圆按钮 / FAB 这种小元素合适）。表面更大的元素（输入框胶囊 /
 * 卡片）传 2-3 就够，不然阴影扩散感会过头。
 *
 * 留 `c: AppColors` 形参是为了 API 不破坏，下游调用没必要改。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function androidCircleFabOutline(c: AppColors, elevation: number = 5): S {
  return {
    elevation,
    shadowColor: SHADOW_COLOR,
  };
}

/** Header 圆形按钮：iOS 阴影，Android 仅描边（固定浅灰边，无主题时请用此） */
export const shadowCircleButton = Platform.select<S>({
  ios: shadowCircleButtonIos,
  android: {
    elevation: 0,
    ...borderLight,
  },
});

/**
 * Header 圆形按钮（随主题）：Android 用 `androidCircleFabHairline`（浅色宜与 Tab 顶线同阶、极淡）。
 */
export function shadowCircleButtonThemed(c: AppColors): S | undefined {
  return Platform.select<S>({
    ios: shadowCircleButtonIos,
    android: androidCircleFabOutline(c),
  });
}

const shadowFabIos: S = {
  shadowColor: SHADOW_COLOR,
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.1,
  shadowRadius: 6,
};

/** 右下角 FAB：iOS 阴影；Android 无描边（常与 borderLight 组合） */
export const shadowFab = Platform.select<S>({
  ios: shadowFabIos,
  android: { elevation: 0 },
});

/**
 * FAB（随主题）：Android 用 `androidCircleFabHairline`；iOS 同 shadowFab。
 */
export function shadowFabThemed(c: AppColors): S | undefined {
  return Platform.select<S>({
    ios: shadowFabIos,
    android: androidCircleFabOutline(c),
  });
}

/** 下拉/浮层菜单 */
export const shadowMenu = Platform.select<S>({
  ios: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  },
  android: { elevation: 12, shadowColor: SHADOW_COLOR },
});

/**  softer 卡片/按钮（账户卡、结束今日按钮等） */
export const shadowSoft = Platform.select<S>({
  ios: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
  },
  android: { elevation: 4, shadowColor: SHADOW_COLOR },
});

/** 极轻阴影（如 Profile 用户卡） */
export const shadowSoftSubtle = Platform.select<S>({
  ios: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
  },
  android: { elevation: 4, shadowColor: SHADOW_COLOR },
});

/** 自定义开关 thumb */
export const shadowToggleThumb = Platform.select<S>({
  ios: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  android: { elevation: 4, shadowColor: SHADOW_COLOR },
});
