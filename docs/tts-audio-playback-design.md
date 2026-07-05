# Flops Mobile — TTS 语音播放（Phase 0 前台 + Phase 1 后台/锁屏）设计文档

> 状态：设计已定，随本次实现落地。仅 iOS。Android 全部 no-op。
> 目标：点消息 → 播放该 assistant 回复的 TTS 音频（服务端已合成好的 mp3 URL）；
> 切页 / 切 App / 锁屏后继续播放；锁屏 & 控制中心显示标题/进度并可暂停/切段。

## 0. 关键取证结论（决定所有选型）

1. **`react-native-audio-api` 不适合做 TTS 播放**：只有 `AudioContext.decodeAudioData(ArrayBuffer)`（Web Audio 风格，纯 JS 解码），
   - 不支持 URL、不支持 mp3、无 pause/进度/后台/锁屏；后台时 JS 图必被挂起。
   - 但它**独占管理 `AVAudioSession`**（ASR 录音时 `AudioManager.setAudioSessionOptions({iosCategory:'playAndRecord'})` + `setAudioSessionActivity(true/false)`）。
   - → **TTS 播放走独立原生 Swift 模块（AVQueuePlayer）**；与 rn-audio-api 共用同一个 `AVAudioSession.sharedInstance()` 单例，靠"谁最后 setCategory 谁生效 + 录音/播放互斥"协调，MVP 可接受。

2. **数据来源**：assistant 消息 `metadata.audio = { format:'mp3', sample_rate, segments: string[](完整 COS 公网 URL), encrypted: bool }`
   （后端 `tts_system/audio_persist.py` → `hybrid_store.attach_message_audio` 幂等写全量 segments）。
   - `encrypted=false`：URL 是明文 mp3，**直接 GET 可播**（COS 自带鉴权，无需 token）。
   - `encrypted=true`：URL 是 `.mp3.enc`（AES-GCM，nonce||ct||tag），需客户端下载 → 用本地 `K_conv` 解密 → 得明文 mp3 再播。

3. **客户端消息模型丢了 metadata**：`chatLocalMessages.coalesceAssistantTurn()` 把服务端 `ConversationMessage` 合并成 `ChatMessage{role,content,blocks}`，
   **没带 `metadata.audio`**。→ 必须在 coalesce 时把 audio 透传到 `ChatMessage`。

4. **RN 新架构已开**（`RCTNewArchEnabled=true`），但老式 `RCT_EXTERN_MODULE` 桥仍可用（`FlopsPushModule`/`FlopsCrypto` 都是老式）。新模块沿用老式，最低风险。

5. **原生框架**：Swift `import AVFoundation/MediaPlayer` 在 `use_frameworks!` 下自动链接系统框架，无需改 Frameworks build phase；仅需把新 `.swift/.m` 加入 target 的 Compile Sources（手改 pbxproj，镜像 `FlopsPushModule` 的静态 ID 方案）。

## 1. 架构总览

```
┌─ ChatScreen (可随时卸载) ─────────────────────────────┐
│  renderMessage → MarkdownContent(showPlayButton, isPlaying, onPlay) │
│         │ onPlay(segments, meta)          ▲ useTtsPlayback() 订阅状态 │
└─────────┼───────────────────────────────────┼─────────────────────┘
          ▼                                   │
   ┌─ src/audio/ttsPlayer.ts (app 级单例, 独立于任何页面) ─┐
   │  playSegments / pause / resume / stop / toggle       │
   │  订阅原生事件 → 维护 { activeKey, state, index }      │
   └─────────┬───────────────────────▲───────────────────┘
   NativeModules.FlopsAudio           │ NativeEventEmitter(onState/onProgress)
             ▼                        │
   ┌─ ios FlopsAudioModule.swift (RCTEventEmitter) ──────┐
   │  AVQueuePlayer(items from URLs) + currentIndex       │
   │  AVAudioSession .playback + setActive                │  ← Phase 1
   │  MPNowPlayingInfoCenter + MPRemoteCommandCenter      │  ← Phase 1
   │  interruption / routeChange 监听                     │  ← Phase 1
   └─────────────────────────────────────────────────────┘
```

**单例性**：播放引擎的"真身"是原生 `AVQueuePlayer`（进程级），JS 侧 `ttsPlayer.ts` 是它的**模块级单例包装**（`import` 即唯一实例）。二者都**不绑定** ChatScreen 生命周期 —— 这是"离开对话页仍继续播"的地基。

## 2. 原生模块接口 `FlopsAudio`（Swift `@objc(FlopsAudio)` : `RCTEventEmitter`）

方法（`.m` 用 `RCT_EXTERN_METHOD`，均 Promise）：

| 方法 | 签名 | 说明 |
|---|---|---|
| `loadAndPlay` | `(segments: [String], meta: {title, subtitle, key})` | 用 URL 数组建 AVPlayerItem 队列，配置 session/nowplaying/commands，从头播 |
| `play` | `()` | 恢复 |
| `pause` | `()` | 暂停 |
| `stop` | `()` | 停止 + 清队列 + 释放 session(`.notifyOthersOnDeactivation`) + 清 nowplaying |
| `playIndexFromCurrent` | `(index)` | 跳到第 index 段（重建队列，供 prev/next/锁屏切段） |
| `getState` | `()` → 当前快照 | JS 侧初次挂载对齐 |

事件（`supportedEvents`）：
- `onAudioState` `{ state:'idle'|'loading'|'playing'|'paused'|'ended'|'error', key, index, count, error? }`
- `onAudioProgress` `{ key, index, position, duration }`（周期 time observer, ~0.5s 节流）

`key`：一条消息的稳定标识（ChatScreen 的 `stableKey`），用于 UI 判定"当前在播的是不是这条消息"。

## 3. Phase 0 — 前台能播（改动清单）

**新增**
- `ios/FlopsMobile/FlopsAudioModule.swift`：AVQueuePlayer 播放核心（Phase 0 只需 session `.playback`+play/pause/stop+队列+事件；nowplaying/commands 在 Phase 1 同文件补）。
- `ios/FlopsMobile/FlopsAudioModule.m`：`RCT_EXTERN_MODULE(FlopsAudio, RCTEventEmitter)` 桥。
- `src/audio/ttsPlayer.ts`：JS 单例包装 + `useTtsPlayback()` hook（iOS-only，Android no-op）。

**修改**
- `ios/FlopsMobile.xcodeproj/project.pbxproj`：把两新文件加入 target（镜像 FlopsPushModule 的 4 处：PBXBuildFile / PBXFileReference / group children / Sources phase）。
- `src/utils/chatLocalMessages.ts`：`ChatMessage` assistant 变体加 `audio?: MessageAudio`；`coalesceAssistantTurn` 合并 turn 内所有 assistant 消息的 `metadata.audio.segments`（去重保序）挂上去。
- `src/components/MarkdownContent.tsx`：加 `showPlayButton/isPlaying/onPlay` props + 工具栏播放/暂停按钮 + memo 比较键。
- `src/screens/ChatScreen.tsx`：`useTtsPlayback()`；在最后一个 text block（及 tool-only 分支）根据 `msg.audio?.segments` 给 MarkdownContent 传 play 相关 props；onPlay 做 toggle。

**加密对话（`encrypted=true`）**：**已支持**，与 Web/Desktop MessageAudioButton 语义一致。
`ttsPlayer.playSegments` 在 `encrypted` 时走 `prepareEncryptedSegments`：逐段用 `react-native-blob-util` 内存下载 `.mp3.enc` → `srp.aesGcmDecrypt`（原生 FlopsCrypto，forge 兜底）用 `getCachedKConv(convId)` 解密 → 写 `CacheDir/flops-tts-<hash>.mp3`（存在则复用）→ 交原生播 `file://`。原生 `loadAndPlay` 对 https/file 无差别。

## 4. Phase 1 — 后台 / 锁屏（改动清单，同一原生文件内叠加）

- `ios/FlopsMobile/Info.plist`：加
  ```xml
  <key>UIBackgroundModes</key><array><string>audio</string></array>
  ```
- `FlopsAudioModule.swift`：
  - `configureSession()`：`setCategory(.playback, mode: .spokenAudio)` + `setActive(true)`；`stop()` 时 `setActive(false, .notifyOthersOnDeactivation)`。
  - `MPNowPlayingInfoCenter`：title/subtitle/duration/elapsed/rate，随 state & progress 更新。
  - `MPRemoteCommandCenter`：play/pause/togglePlayPause/next/previous → 映射到播放控制。
  - `AVAudioSession.interruptionNotification`：`.began`→pause；`.ended` 且 `.shouldResume`→play。
  - `AVAudioSession.routeChangeNotification`：`.oldDeviceUnavailable`（拔耳机）→pause。
- ATS：COS 为 https，`Info.plist` 现有 NSAppTransportSecurity 不需改。

熄屏继续播报：`.playback` session + `audio` 后台模式 + AVQueuePlayer 原生续播即覆盖（不依赖灵动岛）。

## 5. 验证

- 构建：`yarn dev ios`（真机/模拟器）。
- Phase 0：打开一条有 TTS 音频的 assistant 消息 → 出现播放按钮 → 点击播放/暂停；多 segment 顺序连播。
- Phase 1：播放中锁屏 → 声音继续；锁屏出现"正在播放"卡片可暂停/切段；切到别的 App 继续播；来电打断后自动恢复。
- 回归：ASR 语音听写仍正常（录音时 session 切 playAndRecord，与播放互斥）。

## 6. 明确不在本次范围

- Android 播放（全 no-op）。
- 流式/实时 TTS（走 `/api/ws/audio` PCM 流）——Phase 0 只播已落库 mp3。
- 灵动岛 Live Activity（Phase 2）。
- 远程唤醒被 kill 的 App（PushKit/CallKit，Phase 2+）。
</content>
