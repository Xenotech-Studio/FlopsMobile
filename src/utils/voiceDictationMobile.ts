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

export class VoiceDictationSession {
  state: SessionState = 'idle';
  lastText = '';

  private readonly serverBaseUrl: string;
  private readonly token: string;
  private readonly onResult: (text: string, last: boolean) => void;
  private readonly onDone: (text: string) => void;
  private readonly onError: (message: string) => void;

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
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'starting';
    // 每次会话独立攒一份 PCM 用于回放/落库
    this._pcmChunks = [];
    this._pcmTotalBytes = 0;

    // 麦克风权限 + 音频会话
    try {
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'default',
        iosOptions: ['allowBluetoothHFP', 'defaultToSpeaker'],
      });
      const status = await AudioManager.requestRecordingPermissions();
      if (status !== 'Granted') {
        this._teardown();
        this.state = 'closed';
        this.onError('麦克风权限被拒绝');
        return;
      }
      await AudioManager.setAudioSessionActivity(true);
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
