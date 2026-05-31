/**
 * 屏幕信息 native bridge wrapper。
 *
 * Android：调用 [ScreenInfoModule] 读取屏幕物理圆角（API 31+；旧版返回 0）。
 * iOS：当前没暴露 native 接口，返回 0；调用方根据 safe-area-insets 自行查表兜底。
 */
import { NativeModules, Platform } from 'react-native';

type ScreenInfoNative = {
  getScreenCornerRadius: () => Promise<number>;
  /** 同步版（blocking sync ReactMethod）。旧 build 未重编时可能 undefined。 */
  getScreenCornerRadiusSync?: () => number;
  /** 同步读底部导航栏 inset（dp）；返回 <0 表示读不到。旧 build 未重编时 undefined。 */
  getBottomInsetSync?: () => number;
};

const native: ScreenInfoNative | undefined = NativeModules.ScreenInfo;

/** 获取屏幕物理圆角半径（dp）。无法获取时返回 0。 */
export async function getScreenCornerRadius(): Promise<number> {
  if (Platform.OS !== 'android' || !native) return 0;
  try {
    const v = await native.getScreenCornerRadius();
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** 无法推断屏幕圆角的设备（主要是 Android 无 native 实测时）的保守默认圆角值（dp）。 */
export const SCREEN_CORNER_RADIUS_FALLBACK = 24;

/**
 * 同步读底部导航栏 inset（dp）—— 供首帧 render 直接取，避免 safe-area-context 首帧上报 0 导致
 * 底部避让"先贴底后上移"的闪。仅 Android 且 native 提供时有效，否则返回 null（调用方退回 safe-area
 * 的 insets.bottom）。**不缓存**：inset 会随导航模式 / 转屏 / 键盘变化，调用方应 keyed on insets.bottom
 * 重读。返回 null 表示读不到（native 返回 <0）。0 是合法值（全面屏手势模式 = 无导航条）。
 */
export function getBottomInsetSync(): number | null {
  if (Platform.OS !== 'android' || !native?.getBottomInsetSync) return null;
  try {
    const v = native.getBottomInsetSync();
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  } catch {
    /* sync bridge 异常 → null 走兜底 */
  }
  return null;
}

/** 同步取值结果缓存（屏幕圆角是设备固定值，读一次即可；避免每次 render 都走一次 sync bridge）。 */
let cachedSyncCornerRadius: number | null = null;

/**
 * 同步读 Android 屏幕物理圆角（dp）—— 供首帧 render 直接取，避免异步版"先窄后宽"闪烁。
 * 仅 Android 且 native 提供 sync 方法时有效；否则（iOS / 旧 build 未重编）返回 null，调用方走 inference 兜底。
 */
export function getScreenCornerRadiusSync(): number | null {
  if (Platform.OS !== 'android' || !native?.getScreenCornerRadiusSync) return null;
  if (cachedSyncCornerRadius != null) return cachedSyncCornerRadius;
  try {
    const v = native.getScreenCornerRadiusSync();
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      cachedSyncCornerRadius = v;
      return v;
    }
  } catch {
    /* sync bridge 异常 → 返回 null 走兜底 */
  }
  return null;
}

/**
 * 判定「方角屏」的圆角上限（dp）：屏幕圆角 < 此值即按方角屏处理（不必严格 = 0，小圆角也算）。
 * 上限应 < iOS 刘海机圆角（约 47），否则刘海/灵动岛 iPhone 会被误判成方角屏。
 * Android 接了 native 实测圆角（见 {@link isSquareScreen}）后不再受兜底值 24 限制，可在此区间自由调。
 */
export const SQUARE_SCREEN_CORNER_MAX = 20;

/**
 * 屏幕是否为「方角屏」（圆角 < {@link SQUARE_SCREEN_CORNER_MAX}）。
 * - Android：优先用 native 实测圆角 `measuredRadius`（API 31+ 准确；传 null / 未取到时用 inference
 *   兜底 24 → 判为非方角，避免实测值回来前误触）。
 * - iOS：无 native 接口，用 `topInset` 查表推断（0 / 47 / 55）。
 */
export function isSquareScreen(topInset: number, measuredRadius?: number | null): boolean {
  const radius =
    Platform.OS === 'android' && measuredRadius != null
      ? measuredRadius
      : inferScreenCornerRadius(topInset);
  return radius < SQUARE_SCREEN_CORNER_MAX;
}

/**
 * 同步推断屏幕物理圆角半径（dp）。iOS 的唯一来源，以及 Android 没拿到 native 实测值时的兜底。
 * iOS 用 safe-area top inset 反推机型：
 *  - top ≥ 59：灵动岛（iPhone 14 Pro+ / 15+ / 16）→ 约 55
 *  - top ≥ 44：刘海（iPhone X–14 普通 / 15）→ 约 47
 *  - 其它（iPhone SE / 8 等矩形直角屏）→ 0
 * Android（无 native 实测时）：保守默认 {@link SCREEN_CORNER_RADIUS_FALLBACK}。
 */
export function inferScreenCornerRadius(topInset: number): number {
  if (Platform.OS === 'ios') {
    if (topInset >= 59) return 55;
    if (topInset >= 44) return 47;
    return 0;
  }
  return SCREEN_CORNER_RADIUS_FALLBACK;
}
