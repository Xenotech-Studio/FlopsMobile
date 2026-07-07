/**
 * 实时流式 TTS —— app 级单例控制器（不绑定任何页面生命周期）。
 *
 * WS 与 PCM 播放全在原生 FlopsAudio（见 ios/FlopsMobile/FlopsAudioModule.swift）；本模块只：
 *  - 持有 { enabled(tts_autoplay), convId, session } 三要素，reconcile 出"该连谁/该不该连"
 *  - 把拼好鉴权的 wsUrl 交给原生 startRealtime / stopRealtime
 *  - 订阅原生 onRealtimeState → useTtsRealtime() 暴露 {connected, speaking, runId}
 *
 * 与 Web/Desktop 对齐：开关键名 `tts_autoplay`（layout-preferences，跨端同步）；
 * 连接时机 = enabled && convId && session；切对话断旧连新；关开关/登出断。
 *
 * ChatScreen 失焦（退列表 / 切页）→ clearActiveConversation() 断单对话流：离开该对话就不该再让
 * Mobile 的 MOBILE_SINGLE(P2) 渠道滞留压制 Desktop/Web。播报模式(P1)是全局的、独立于页面，不受影响。
 *
 * iOS（FlopsAudioModule.swift）与 Android（FlopsAudioModule.kt）都实现了同一套原生接口
 * （startRealtime / stopRealtime + onRealtimeState 事件）；原生模块缺失（旧包）→ 全 no-op。
 */

import { useSyncExternalStore } from 'react';
import { NativeModules, NativeEventEmitter } from 'react-native';
import type { Session } from '../api';
import { getLayoutPreferences, setLayoutPreferences } from '../api';

type FlopsAudioRealtimeNative = {
  /** mode: 'broadcast'（全局端点，连上发 register）| 'single'（per-conv 端点，纯下行）。 */
  startRealtime(wsUrl: string, mode: 'broadcast' | 'single'): Promise<null>;
  stopRealtime(): Promise<null>;
};

// iOS / Android 均有原生 FlopsAudio；缺失（未 rebuild 的旧包）时为 undefined → 全链路 no-op。
const Native: FlopsAudioRealtimeNative | undefined = (NativeModules as any).FlopsAudio;
const emitter = Native ? new NativeEventEmitter(Native as any) : null;

export function isTtsRealtimeSupported(): boolean {
  return !!Native;
}

/** 对话内朗读开关（与 Web/Desktop 同一把）：控制"在对话页内是否连单对话流"。 */
export const TTS_AUTOPLAY_PREF_KEY = 'tts_autoplay';
/** 播报模式开关（Mobile 专属）：全局监听所有对话，独立于 tts_autoplay。 */
export const TTS_BROADCAST_PREF_KEY = 'tts_broadcast_mode';

// MARK: - 可订阅状态

export type RealtimeState = 'idle' | 'connecting' | 'ready' | 'speaking' | 'ended' | 'closed' | 'error';

export type RealtimeSnapshot = {
  /** WS 已连上（ready 之后为 true；断开/错误为 false）。 */
  connected: boolean;
  /** 正在朗读某个 run。 */
  speaking: boolean;
  runId: string;
  /** 正在朗读的对话（播报模式下可能是任意对话）。 */
  conversationId: string;
  state: RealtimeState;
};

const IDLE: RealtimeSnapshot = {
  connected: false, speaking: false, runId: '', conversationId: '', state: 'idle',
};
let snapshot: RealtimeSnapshot = IDLE;
const listeners = new Set<() => void>();

function setSnapshot(next: RealtimeSnapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

if (emitter) {
  emitter.addListener(
    'onRealtimeState',
    (e: { state: RealtimeState; runId?: string; conversationId?: string; error?: string }) => {
      const state = e.state;
      setSnapshot({
        connected: state === 'ready' || state === 'speaking' || state === 'ended',
        speaking: state === 'speaking',
        runId: e.runId ?? snapshot.runId,
        conversationId: e.conversationId ?? snapshot.conversationId,
        state,
      });
    },
  );
}

// MARK: - 三要素 + reconcile

let enabled = false;          // tts_autoplay（对话内朗读开关）
let broadcastMode = false;    // tts_broadcast_mode（全局播报）
let convId = '';              // 最近打开的对话（单对话模式用）
let session: Session | null = null;
/** 当前原生已连的 wsUrl（避免重复 startRealtime）。 */
let connectedUrl = '';

// MARK: - 播报模式可订阅（供全局沉浸式 UI 用）
//
// broadcastMode 是纯模块变量，React 侧看不见其变化。这里单独维护一组监听者，
// 让 useBroadcastMode() 能在开/关时重渲染（如全局黑边 + 底部横条 overlay）。

const broadcastListeners = new Set<() => void>();

function notifyBroadcast() {
  broadcastListeners.forEach((l) => l());
}

/** 更新 broadcastMode 并（值变时）通知订阅者。所有改动都走这里，保持 React 侧同步。 */
function assignBroadcastMode(next: boolean): void {
  if (broadcastMode === next) return;
  broadcastMode = next;
  notifyBroadcast();
}

function wsBase(serverBaseUrl: string): string {
  return (serverBaseUrl || '').replace(/\/+$/, '').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

/** 全局播报端点（不带 conversation_id；连上由原生发 register）。 */
function buildGlobalWsUrl(serverBaseUrl: string, token: string): string {
  return `${wsBase(serverBaseUrl)}/api/ws/audio/global?access_token=${encodeURIComponent(token)}`;
}

/** 单对话端点，带 client=mobile 抬到优先级 P2（压制 Desktop/Web）。 */
function buildSingleWsUrl(serverBaseUrl: string, token: string, conversationId: string): string {
  return (
    `${wsBase(serverBaseUrl)}/api/ws/audio` +
    `?conversation_id=${encodeURIComponent(conversationId)}` +
    `&access_token=${encodeURIComponent(token)}` +
    `&client=mobile`
  );
}

/**
 * 决策连哪条 WS：
 *  - broadcastMode          → 全局端点（收全部对话，独立于 tts_autoplay）
 *  - !broadcast && conv && tts_autoplay → 单对话端点（只该对话）
 *  - 否则                    → 不连
 * 任一时刻最多一条 WS；目标变了断旧连新，同目标幂等。
 */
function reconcile() {
  if (!Native) return;
  let target: { url: string; mode: 'broadcast' | 'single' } | null = null;
  if (session) {
    if (broadcastMode) {
      target = { url: buildGlobalWsUrl(session.server_base_url, session.access_token), mode: 'broadcast' };
    } else if (convId && enabled) {
      target = {
        url: buildSingleWsUrl(session.server_base_url, session.access_token, convId),
        mode: 'single',
      };
    }
  }
  if (!target) {
    if (connectedUrl) {
      connectedUrl = '';
      void Native.stopRealtime().catch(() => {});
    }
    return;
  }
  if (target.url === connectedUrl) return; // 已连同一目标
  connectedUrl = target.url;
  void Native.startRealtime(target.url, target.mode).catch(() => {
    connectedUrl = ''; // 失败清标记，下次可重试
  });
}

// MARK: - 对外 API（供开关 / ChatScreen / app 级控制器调用）

/** 对话内朗读开关变化（tts_autoplay）。 */
export function setRealtimeEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  reconcile();
}

/** 播报模式开关变化（tts_broadcast_mode）。开了即全局监听，独立于 tts_autoplay。 */
export function setBroadcastMode(next: boolean): void {
  if (broadcastMode === next) return;
  assignBroadcastMode(next);
  reconcile();
}

/** ChatScreen 获焦时报告当前活跃对话（单对话模式据此连本对话流）。 */
export function setActiveConversation(nextConvId: string, sess: Session | null): void {
  const changed = nextConvId !== convId || sess !== session;
  convId = nextConvId || '';
  session = sess;
  if (changed) reconcile();
}

/**
 * ChatScreen 失焦时清除活跃对话 → 单对话流断连。退回列表 / 切页 = 离开该对话，Mobile 的
 * MOBILE_SINGLE(P2) 渠道不该滞留（否则后端一直压制 Desktop/Web，其开关误显"被手机压制"）。
 * 播报模式(P1)是全局的、由 broadcastMode 驱动，convId 与它无关——reconcile 里播报分支不看 convId，
 * 故此清除只断单对话流、不影响播报。
 */
export function clearActiveConversation(): void {
  if (!convId) return;
  convId = '';
  reconcile();
}

/** app 启动 / session 就绪时从服务端拉 tts_autoplay（与 Web/Desktop 同一份偏好）；登出(null)即断流。 */
export async function refreshRealtimeFromPrefs(sess: Session | null): Promise<void> {
  session = sess;
  if (!sess) {
    assignBroadcastMode(false);
    setRealtimeEnabled(false); // 登出：断流
    return;
  }
  try {
    const prefs = await getLayoutPreferences(sess);
    assignBroadcastMode(prefs[TTS_BROADCAST_PREF_KEY] === true);
    enabled = prefs[TTS_AUTOPLAY_PREF_KEY] === true;
  } catch {
    /* 拉取失败保持当前值 */
  }
  reconcile();
}

// MARK: - React 订阅

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): RealtimeSnapshot {
  return snapshot;
}

/** 订阅实时朗读状态（如显示"正在朗读"指示）。 */
export function useTtsRealtime(): RealtimeSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribeBroadcast(cb: () => void): () => void {
  broadcastListeners.add(cb);
  return () => broadcastListeners.delete(cb);
}
function getBroadcastSnapshot(): boolean {
  return broadcastMode;
}

/** 订阅播报模式开/关（供全局沉浸式 overlay 判定是否显示）。 */
export function useBroadcastMode(): boolean {
  return useSyncExternalStore(subscribeBroadcast, getBroadcastSnapshot, getBroadcastSnapshot);
}

/**
 * 关闭播报模式并写回服务端（与 UsageSettingsScreen.persistTtsBroadcast 同一套动作）：
 * 先本地立即断全局流，再合并写 layout-preferences。供全局 overlay 的退出按钮调用。
 */
export async function disableBroadcastMode(sess: Session | null): Promise<void> {
  setBroadcastMode(false);
  if (!sess) return;
  try {
    await setLayoutPreferences(sess, { [TTS_BROADCAST_PREF_KEY]: false });
  } catch {
    /* 写回失败：本地已断流，下次 refresh 会以服务端为准 */
  }
}
