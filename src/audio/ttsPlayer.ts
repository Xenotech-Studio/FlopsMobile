/**
 * TTS 语音播放 —— app 级单例（不绑定任何页面/组件生命周期）。
 *
 * 真身是原生 FlopsAudio（AVQueuePlayer，进程级）；本模块是它的 JS 单例包装：
 *  - 维护一份可订阅的播放快照 { key, state, index, count, position, duration }
 *  - 转发原生事件 onAudioState / onAudioProgress 给订阅者
 *  - 提供 useTtsPlayback() 供 UI 判定"当前在播的是不是这条消息"并渲染播放/暂停按钮
 *
 * 仅 iOS。Android（或原生模块缺失）时全部 no-op、状态恒为 idle。
 *
 * 与 ios/FlopsMobile/FlopsAudioModule.swift 对齐。
 */

import { useSyncExternalStore } from 'react';
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { getCachedKConv, aesGcmDecrypt, base64ToBytes, bytesToBase64 } from '../lib/srp';

export type AudioPlaybackState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

type FlopsAudioNative = {
  loadAndPlay(
    segments: string[],
    meta: { key: string; title?: string; subtitle?: string },
  ): Promise<null>;
  play(): Promise<null>;
  pause(): Promise<null>;
  stop(): Promise<null>;
  playIndex(index: number): Promise<null>;
  getState(): Promise<{ state: string; key: string; index: number; count: number }>;
};

export type PlaybackMeta = {
  /** 一条消息的稳定标识（ChatScreen 的 stableKey）；用于 UI 判定当前在播的是哪条 */
  key: string;
  title?: string;
  subtitle?: string;
  /** 加密对话：segments 是 .mp3.enc 密文，需先下载 + 用 K_conv 解密再播（与 Web/Desktop 一致）。 */
  encrypted?: boolean;
  /** 加密对话必传：用于取 K_conv。 */
  convId?: string;
};

export type PlaybackSnapshot = {
  key: string;
  state: AudioPlaybackState;
  index: number;
  count: number;
  position: number;
  duration: number;
};

const isIOS = Platform.OS === 'ios';
const Native: FlopsAudioNative | undefined = isIOS
  ? (NativeModules as any).FlopsAudio
  : undefined;
const emitter = Native ? new NativeEventEmitter(Native as any) : null;

export function isTtsPlaybackSupported(): boolean {
  return !!Native;
}

const IDLE: PlaybackSnapshot = {
  key: '',
  state: 'idle',
  index: 0,
  count: 0,
  position: 0,
  duration: 0,
};

let snapshot: PlaybackSnapshot = IDLE;
const listeners = new Set<() => void>();

function setSnapshot(next: PlaybackSnapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

function normState(s: string): AudioPlaybackState {
  switch (s) {
    case 'loading':
    case 'playing':
    case 'paused':
    case 'ended':
    case 'error':
      return s;
    default:
      return 'idle';
  }
}

if (emitter) {
  emitter.addListener('onAudioState', (e: { state: string; key: string; index: number; count: number }) => {
    const state = normState(e.state);
    // ended/idle/error 归零进度，避免残留上一段
    const resetProgress = state === 'ended' || state === 'idle' || state === 'error';
    setSnapshot({
      key: e.key ?? '',
      state,
      index: e.index ?? 0,
      count: e.count ?? 0,
      position: resetProgress ? 0 : snapshot.position,
      duration: resetProgress ? 0 : snapshot.duration,
    });
  });
  emitter.addListener(
    'onAudioProgress',
    (e: { key: string; index: number; position: number; duration: number }) => {
      // 仅当仍是同一条消息时更新进度
      if (e.key !== snapshot.key) return;
      setSnapshot({
        ...snapshot,
        index: e.index ?? snapshot.index,
        position: e.position ?? 0,
        duration: e.duration ?? 0,
      });
    },
  );
}

// MARK: - 加密对话：下载 .mp3.enc → 用 K_conv 解密 → 写临时 mp3 → 返回 file:// 路径

/** 简单稳定哈希，给临时文件命名（同一 key+段可复用、避免碰撞）。 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * 把加密 segments 逐段解密成本地明文 mp3，返回可直接播放的 file:// URL 列表。
 * 复用项目既有 AES-GCM 路径（srp.aesGcmDecrypt → 原生 FlopsCrypto，forge 兜底），
 * 与 Web/Desktop 的 MessageAudioButton 语义一致。
 */
async function prepareEncryptedSegments(segments: string[], convId?: string): Promise<string[]> {
  const kConv = convId ? getCachedKConv(convId) : null;
  if (!kConv) throw new Error('no_kconv');
  const cacheDir = ReactNativeBlobUtil.fs.dirs.CacheDir;
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const url = segments[i];
    const path = `${cacheDir}/flops-tts-${shortHash(url)}.mp3`;
    // 已解过则直接复用（CacheDir 由系统托管，可被清理）
    const exists = await ReactNativeBlobUtil.fs.exists(path).catch(() => false);
    if (!exists) {
      const res = await ReactNativeBlobUtil.fetch('GET', url); // 内存下载密文
      const encB64 = res.base64();
      res.flush?.();
      const mp3Bytes = aesGcmDecrypt(base64ToBytes(encB64), kConv); // Uint8Array 明文 mp3
      await ReactNativeBlobUtil.fs.writeFile(path, bytesToBase64(mp3Bytes), 'base64');
    }
    out.push(`file://${path}`);
  }
  return out;
}

// MARK: - 命令（对外 API）

/** 从头播放一条消息的 segments。非加密：直接播 mp3 URL；加密：先下载解密成本地 mp3 再播。 */
export async function playSegments(segments: string[], meta: PlaybackMeta): Promise<void> {
  if (!Native || !segments?.length) return;
  // 乐观置 loading，避免点击到首个原生事件之间按钮无反馈（加密解密期间也是 loading）
  setSnapshot({ ...IDLE, key: meta.key, state: 'loading' });
  try {
    const playable = meta.encrypted
      ? await prepareEncryptedSegments(segments, meta.convId)
      : segments;
    // 解密期间用户可能已点了别的消息；若已不是本 key 则放弃，避免抢占
    if (snapshot.key !== meta.key) return;
    await Native.loadAndPlay(playable, { key: meta.key, title: meta.title, subtitle: meta.subtitle });
  } catch {
    if (snapshot.key === meta.key) setSnapshot({ ...IDLE, key: meta.key, state: 'error' });
  }
}

export async function pausePlayback(): Promise<void> {
  if (!Native) return;
  try { await Native.pause(); } catch { /* noop */ }
}

export async function resumePlayback(): Promise<void> {
  if (!Native) return;
  try { await Native.play(); } catch { /* noop */ }
}

export async function stopPlayback(): Promise<void> {
  if (!Native) return;
  try { await Native.stop(); } catch { /* noop */ }
}

/**
 * 播放/暂停切换（面向"点某条消息的播放按钮"）：
 *  - 若正在播这条 → 暂停
 *  - 若这条已暂停 → 继续
 *  - 否则（在播别的 / 空闲）→ 从头播这条
 */
export async function togglePlayback(segments: string[], meta: PlaybackMeta): Promise<void> {
  if (!Native) return;
  const isThis = snapshot.key === meta.key;
  if (isThis && snapshot.state === 'playing') {
    return pausePlayback();
  }
  if (isThis && snapshot.state === 'paused') {
    return resumePlayback();
  }
  return playSegments(segments, meta);
}

// MARK: - React 订阅

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): PlaybackSnapshot {
  return snapshot;
}

/** 订阅全局播放快照（会随原生事件刷新）。 */
export function useTtsPlayback(): PlaybackSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 便捷：某条消息（key）是否正处于"播放中"。 */
export function isMessagePlaying(snap: PlaybackSnapshot, key: string): boolean {
  return snap.key === key && snap.state === 'playing';
}

/** 便捷：某条消息（key）是否是当前活跃条目（播放中或暂停中）。 */
export function isMessageActive(snap: PlaybackSnapshot, key: string): boolean {
  return snap.key === key && (snap.state === 'playing' || snap.state === 'paused' || snap.state === 'loading');
}
