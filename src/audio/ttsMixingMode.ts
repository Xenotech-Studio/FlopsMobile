/**
 * TTS 混音方式 —— app 级共享（回放 ttsPlayer + 实时流 ttsRealtime 共用同一原生 session）。
 *
 * 与其它 App 共存的两种方式（跨端偏好 `tts_mixing_mode`，layout-preferences，与 tts_autoplay 同机制）：
 *  - 'duck' → 原生 .duckOthers：朗读时压低他人音量（最常用，默认）
 *  - 'mix'  → 原生 .mixWithOthers：直接叠加，不动他人音量
 *
 * 真正拼 AVAudioSession 选项在原生（FlopsAudioModule.configureSession）；本模块只负责
 * 把当前选择下发给原生的内部变量（setAudioMixingMode），并缓存以便播放前兜底重发。
 */
import { NativeModules } from 'react-native';
import type { Session } from '../api';
import { getLayoutPreferences } from '../api';

export type TtsMixingMode = 'duck' | 'mix';

/** 混音方式偏好键（layout-preferences，跨端同步；与 tts_autoplay 同一份偏好）。 */
export const TTS_MIXING_MODE_PREF_KEY = 'tts_mixing_mode';
export const DEFAULT_TTS_MIXING_MODE: TtsMixingMode = 'duck';

type FlopsAudioMixingNative = {
  setAudioMixingMode(mode: string): void;
};

// 原生缺失（未 rebuild 的旧包 / Android）时为 undefined → 全链路 no-op。
const Native: FlopsAudioMixingNative | undefined = (NativeModules as any).FlopsAudio;

export function normalizeTtsMixingMode(v: unknown): TtsMixingMode {
  return v === 'mix' ? 'mix' : 'duck';
}

let currentMode: TtsMixingMode = DEFAULT_TTS_MIXING_MODE;

/** 当前生效的混音方式（供设置页回显初值等）。 */
export function getTtsMixingMode(): TtsMixingMode {
  return currentMode;
}

/** 立即把混音方式下发原生（写内部变量，下次/正在放的 configureSession 生效）并缓存。 */
export function applyTtsMixingMode(mode: TtsMixingMode): void {
  currentMode = mode;
  try {
    Native?.setAudioMixingMode?.(mode);
  } catch {
    /* 原生缺失 → no-op */
  }
}

/** 把当前缓存的混音方式重新下发原生（幂等，供播放前兜底）。 */
export function ensureTtsMixingModeApplied(): void {
  applyTtsMixingMode(currentMode);
}

/**
 * 从 layout-preferences 读 `tts_mixing_mode` 并下发原生。
 * 可传入已拉取的 prefs 复用（避免重复请求），否则自行拉取。
 */
export async function refreshTtsMixingModeFromPrefs(
  sess: Session | null,
  prefs?: Record<string, unknown>,
): Promise<void> {
  if (!sess) return;
  try {
    const p = prefs ?? (await getLayoutPreferences(sess));
    applyTtsMixingMode(normalizeTtsMixingMode(p[TTS_MIXING_MODE_PREF_KEY]));
  } catch {
    /* 拉取失败：保持当前值 */
  }
}
