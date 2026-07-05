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

// MARK: - 命令（对外 API）

/** 从头播放一条消息的 segments（完整 mp3 URL，非加密对话）。 */
export async function playSegments(segments: string[], meta: PlaybackMeta): Promise<void> {
  if (!Native || !segments?.length) return;
  // 乐观置 loading，避免点击到首个原生事件之间按钮无反馈
  setSnapshot({ ...IDLE, key: meta.key, state: 'loading' });
  try {
    await Native.loadAndPlay(segments, { key: meta.key, title: meta.title, subtitle: meta.subtitle });
  } catch {
    setSnapshot({ ...IDLE, key: meta.key, state: 'error' });
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
