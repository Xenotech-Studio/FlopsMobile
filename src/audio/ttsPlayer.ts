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
  /** 会话 id：当某段是 .mp3.enc 密文时用于取 K_conv 解密（非加密对话可省）。 */
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
    // 自然播完：回收本条消息解密出的临时明文 mp3（原生已不再读取）。
    if (state === 'ended' && liveTempFiles.length) {
      const t = liveTempFiles;
      liveTempFiles = [];
      void deleteFiles(t);
    }
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

// MARK: - segment 解析（唯一 code path：加密/非加密都走这里）

/** 简单稳定哈希，给临时文件命名。 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 后端加密音频落库为 .mp3.enc（明文为 .mp3）；按 URL 后缀判定单段是否密文，而非整条消息一刀切。 */
function isCiphertextUrl(url: string): boolean {
  return /\.enc(\?|#|$)/i.test(url);
}

/** 本次已加载消息写下的临时明文 mp3（切走 / stop 时回收，避免明文长期留盘）。 */
let liveTempFiles: string[] = [];

async function deleteFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try { await ReactNativeBlobUtil.fs.unlink(p); } catch { /* 已不在则忽略 */ }
  }
}

/**
 * 把一条消息的 segments 解析成可直接交给原生播放器的 URL 列表 —— 唯一的处理路径：
 *  - 明文 mp3（.mp3）：原样返回 https URL，原生直接 GET（后台流式、不落盘）。
 *  - 密文（.mp3.enc）：内存下载密文 → getCachedKConv 取 K_conv → srp.aesGcmDecrypt（原生
 *    FlopsCrypto，forge 兜底，layout nonce||ct||tag 与后端 _encrypt_blob 一致）→ 写临时明文
 *    mp3 → 返回 file://。与 Web/Desktop MessageAudioButton 同语义。
 * 逐段判定，故"首段密文、后续明文"这类混合也能正确处理。返回同时给出本次写下的临时文件，供回收。
 */
async function resolveSegments(
  segments: string[],
  convId?: string,
): Promise<{ urls: string[]; tempFiles: string[] }> {
  const needsKey = segments.some(isCiphertextUrl);
  const kConv = needsKey ? (convId ? getCachedKConv(convId) : null) : null;
  if (needsKey && !kConv) throw new Error('no_kconv'); // 加密对话未解锁 / 密钥未缓存
  const cacheDir = ReactNativeBlobUtil.fs.dirs.CacheDir;
  const urls: string[] = [];
  const tempFiles: string[] = [];
  for (const url of segments) {
    if (!isCiphertextUrl(url)) {
      urls.push(url); // 明文：直接播
      continue;
    }
    const path = `${cacheDir}/flops-tts-${shortHash(url)}.mp3`;
    const res = await ReactNativeBlobUtil.fetch('GET', url); // 内存下载密文
    const encB64 = res.base64();
    res.flush?.();
    const mp3Bytes = aesGcmDecrypt(base64ToBytes(encB64), kConv as Uint8Array); // Uint8Array 明文 mp3
    await ReactNativeBlobUtil.fs.writeFile(path, bytesToBase64(mp3Bytes), 'base64');
    tempFiles.push(path);
    urls.push(`file://${path}`);
  }
  return { urls, tempFiles };
}

// MARK: - 命令（对外 API）

/** 从头播放一条消息的 segments。加密/非加密共用同一路径（resolveSegments 按段判定）。 */
export async function playSegments(segments: string[], meta: PlaybackMeta): Promise<void> {
  if (!Native || !segments?.length) return;
  // 乐观置 loading，避免点击到首个原生事件之间按钮无反馈（加密段下载解密期间也是 loading）
  setSnapshot({ ...IDLE, key: meta.key, state: 'loading' });
  const prevTemp = liveTempFiles;
  let newTemp: string[] = [];
  try {
    const resolved = await resolveSegments(segments, meta.convId);
    newTemp = resolved.tempFiles;
    // 下载/解密期间用户可能已点了别的消息；若已不是本 key 则放弃 + 回收本次刚写的临时文件
    if (snapshot.key !== meta.key) {
      await deleteFiles(newTemp);
      return;
    }
    await Native.loadAndPlay(resolved.urls, {
      key: meta.key,
      title: meta.title,
      subtitle: meta.subtitle,
    });
    // 新消息已接管播放 → 回收上一条消息的临时明文（当前这条仍在播，其文件保留）
    liveTempFiles = newTemp;
    await deleteFiles(prevTemp.filter((p) => !newTemp.includes(p)));
  } catch {
    await deleteFiles(newTemp); // 失败：回收本次半成品，不留明文
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
  // 停止即回收当前消息的临时明文 mp3（播放已结束，文件不再被原生读取）
  const toDelete = liveTempFiles;
  liveTempFiles = [];
  await deleteFiles(toDelete);
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
