/**
 * 移动端实时语音听写会话：麦克风 → 16k/16bit/mono PCM → WS /api/ws/asr。
 *
 * 与 Web 版 voiceDictation.js 的状态机一致，但用 react-native-audio-api 的
 * AudioRecorder 采集 Float32 PCM（RN 没有 getUserMedia / AudioContext）。
 *
 *   const s = new VoiceDictationSession({ serverBaseUrl, token, onResult, onDone, onError });
 *   await s.start();  // 申请麦克风 + 建立 WS；ready 前的音频先攒着，ready 后冲刷
 *   s.stop();         // 说完了：停采集、发 finish，等最终 result(last=true)+done
 *   s.cancel();       // 放弃：发 cancel 并立即拆除
 */
import { AppState, NativeModules, Platform } from 'react-native';
import { AudioManager, AudioRecorder } from 'react-native-audio-api';

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_BYTES = 6400; // 200ms @ 16k/16bit/mono
const CALLBACK_BUFFER_LENGTH = 1600; // ~100ms @ 16k，单声道

/** AVAudioSessionPortBuiltInMic 的 rawValue —— getDevicesInfo 的 category 就是 portType 原样透传
 *  （见 react-native-audio-api 的 AudioSessionManager.mm parseDeviceList）。 */
const IOS_BUILTIN_MIC_PORT = 'MicrophoneBuiltIn';

type SessionState = 'idle' | 'starting' | 'recording' | 'finalizing' | 'closed';

interface VoiceDictationOptions {
  serverBaseUrl: string;
  token: string;
  onResult?: (text: string, last: boolean) => void;
  onDone?: (text: string) => void;
  onError?: (message: string) => void;
  /** 非致命提示（如耳机麦不可用回落内置麦）：录音继续，仅 UI 上闪一句话。 */
  onNotice?: (message: string) => void;
  /** 每帧音频（~100ms）的归一化 RMS 振幅（0~1），供 UI 驱动录音动画。 */
  onAmplitude?: (rms: number) => void;
  /** 用户长按 mic 选的麦克风源。auto=按连接自动、builtin=手机内置麦、headset=耳机麦。
   *  iOS 靠 audio session options + setPreferredInput；Android 靠 FlopsAudio 开/关蓝牙 SCO。 */
  preferredMicSource?: 'auto' | 'builtin' | 'headset';
  /** 纯采集模式（远程麦克风）：手机只当采集端，自己不放任何声音。
   *
   *  **不申请任何输出路由**：iOS 用 category=record + 空 options。默认那套
   *  playAndRecord + allowBluetoothA2DP 会把 AirPods 列为本次会话的合法输出候选，而同账号
   *  AirPods 一次只能挂在一台设备上 —— iPhone 一激活系统就把耳机从 Mac 抢过来，Mac 那边
   *  输出设备消失、按「耳机被拔」暂停正在播的视频（用户实测现象）。远程麦克风全程不出声，
   *  这条输出路由纯属白要，去掉即根治。
   *
   *  **输入锁死内置麦**：不带 allowBluetoothHFP（蓝牙不作为输入），再显式 setPreferredInput
   *  到 MicrophoneBuiltIn 顶掉有线/USB 耳机麦。本模式下 preferredMicSource 被忽略。
   *
   *  仍保留「非混音激活打断本机其他 App」—— record 同样是非混音类别，手机上在放的音频照旧
   *  被打断，不让它串进麦克风。 */
  captureOnly?: boolean;
  /** 跨设备语音输入（电脑邀请手机当麦克风）：邀请 id。与 forwardTo 一起拼进 WS URL，
   *  服务端据此把识别结果实时转发到电脑端。 */
  inviteId?: string;
  /** 转发目标（电脑端 device_id），与 inviteId 配套。 */
  forwardTo?: string;
  /** 服务端下发 {type:'remote_stop'}（电脑端点了停止）时回调。会话不自动停，
   *  由调用方决定 stop()（要最终结果）还是 cancel()。 */
  onRemoteStop?: () => void;
}

/** 人声正常说话的满格定标点：rms 到这里就算 1.0（喊会超过、被 clamp）。 */
const AMPLITUDE_FULL_SCALE = 0.15;

/** 一帧 Float32 PCM → 归一化 RMS 振幅（0~1）。 */
function frameAmplitude(float32: Float32Array): number {
  if (float32.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  const rms = Math.sqrt(sum / float32.length);
  return Math.min(1, rms / AMPLITUDE_FULL_SCALE);
}

/** Float32 [-1,1] → Int16，顺带从 fromRate 线性重采样到 16k */
function floatTo16kInt16(float32: Float32Array, fromRate: number): Int16Array {
  if (fromRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const v = Math.max(-1, Math.min(1, float32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const frac = pos - i0;
    const v = Math.max(-1, Math.min(1, float32[i0] * (1 - frac) + float32[i1] * frac));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** 把 4 字节 ASCII 写进 buf[off..off+4]。 */
function writeAscii(buf: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < 4; i++) buf[off + i] = s.charCodeAt(i);
}

/** WAV PCM 头：44 字节，固定布局——RIFF / fmt / data 三块。 */
function writeWavHeader(
  buf: Uint8Array,
  dataSize: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): void {
  const view = new DataView(buf.buffer, buf.byteOffset, 44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  writeAscii(buf, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(buf, 8, 'WAVE');
  writeAscii(buf, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt 子块长度
  view.setUint16(20, 1, true); // audioFormat = 1 (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(buf, 36, 'data');
  view.setUint32(40, dataSize, true);
}

/** https://host/ → wss://host/api/ws/asr?access_token=...（extra 里的空值跳过不拼）。 */
function buildAsrUrl(
  serverBaseUrl: string,
  token: string,
  extra?: Record<string, string | undefined>,
): string {
  const trimmed = (serverBaseUrl || '').replace(/\/+$/, '');
  const ws = trimmed.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  let url = `${ws}/api/ws/asr?access_token=${encodeURIComponent(token)}`;
  for (const [k, v] of Object.entries(extra || {})) {
    if (v) url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }
  return url;
}

/** base64 → 原始字节（Hermes 上 global.atob 可用）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = global.atob(b64 || '');
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PLAYBACK_INTERVAL_MS = 200; // 每拍发一个 CHUNK_BYTES(6400B ≈ 200ms)，模拟麦克风实时节奏

interface PlaybackSessionOptions {
  serverBaseUrl: string;
  token: string;
  audioBase64: string; // 从 API 获取的 base64 WAV（16k/16bit/mono）
  onResult: (text: string) => void;
  onDone: (text: string) => void;
  onError: (msg: string) => void;
}

/**
 * 回放会话：把一段已保存的 WAV 当作输入源，按麦克风同样的节奏流式喂给 /api/ws/asr。
 * 与 {@link VoiceDictationSession} 协议一致，但不碰麦克风——独立实现，互不影响。
 *
 *   const p = createPlaybackSession({ ... });
 *   await p.start();  // 建 WS；ready 后每 200ms 发 6400B PCM
 *   p.stop();         // 松手：立刻停发、发 finish，等最终 result + done
 *   // 音频喂完也会自动 finish
 */
export function createPlaybackSession(args: PlaybackSessionOptions): {
  start: () => Promise<void>;
  stop: () => void;
} {
  let ws: WebSocket | null = null;
  let wsReady = false;
  let pcm: Uint8Array = new Uint8Array(0); // 跳过 44 字节 WAV 头后的原始 PCM
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let lastText = '';
  let finished = false; // finish 已发（音频喂完或松手）
  let closed = false;

  const clearTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const teardown = (): void => {
    clearTimer();
    if (doneTimer) {
      clearTimeout(doneTimer);
      doneTimer = null;
    }
    const w = ws;
    ws = null;
    wsReady = false;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.onclose = null;
      try {
        if (w.readyState === 0 /* CONNECTING */ || w.readyState === 1 /* OPEN */) w.close();
      } catch {
        /* ignore */
      }
    }
  };

  const finishOk = (): void => {
    if (closed) return;
    closed = true;
    teardown();
    args.onDone(lastText);
  };

  const fail = (msg: string): void => {
    if (closed) return;
    closed = true;
    teardown();
    args.onError(msg);
  };

  /** 没有更多音频：停发、发 finish，等服务端回最终结果（带 8s 兜底）。 */
  const sendFinish = (): void => {
    if (finished || closed) return;
    finished = true;
    clearTimer();
    try {
      if (ws?.readyState === 1 /* OPEN */) ws.send(JSON.stringify({ type: 'finish' }));
    } catch {
      /* ignore */
    }
    doneTimer = setTimeout(() => finishOk(), 8000);
  };

  const tick = (): void => {
    if (closed || !wsReady || ws?.readyState !== 1 /* OPEN */) return;
    if (offset >= pcm.length) {
      sendFinish(); // 喂完了，自动收尾
      return;
    }
    const end = Math.min(offset + CHUNK_BYTES, pcm.length);
    const chunk = pcm.slice(offset, end); // slice 复制成独立 buffer
    offset = end;
    try {
      ws.send(chunk.buffer);
    } catch {
      /* ignore */
    }
  };

  const onMessage = (ev: WebSocketMessageEvent): void => {
    if (typeof ev.data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      wsReady = true;
      timer = setInterval(tick, PLAYBACK_INTERVAL_MS);
      return;
    }
    if (msg.type === 'result') {
      if (typeof msg.text === 'string' && (msg.text || msg.last)) {
        lastText = msg.text;
        args.onResult(msg.text);
      }
      return;
    }
    if (msg.type === 'done') {
      finishOk();
      return;
    }
    if (msg.type === 'error') {
      fail(`识别服务错误：${msg.message || msg.code || '未知'}`);
    }
  };

  const start = async (): Promise<void> => {
    try {
      const bytes = base64ToBytes(args.audioBase64);
      pcm = bytes.length > 44 ? bytes.subarray(44) : new Uint8Array(0);
      offset = 0;
      const w = new WebSocket(buildAsrUrl(args.serverBaseUrl, args.token));
      ws = w;
      w.onmessage = onMessage;
      w.onerror = () => {
        if (!closed) fail('听写服务连接失败');
      };
      w.onclose = (ev: any) => {
        if (closed) return;
        if (finished) finishOk(); // 收尾后服务端关闭：直接出结果
        else fail(ev?.code === 4401 ? '登录态失效，请重新登录' : '听写连接中断');
      };
    } catch (e: any) {
      fail(`回放初始化失败：${e?.message || e}`);
    }
  };

  const stop = (): void => {
    sendFinish(); // 松手：立刻停发，即使后面还有音频
  };

  return { start, stop };
}

/** Android 录音焦点：让自家 FlopsAudio 原生模块持/放焦点——原生侧检测输出设备，外放持
 *  GAIN_TRANSIENT 暂停其他 app（防回音）、耳机持 MAY_DUCK 只压低音量不暂停。
 *  注意不能走 react-native-audio-api：它的原生模块注册名是 AudioAPIModule（不是 AudioAPI），
 *  且并未导出任何直接的焦点方法（只有 observeAudioInterruptions 间接申请、还捆绑中断事件）。 */
function setRecordingDuck(active: boolean): void {
  const native = (NativeModules as any).FlopsAudio;
  if (!native?.setRecordingDuck) {
    console.log('[dictation] FlopsAudio.setRecordingDuck 不可用（原生未重建到设备？）');
    return;
  }
  native
    .setRecordingDuck(active)
    .then(() => console.log(`[dictation] recording duck ${active ? 'on' : 'off'}`))
    .catch((e: any) => console.log('[dictation] recording duck 调用失败:', e?.message || e));
}

/** iOS：让 FlopsAudio 让出共享 AVAudioSession（暂停回放 + 停实时保活引擎 + 真 setActive(false)）。
 *
 *  iOS 只在 setActive(true) 那一刻做音频仲裁；session 已经是 active 时，光换 category /
 *  options 既压不低也打断不了别人。而实时朗读的保活态（播报模式开、或对话内朗读开着）会把
 *  session 长期摁在 active，于是下面那次非混音 playAndRecord 激活退化成空操作——
 *  表现为画中画视频既不停也不压低。先让路，后面的激活才是一次真正的 inactive→active 跃迁。
 *
 *  必须在 AudioManager.setAudioSessionActivity(false) 之前调：保活引擎还跑着时那次
 *  deactivate 会拿到 AVAudioSessionErrorCodeIsBusy 被静默吞掉。
 *  Android / 未重建的旧包缺方法即 no-op（录音本身不受影响）。 */
async function beginExternalRecording(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const native = (NativeModules as any).FlopsAudio;
  if (!native?.beginExternalRecording) {
    console.log('[dictation] FlopsAudio.beginExternalRecording 不可用（原生未重建到设备？）');
    return false;
  }
  try {
    await native.beginExternalRecording();
    return true;
  } catch (e: any) {
    console.log('[dictation] beginExternalRecording 调用失败:', e?.message || e);
    return false;
  }
}

/** iOS：录音结束后把 session 还给 FlopsAudio（WS 仍连着则重建 mix 保活态）。
 *  须在 setAudioSessionActivity(false) **之后**调——打断的解除靠那次带
 *  notifyOthersOnDeactivation 的 deactivate（对方收到 .shouldResume 才恢复播放），
 *  顺序反了会让被打断的 App 一直停着不恢复。 */
function endExternalRecording(): void {
  const native = (NativeModules as any).FlopsAudio;
  if (!native?.endExternalRecording) return;
  native
    .endExternalRecording()
    .catch((e: any) => console.log('[dictation] endExternalRecording 调用失败:', e?.message || e));
}

/** 保持屏幕常亮（FlopsAudio.setKeepScreenOn：iOS isIdleTimerDisabled、Android
 *  FLAG_KEEP_SCREEN_ON）。两端都只在 app 前台时生效、切后台系统自动恢复锁屏，不烧屏；
 *  录音中的前后台切换仍由 AppState 监听显式开关兜底。
 *
 *  原生标志是全局单例，直接开关会互相覆盖（听写会话结束的 off 会关掉 RemoteMic 整页
 *  的常亮）——所以用引用计数：各持有方 acquire/release 自己的 tag，任一持有即常亮，
 *  全部释放才恢复自动锁屏。两个方法都幂等。 */
const keepScreenOnHolders = new Set<string>();

function nativeSetKeepScreenOn(on: boolean): void {
  const native = (NativeModules as any).FlopsAudio;
  if (!native?.setKeepScreenOn) {
    console.log('[dictation] FlopsAudio.setKeepScreenOn 不可用（原生未重建到设备？）');
    return;
  }
  native
    .setKeepScreenOn(on)
    .then(() => console.log(`[dictation] keep screen on ${on ? 'on' : 'off'}`))
    .catch((e: any) => console.log('[dictation] setKeepScreenOn 调用失败:', e?.message || e));
}

export function acquireKeepScreenOn(tag: string): void {
  const wasEmpty = keepScreenOnHolders.size === 0;
  keepScreenOnHolders.add(tag);
  if (wasEmpty) nativeSetKeepScreenOn(true);
}

export function releaseKeepScreenOn(tag: string): void {
  if (!keepScreenOnHolders.delete(tag)) return;
  if (keepScreenOnHolders.size === 0) nativeSetKeepScreenOn(false);
}

/** Android 麦克风输入源：headset → FlopsAudio 启动蓝牙 SCO（等 connected，超时 ~3s）、
 *  builtin → 关 SCO 回默认路由。返回是否切换成功；原生方法缺失（未重建）或异常按失败
 *  处理，录音继续走系统默认路由不中断。 */
async function setAndroidMicSource(source: 'builtin' | 'headset'): Promise<boolean> {
  const native = (NativeModules as any).FlopsAudio;
  if (!native?.setMicSource) {
    console.log('[dictation] FlopsAudio.setMicSource 不可用（原生未重建到设备？）');
    return false;
  }
  try {
    const ok = await native.setMicSource(source);
    console.log(`[dictation] mic source → ${source}: ${ok}`);
    return Boolean(ok);
  } catch (e: any) {
    console.log('[dictation] setMicSource 调用失败:', e?.message || e);
    return false;
  }
}

let sessionSeq = 0;

export class VoiceDictationSession {
  state: SessionState = 'idle';
  lastText = '';

  private readonly serverBaseUrl: string;
  private readonly token: string;
  private readonly onResult: (text: string, last: boolean) => void;
  private readonly onDone: (text: string) => void;
  private readonly onError: (message: string) => void;
  private readonly onNotice: (message: string) => void;
  private readonly onAmplitude: ((rms: number) => void) | null;
  private readonly onRemoteStop: () => void;
  private readonly preferredMicSource: 'auto' | 'builtin' | 'headset';
  private readonly captureOnly: boolean;
  private readonly inviteId: string;
  private readonly forwardTo: string;
  private readonly _duckDuringRecord: boolean;

  private _ws: WebSocket | null = null;
  private _wsReady = false;
  private _recorder: AudioRecorder | null = null;
  private _pendingBeforeReady: ArrayBuffer[] = []; // ready 之前攒的 PCM
  private _byteCarry = new Uint8Array(0); // 不足一个 chunk 的尾巴
  private _finishQueued = false;
  private _doneTimer: ReturnType<typeof setTimeout> | null = null;
  /** start → stop 之间所有 16k/16bit/mono PCM 字节，按到达顺序攒着，供 getRecordedAudio 拼 WAV。 */
  private _pcmChunks: Uint8Array[] = [];
  private _pcmTotalBytes = 0;
  /** 录音窗口内的前后台监听：后台关屏幕常亮、回前台（仍在录）恢复。 */
  private _appStateSub: { remove: () => void } | null = null;
  /** 本会话在屏幕常亮引用计数里的持有标识 */
  private readonly _keepAwakeTag = `dictation-session-${++sessionSeq}`;
  /** iOS：本会话是否已让 FlopsAudio 让出 session（_stopCapture 可重入，靠它保证只还一次）。 */
  private _externalRecordingHeld = false;

  constructor(opts: VoiceDictationOptions) {
    this.serverBaseUrl = opts.serverBaseUrl;
    this.token = opts.token || '';
    this.onResult = opts.onResult || (() => {});
    this.onDone = opts.onDone || (() => {});
    this.onError = opts.onError || (() => {});
    this.onNotice = opts.onNotice || (() => {});
    this.onAmplitude = opts.onAmplitude || null;
    this.onRemoteStop = opts.onRemoteStop || (() => {});
    this.preferredMicSource = opts.preferredMicSource || 'auto';
    this.captureOnly = opts.captureOnly === true;
    this.inviteId = opts.inviteId || '';
    this.forwardTo = opts.forwardTo || '';
    // Android：录音时自动申请 duck 焦点降低其他 app 音量；iOS 走非混音 session 的打断（见 start()）
    this._duckDuringRecord = Platform.OS === 'android';
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'starting';
    console.log('[dictation] start() preferredMicSource=', this.preferredMicSource);
    // 每次会话独立攒一份 PCM 用于回放/落库
    this._pcmChunks = [];
    this._pcmTotalBytes = 0;

    // 麦克风权限 + 音频会话
    try {
      // 按用户长按 mic 选的源动态配 options：headset → HFP（耳机麦）、builtin/auto → A2DP 分离（iPhone 内置麦+蓝牙高音质）。
      // 纯采集模式（远程麦克风）例外：忽略 preferredMicSource，走下面的 record + 空 options。
      const wantHeadsetMic = !this.captureOnly && this.preferredMicSource === 'headset';
      console.log('[dictation] captureOnly=', this.captureOnly, 'wantHeadsetMic=', wantHeadsetMic);
      // 不带任何 mix / duck 选项 = 纯非混音 playAndRecord：激活时系统向其它 App 发打断
      // 请求，对方遵守就暂停、音量归零。曾短暂改用 duckOthers，但实测只压到约 -20dB，
      // 画中画视频的声音照样进麦克风；打断是唯一能真正归零的路子（代价是对方 App 可以
      // 不遵守）。
      //
      // KNOWN ISSUE（不修、也修不了）：哔哩哔哩 iPad 画中画，用户上传类视频（用户投稿/
      // 自制）无视系统打断请求，语音输入时照常播放；剧集类（如生活大爆炸）则正常停止。
      // 实测确认是 B 站对不同视频类型走不同播放路径所致，非本端缺陷。系统打断只是请求，
      // 无任何 API 能强制对方暂停，iOS 不提供"静音他人类音频"的能力。
      //
      // 两条路径都只在 setActive(true) 的仲裁时刻生效，所以下面那次真跃迁
      // （beginExternalRecording 让路 → deactivate → activate）是前提——修复前那种
      // 「视频顿一下就续播」是激活空操作下的伪打断，跟现在的真打断不是一回事。
      //
      // 纯采集模式（远程麦克风）不走上面这套：category=record 压根没有输出路由可占，options 留空
      // —— 不带 A2DP 就不会把 AirPods 列为输出候选（那正是耳机被从 Mac 抢走的起点），不带 HFP
      // 就不会把蓝牙当输入。record 同样是非混音类别，「打断本机其他 App」的效果原样保留。
      // 详见 VoiceDictationOptions.captureOnly。
      const iosCategory = this.captureOnly ? 'record' : 'playAndRecord';
      const iosOpts = (
        this.captureOnly
          ? []
          : wantHeadsetMic
            ? ['allowBluetoothHFP']
            : ['allowBluetoothA2DP', 'defaultToSpeaker']
      ) as any;
      // 让 FlopsAudio 先交出 session（实时朗读保活会长期占着），否则下面这次 deactivate
      // 拿到 busy 失败、activate 退化成空操作，打断请求压根不会发出。
      this._externalRecordingHeld = await beginExternalRecording();
      // 再强制 deactivate 一次：react-native-audio-api 内部有 isActive 缓存，为 true 时
      // setAudioSessionActivity(true) 直接 early-return、跳过 configureAudioSession；而 TTS
      // （FlopsAudio）是绕过该库直接把共享 session 改成 .playback 的——缓存变脏（上次
      // deactivate 失败即残留 true）时 category 配不回 playAndRecord，录音全程静音。
      // deactivate 把缓存归位，保证下面 activate 必然重配 category/options 并重新仲裁。
      await AudioManager.setAudioSessionActivity(false).catch(() => {});
      AudioManager.setAudioSessionOptions({
        iosCategory,
        iosMode: 'default',
        iosOptions: iosOpts,
      });
      const status = await AudioManager.requestRecordingPermissions();
      if (status !== 'Granted') {
        this._teardown();
        this.state = 'closed';
        this.onError('麦克风权限被拒绝');
        return;
      }
      await AudioManager.setAudioSessionActivity(true);
      if (Platform.OS === 'android') {
        // Android：库的 setInputDevice 是 noop、Oboe 流跟随系统默认路由，只能系统级切。
        // 必须在 _startRecorder() 前切好；SCO 慢半拍时靠 Oboe 断流自动重连迁移到耳机麦。
        await this._configureAndroidMicSource(wantHeadsetMic);
      } else if (this.captureOnly) {
        await this._pinBuiltInInput();
      } else if (wantHeadsetMic) {
        await this._pinHeadsetInput();
      } else {
        // 调试：看激活后 iOS 实际选了什么路由（不阻塞录音启动）
        AudioManager.getDevicesInfo().then((info: any) => {
          console.log('[dictation] route after activate:', JSON.stringify({
            current: (info?.currentInputs || []).map((d: any) => ({ name: d.name, category: d.category })),
            outputs: (info?.currentOutputs || []).map((d: any) => ({ name: d.name, category: d.category })),
          }));
        }).catch(() => {});
      }
    } catch (e: any) {
      this._teardown();
      this.state = 'closed';
      this.onError(`无法打开麦克风：${e?.message || e}`);
      return;
    }

    // WS 与采集并行建立；音频先攒，ready 后冲刷
    this._openWebSocket();
    try {
      this._startRecorder();
    } catch (e: any) {
      this._fail(`录音初始化失败：${e?.message || e}`);
      return;
    }
    if (this.state === 'starting') this.state = 'recording';
  }

  /** headset 模式：等蓝牙 HFP 输入 port 出现并显式钉住。SCO 链路建立需时（几百 ms~2s），
   *  且 iOS 17+ 配了 allowBluetoothHFP 也不再自动把输入切到蓝牙，必须 setPreferredInput。
   *  轮询 5 次×500ms：当前路由已在耳机麦 → 直接返回；availableInputs 出现耳机 port →
   *  setInputDevice 钉住；超时 → 回落系统默认（内置麦）并 onNotice 提示，录音照常。 */
  private async _pinHeadsetInput(): Promise<void> {
    const isHeadsetPort = (c: string) =>
      c === 'BluetoothHFP' || c === 'MicrophoneWired' || c === 'HeadsetMic' || c === 'USBAudio';
    for (let i = 0; i < 5; i++) {
      const info: any = await AudioManager.getDevicesInfo().catch(() => null);
      const available: any[] = info?.availableInputs || [];
      const current: any[] = info?.currentInputs || [];
      console.log(`[dictation] pin headset try ${i}:`, JSON.stringify({
        available: available.map((d) => ({ name: d.name, category: d.category })),
        current: current.map((d) => ({ name: d.name, category: d.category })),
      }));
      if (current.some((d) => isHeadsetPort(d.category))) return;
      const target = available.find((d) => isHeadsetPort(d.category));
      if (target) {
        try {
          await AudioManager.setInputDevice(target.id);
          console.log('[dictation] pinned headset input:', target.name);
          return;
        } catch (e: any) {
          console.log('[dictation] setInputDevice failed:', e?.message || e);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.onNotice('耳机麦克风不可用，已使用 iPhone 麦克风');
  }

  /** 纯采集模式：把输入钉死在内置麦。category=record + 无 allowBluetoothHFP 已经把蓝牙排除在
   *  输入之外，但**有线 / USB 耳机麦插着时系统仍会默认选它**（那是内建路由决策，与蓝牙选项无关）
   *  —— 这里显式 setPreferredInput 到 MicrophoneBuiltIn 顶掉。
   *  内置麦恒在 availableInputs 里（不像蓝牙 SCO 要等链路建立），单次即可，无需 _pinHeadsetInput
   *  那样轮询。找不到 / 设置失败就沿用系统默认路由，录音照常不中断。 */
  private async _pinBuiltInInput(): Promise<void> {
    const info: any = await AudioManager.getDevicesInfo().catch(() => null);
    const available: any[] = info?.availableInputs || [];
    const current: any[] = info?.currentInputs || [];
    console.log('[dictation] pin builtin mic:', JSON.stringify({
      available: available.map((d) => ({ name: d.name, category: d.category })),
      current: current.map((d) => ({ name: d.name, category: d.category })),
    }));
    if (current.some((d) => d.category === IOS_BUILTIN_MIC_PORT)) return; // 已经是内置麦
    const target = available.find((d) => d.category === IOS_BUILTIN_MIC_PORT);
    if (!target) return; // 理论上不会发生；真没有就用系统默认
    try {
      await AudioManager.setInputDevice(target.id);
      console.log('[dictation] pinned builtin input:', target.name);
    } catch (e: any) {
      console.log('[dictation] pin builtin failed:', e?.message || e);
    }
  }

  /** Android 版输入源配置。纯采集模式（远程麦克风）下 wantHeadsetMic 恒为 false，走 builtin
   *  分支关掉 SCO —— 蓝牙耳机因此不会被拿去当输入，输出也不进通话音质。注意 Android 只能做到
   *  这一步：库的 setInputDevice 是 noop（见下），有线耳机插着时系统仍走耳机麦，没有对应
   *  iOS setPreferredInput 的手段。
   *  headset：仅蓝牙（availableInputs 有 "Bluetooth SCO"）需要开 SCO；
   *  有线/USB 插上系统本来就默认走耳机麦，无需动作（也别 startBluetoothSco 空等 3s 超时）。
   *  builtin：关 SCO 即回内置麦（蓝牙输出保持 A2DP 高音质，对齐 iOS A2DP 分离模式）。
   *  注意 Android 端 getDevicesInfo 的 currentInputs/currentOutputs 恒为空数组，只能看
   *  availableInputs；字段是 type 不是 iOS 的 category。 */
  private async _configureAndroidMicSource(wantHeadsetMic: boolean): Promise<void> {
    if (!wantHeadsetMic) {
      // 显式关一次：清掉上次会话/异常残留的 SCO（未开时幂等无害）
      await setAndroidMicSource('builtin');
      return;
    }
    const info: any = await AudioManager.getDevicesInfo().catch(() => null);
    const inputs: any[] = info?.availableInputs || [];
    console.log('[dictation] android inputs:', JSON.stringify(
      inputs.map((d) => ({ name: d.name, type: d.type }))));
    const hasBtMic = inputs.some((d) => d.type === 'Bluetooth SCO');
    if (!hasBtMic) return; // 有线/USB/LE Audio：默认路由已是耳机麦（或无 SCO 可开），不动
    const ok = await setAndroidMicSource('headset');
    if (!ok) this.onNotice('耳机麦克风不可用，已使用手机麦克风');
  }

  /** 说完了：停采集，把尾巴和 finish 发出去，等服务端回最终结果 */
  stop(): void {
    if (this.state !== 'recording' && this.state !== 'starting') return;
    this.state = 'finalizing';
    this._stopCapture();
    if (this._wsReady) {
      this._flushCarry();
      this._wsSendJson({ type: 'finish' });
    } else if (this._ws) {
      this._finishQueued = true; // 还没 ready：等 ready 回调里补发
    }
    this._doneTimer = setTimeout(() => this._finish(), 8000); // 兜底
  }

  cancel(): void {
    if (this.state === 'closed') return;
    const ws = this._ws;
    this._teardown();
    this.state = 'closed';
    try {
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: 'cancel' }));
        ws.close();
      }
    } catch {
      /* 拆除路径，忽略 */
    }
  }

  /**
   * 把 start → stop 之间累计的 PCM 数据拼成完整 WAV(16k/16bit/mono),返回可直接当 audio/wav
   * 上传或喂 <audio> 解码的 ArrayBuffer。没有数据时返回仅含头部的 44 字节空 WAV。
   */
  getRecordedAudio(): ArrayBuffer {
    const dataSize = this._pcmTotalBytes;
    const out = new Uint8Array(44 + dataSize);
    writeWavHeader(out, dataSize, TARGET_SAMPLE_RATE, 1, 16);
    let off = 44;
    for (const chunk of this._pcmChunks) {
      out.set(chunk, off);
      off += chunk.length;
    }
    return out.buffer;
  }

  // -------------------- internal --------------------

  private _openWebSocket(): void {
    const ws = new WebSocket(
      buildAsrUrl(this.serverBaseUrl, this.token, {
        invite_id: this.inviteId || undefined,
        forward_to: this.forwardTo || undefined,
      }),
    );
    this._ws = ws;
    ws.onmessage = (ev) => this._onWsMessage(ev);
    ws.onerror = () => {
      if (this.state === 'starting' || this.state === 'recording') {
        this._fail('听写服务连接失败');
      }
    };
    ws.onclose = (ev: any) => {
      if (this.state === 'starting' || this.state === 'recording') {
        this._fail(ev?.code === 4401 ? '登录态失效，请重新登录' : '听写连接中断');
      }
    };
  }

  private _onWsMessage(ev: WebSocketMessageEvent): void {
    if (typeof ev.data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      this._wsReady = true;
      for (const buf of this._pendingBeforeReady) this._ws?.send(buf);
      this._pendingBeforeReady = [];
      if (this._finishQueued) {
        this._flushCarry();
        this._wsSendJson({ type: 'finish' });
        this._finishQueued = false;
      }
      return;
    }
    if (msg.type === 'result') {
      if (typeof msg.text === 'string' && (msg.text || msg.last)) {
        this.lastText = msg.text;
        this.onResult(msg.text, Boolean(msg.last));
      }
      return;
    }
    if (msg.type === 'done') {
      this._finish();
      return;
    }
    if (msg.type === 'remote_stop') {
      this.onRemoteStop();
      return;
    }
    if (msg.type === 'error') {
      this._fail(`识别服务错误：${msg.message || msg.code || '未知'}`);
    }
  }

  private _startRecorder(): void {
    const recorder = new AudioRecorder();
    this._recorder = recorder;
    // Android：录音时 duck 其他 app 音量（iOS 已通过 setAudioSessionActivity 覆盖）
    if (this._duckDuringRecord) setRecordingDuck(true);
    // 录音中屏幕常亮：长段口述不能被自动锁屏打断。切后台立即关（防烧屏）、回前台恢复
    acquireKeepScreenOn(this._keepAwakeTag);
    this._appStateSub = AppState.addEventListener('change', (next) => {
      const stillRecording = this.state === 'recording' || this.state === 'starting';
      if (next === 'active' && stillRecording) acquireKeepScreenOn(this._keepAwakeTag);
      else releaseKeepScreenOn(this._keepAwakeTag);
    });
    recorder.onAudioReady(
      { sampleRate: TARGET_SAMPLE_RATE, bufferLength: CALLBACK_BUFFER_LENGTH, channelCount: 1 },
      (event) => {
        if (this.state !== 'recording' && this.state !== 'starting') return;
        const float32 = event.buffer.getChannelData(0);
        if (this.onAmplitude) this.onAmplitude(frameAmplitude(float32));
        this._pushPcm(floatTo16kInt16(float32, event.buffer.sampleRate));
      },
    );
    recorder.onError((err) => this._fail(`录音错误：${err?.message || '未知'}`));
    recorder.start();
  }

  /** 攒字节，凑满 CHUNK_BYTES 发一片 */
  private _pushPcm(int16: Int16Array): void {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    // 单独留一份拷贝给 getRecordedAudio()——后续 send_audio 会切片,不能共用 buffer
    const archived = new Uint8Array(bytes.length);
    archived.set(bytes);
    this._pcmChunks.push(archived);
    this._pcmTotalBytes += archived.length;
    const merged = new Uint8Array(this._byteCarry.length + bytes.length);
    merged.set(this._byteCarry, 0);
    merged.set(bytes, this._byteCarry.length);
    let off = 0;
    while (merged.length - off >= CHUNK_BYTES) {
      this._sendAudio(merged.slice(off, off + CHUNK_BYTES).buffer);
      off += CHUNK_BYTES;
    }
    this._byteCarry = merged.slice(off);
  }

  private _flushCarry(): void {
    if (this._byteCarry.length > 0) {
      this._sendAudio(this._byteCarry.slice(0).buffer);
      this._byteCarry = new Uint8Array(0);
    }
  }

  private _sendAudio(arrayBuffer: ArrayBuffer): void {
    if (this._wsReady && this._ws?.readyState === 1 /* OPEN */) {
      this._ws.send(arrayBuffer);
    } else {
      this._pendingBeforeReady.push(arrayBuffer);
    }
  }

  private _wsSendJson(obj: unknown): void {
    try {
      if (this._ws?.readyState === 1 /* OPEN */) this._ws.send(JSON.stringify(obj));
    } catch {
      /* 关闭竞态，忽略 */
    }
  }

  private _finish(): void {
    if (this.state === 'closed') return;
    this._teardown();
    this.state = 'closed';
    this.onDone(this.lastText);
  }

  private _fail(message: string): void {
    if (this.state === 'closed') return;
    this._teardown();
    this.state = 'closed';
    this.onError(message);
  }

  private _stopCapture(): void {
    const recorder = this._recorder;
    this._recorder = null;
    if (recorder) {
      try {
        recorder.clearOnAudioReady();
      } catch {
        /* ignore */
      }
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    // Android：录音结束释放 duck 焦点（原生侧幂等，_stopCapture 重入无害）
    if (this._duckDuringRecord) setRecordingDuck(false);
    // Android：关 SCO 恢复 A2DP 高音质路由（未开时幂等无害）
    if (Platform.OS === 'android') setAndroidMicSource('builtin').catch(() => {});
    // 释放本会话的屏幕常亮持有（若 RemoteMic 整页等其他持有方还在，常亮不受影响）
    this._appStateSub?.remove();
    this._appStateSub = null;
    releaseKeepScreenOn(this._keepAwakeTag);
    // 先 deactivate（notifyOthersOnDeactivation 默认 true → 被打断的 App 收到 .shouldResume
    // 恢复播放），再把 session 还给 FlopsAudio 重建保活；顺序反了对方会一直停着不恢复。
    const held = this._externalRecordingHeld;
    this._externalRecordingHeld = false;
    AudioManager.setAudioSessionActivity(false)
      .catch(() => {})
      .then(() => {
        if (held) endExternalRecording();
      });
  }

  private _teardown(): void {
    if (this._doneTimer) {
      clearTimeout(this._doneTimer);
      this._doneTimer = null;
    }
    this._stopCapture();
    const ws = this._ws;
    this._ws = null;
    this._wsReady = false;
    this._pendingBeforeReady = [];
    if (ws) {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        if (ws.readyState === 0 /* CONNECTING */ || ws.readyState === 1 /* OPEN */) ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}
