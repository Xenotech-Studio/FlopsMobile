/**
 * 屏幕信息 native bridge wrapper。
 *
 * Android：调用 [ScreenInfoModule] 读取屏幕物理圆角（API 31+；旧版返回 0）。
 * iOS：当前没暴露 native 接口，返回 0；调用方根据 safe-area-insets 自行查表兜底。
 */
import { NativeModules, Platform } from 'react-native';

type ScreenInfoNative = {
  getScreenCornerRadius: () => Promise<number>;
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
