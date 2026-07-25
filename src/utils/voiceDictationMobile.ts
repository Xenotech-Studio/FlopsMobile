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
import { AudioManager, AudioRecorder } from 'react-native-audio-api';

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_BYTES = 6400; // 200ms @ 16k/16bit/mono
const CALLBACK_BUFFER_LENGTH = 1600; // ~100ms @ 16k，单声道

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
  /** iOS：用户长按 mic 选的麦克风源。auto=按连接自动、builtin=iPhone 内置麦、headset=耳机麦。 */
  preferredMicSource?: 'auto' | 'builtin' | 'headset';
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

/** https://host/ → wss://host/api/ws/asr?access_token=... */
function buildAsrUrl(serverBaseUrl: string, token: string): string {
  const trimmed = (serverBaseUrl || '').replace(/\/+$/, '');
  const ws = trimmed.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return `${ws}/api/ws/asr?access_token=${encodeURIComponent(token)}`;
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
  private readonly preferredMicSource: 'auto' | 'builtin' | 'headset';

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

  constructor(opts: VoiceDictationOptions) {
    this.serverBaseUrl = opts.serverBaseUrl;
    this.token = opts.token || '';
    this.onResult = opts.onResult || (() => {});
    this.onDone = opts.onDone || (() => {});
    this.onError = opts.onError || (() => {});
    this.onNotice = opts.onNotice || (() => {});
    this.onAmplitude = opts.onAmplitude || null;
    this.preferredMicSource = opts.preferredMicSource || 'auto';
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
      // 按用户长按 mic 选的源动态配 options：headset → HFP（耳机麦）、builtin/auto → A2DP 分离（iPhone 内置麦+蓝牙高音质）
      const wantHeadsetMic = this.preferredMicSource === 'headset';
      console.log('[dictation] wantHeadsetMic=', wantHeadsetMic);
      const iosOpts = (wantHeadsetMic
        ? ['allowBluetoothHFP']
        : ['allowBluetoothA2DP', 'defaultToSpeaker']) as any;
      // 先强制 deactivate 一次：react-native-audio-api 内部有 isActive 缓存，为 true 时
      // setAudioSessionActivity(true) 直接 early-return、跳过 configureAudioSession；而 TTS
      // （FlopsAudio）是绕过该库直接把共享 session 改成 .playback 的——缓存变脏（上次
      // deactivate 失败即残留 true）时 category 配不回 playAndRecord，录音全程静音。
      // deactivate 把缓存归位，保证下面 activate 必然重配 category/options。
      await AudioManager.setAudioSessionActivity(false).catch(() => {});
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
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
      if (wantHeadsetMic) {
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
    const ws = new WebSocket(buildAsrUrl(this.serverBaseUrl, this.token));
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
    if (msg.type === 'error') {
      this._fail(`识别服务错误：${msg.message || msg.code || '未知'}`);
    }
  }

  private _startRecorder(): void {
    const recorder = new AudioRecorder();
    this._recorder = recorder;
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
    AudioManager.setAudioSessionActivity(false).catch(() => {});
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
