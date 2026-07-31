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
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '../api';
import { getLayoutPreferences } from '../api';
import { beaconPing } from '../api/beacon';
import { getBeaconDeviceId } from '../utils/clientInstanceId';
import { refreshTtsMixingModeFromPrefs } from './ttsMixingMode';

type FlopsAudioRealtimeNative = {
  /** mode: 'broadcast'（全局端点，连上发 register）| 'single'（per-conv 端点，纯下行）。 */
  startRealtime(wsUrl: string, mode: 'broadcast' | 'single'): Promise<null>;
  stopRealtime(): Promise<null>;
  /**
   * iOS 专属：播报模式的灵动岛 / 锁屏 Live Activity 开 / 关（fire-and-forget，无返回）。
   * Android 原生模块与未 rebuild 的旧 iOS 包都没有这两个方法 → 用可选链 + Platform 守卫，缺失即 no-op。
   */
  startLiveActivity?(): void;
  endLiveActivity?(): void;
};

// iOS / Android 均有原生 FlopsAudio；缺失（未 rebuild 的旧包）时为 undefined → 全链路 no-op。
const Native: FlopsAudioRealtimeNative | undefined = (NativeModules as any).FlopsAudio;
const emitter = Native ? new NativeEventEmitter(Native as any) : null;

export function isTtsRealtimeSupported(): boolean {
  return !!Native;
}

/** 对话内朗读开关（与 Web/Desktop 同一把）：控制"在对话页内是否连单对话流"。 */
export const TTS_AUTOPLAY_PREF_KEY = 'tts_autoplay';
/**
 * 播报模式开关（Mobile 专属）——存本机 AsyncStorage，per-device：同账号的 dev / release build 各自独立，
 * 不再走账号级 layout-preferences（否则两个 build 会互相翻对方的开关）。presence 里的 broadcast_mode 只是运行时镜像。
 */
const TTS_BROADCAST_MODE_LOCAL_KEY = 'tts_broadcast_mode_local';

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
let broadcastMode = false;    // 播报模式（全局播报，per-device 本地存储）
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
  // 灵动岛 / 锁屏 Live Activity 跟随开关起落。放在这个唯一收敛点（而非仅 setBroadcastMode），
  // 冷启动从本机恢复播报态（refreshRealtimeFromPrefs → assignBroadcastMode(true)）与登出复位
  // （assignBroadcastMode(false)）也能一并驱动，无需各处重复调。
  syncBroadcastLiveActivity(next);
}

/**
 * iOS：把播报开 / 关同步给灵动岛 / 锁屏 Live Activity。
 * 仅 iOS 有原生实现；Android 原生模块与未 rebuild 的旧 iOS 包都没有这两个方法 → 可选链缺失即 no-op。
 * Activity.request 要求 app 在前台——本函数的触发点（用户切开关 / session 就绪 / 登出）都在前台，天然满足。
 */
function syncBroadcastLiveActivity(next: boolean): void {
  if (Platform.OS !== 'ios' || !Native) return;
  try {
    if (next) Native.startLiveActivity?.();
    else Native.endLiveActivity?.();
  } catch {
    /* 原生缺方法 / 抛错都不致命：仅少一个灵动岛指示，播报本身不受影响 */
  }
}

/** 播报开关的本机持久化（per-device）：写 AsyncStorage，失败不致命（内存态仍生效）。 */
async function persistBroadcastModeLocal(mode: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(TTS_BROADCAST_MODE_LOCAL_KEY, mode ? '1' : '0');
  } catch {
    /* 持久化失败：内存态已生效，下次冷启动回退默认关 */
  }
}

/** 从本机读回播报开关（per-device）；缺省 / 读失败都当关。 */
async function loadBroadcastModeLocal(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(TTS_BROADCAST_MODE_LOCAL_KEY)) === '1';
  } catch {
    return false;
  }
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

/** 播报模式开关变化。开了即全局监听，独立于 tts_autoplay；开关本身 per-device 存本机。 */
export function setBroadcastMode(next: boolean): void {
  if (broadcastMode === next) return;
  assignBroadcastMode(next);
  reconcile();
  void persistBroadcastModeLocal(next); // per-device 本地持久化（dev / release 各自独立）
  void reportBroadcastMode(next); // 顺带把开关状态写进设备级 presence，别等下一拍心跳
}

/** 当前播报开关（供 BeaconReporter 心跳把 broadcast_mode 带进 presence）。 */
export function getBroadcastMode(): boolean {
  return broadcastMode;
}

/**
 * 把播报开关状态顺带写进设备级 presence 的 broadcast_mode 字段（独立于 WS，跟朗读实时态无关）。
 * 只带 device_id + platform + flag：不带 device_name/idfv，靠后端 merge 保留旧值（空名不覆盖）；
 * 与 BeaconReporter 的 30s 心跳互不干扰（各自一发独立 ping）。失败不致命——下一拍心跳会以
 * getBroadcastMode() 现值补写。session 缺失（未登录）则跳过。
 */
async function reportBroadcastMode(mode: boolean): Promise<void> {
  const sess = session;
  if (!sess) return;
  try {
    const deviceId = await getBeaconDeviceId();
    await beaconPing(sess.server_base_url, sess.access_token, {
      device_id: deviceId,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      state: 'foreground', // 切开关必发生在前台
      broadcast_mode: mode,
    });
  } catch {
    /* 顺带更新，失败不致命 */
  }
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

/**
 * app 启动 / session 就绪时恢复两个开关：
 *  - tts_autoplay      → 服务端 layout-preferences（与 Web/Desktop 同一份，跨端同步）
 *  - 播报模式           → 本机 AsyncStorage（per-device，dev / release build 各自独立，不随账号）
 * 登出(null)即断流并复位内存态（本机开关值保留，重登时再读回）。
 */
export async function refreshRealtimeFromPrefs(sess: Session | null): Promise<void> {
  session = sess;
  if (!sess) {
    assignBroadcastMode(false);
    setRealtimeEnabled(false); // 登出：断流
    return;
  }
  // 播报模式是 per-device 本地态，从本机读，跟账号级 layout-preferences 无关。
  assignBroadcastMode(await loadBroadcastModeLocal());
  try {
    const prefs = await getLayoutPreferences(sess);
    enabled = prefs[TTS_AUTOPLAY_PREF_KEY] === true;
    // 同一份 prefs 里读混音方式并下发原生（duck/mix），避免二次请求。
    void refreshTtsMixingModeFromPrefs(sess, prefs);
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
 * 关闭播报模式。setBroadcastMode(false) 一把搞定：断全局流 + 写本机 AsyncStorage（per-device）
 * + 补写设备级 presence。供全局 overlay 的退出按钮调用。
 */
export function disableBroadcastMode(): void {
  setBroadcastMode(false);
}
