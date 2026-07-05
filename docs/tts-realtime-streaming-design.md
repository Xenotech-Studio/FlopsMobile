# Flops Mobile — 实时流式 TTS（LLM 边回复边朗读）设计文档

> 目标：与 Web/Desktop 同体验——语音开关打开后，进对话即连 `/api/ws/audio`，assistant 流式生成时
> 边合成边朗读；离开对话页（ChatScreen 卸载）不断流；后台/锁屏继续朗读。仅 iOS。
> 约束：**WS 与 PCM 播放全在原生**（FlopsAudioModule.swift），JS 只做开关/订阅/报活跃对话。

## 0. 取证结论（决定设计）

**后端 `/api/ws/audio`（不改服务端）**
- URL：`wss://<host>/api/ws/audio?conversation_id=<cid>&access_token=<token>`（query 鉴权，同 ASR）。
- 连上即收 `{"type":"ready","sample_rate":24000,"format":"pcm","channels":1}`。
- 帧：`speak_start{run_id,sample_rate}` → 二进制 **裸 s16le PCM 24kHz mono（无帧头、明文）** ×N → `speak_end{run_id}` → 稍后 `audio_saved{run_id,audio{segments,encrypted,...}}`。
- 纯订阅端点，客户端不上行；多订阅者共享同一流；实时 PCM **不加密**（加密只在落库 mp3）。

**Web/Desktop 语义（要对齐）**
- 开关：layout-preferences 键 **`tts_autoplay`**（bool，默认 false，跨端同步）。`GET/POST /api/user/layout-preferences`。
- 连接时机：`tts_autoplay && conversationId && token`；切对话 → 断旧连新；关开关/卸载 → 断。
- PCM 播放：Int16LE → Float32(`/0x8000`) → 单声道 buffer → 排到播放时间线无缝衔接（首帧 buffer ~50ms 防欠载）；奇数字节 carry 到下一帧。
- `speak_start`：run_id 变了就**停掉旧 run 的音源**（改口/抢占）；`speak_end`：不处理（让已排队的尾音自然播完）；`audio_saved`：把 audio 注入对应消息 → 点亮回放按钮。

**Mobile 关键差异**：ChatScreen 每对话独立、离开即卸载。Web 用 `useEffect([ttsAutoplay,convId,token])` 且卸载即断——但用户要求 **Mobile 卸载不断流**。故实时会话**必须 app 级持有**（原生 WS 天然进程级；JS 侧控制器也 app 级，不随 ChatScreen 生死）。

## 1. 架构

```
App.tsx (session 内)
  └─ <TtsRealtimeController/>  ← app 级：启动读 tts_autoplay，session 变化时刷新
                                  只调 ttsRealtime.setEnabled(...)，自身不渲染 UI

ChatScreen (可卸载)
  └─ useFocusEffect → ttsRealtime.setActiveConversation(convId, session)
     （卸载不清除：单例保留 convId，原生 WS 继续 → 不断流）

UsageSettingsScreen
  └─ tts_autoplay 开关 → setLayoutPreferences({tts_autoplay}) + ttsRealtime.setEnabled(next)

┌─ src/audio/ttsRealtime.ts (app 级单例) ─────────────────────┐
│ 状态 { enabled, convId, session }                            │
│ setEnabled / setActiveConversation / refreshFromPrefs        │
│ reconcile(): enabled&&convId&&session ? 连(变了就重连) : 断  │
│ 只调原生 Native.startRealtime(wsUrl) / stopRealtime()        │
│ 订阅原生事件 → useTtsRealtime() 暴露 {connected, speaking}   │
└──────────────┬───────────────────────▲──────────────────────┘
   startRealtime(wsUrl)                 │ onRealtimeState 事件
               ▼                        │
┌─ FlopsAudioModule.swift（同一 RCTEventEmitter，新增实时子系统）─┐
│ URLSessionWebSocketTask 连 /api/ws/audio（原生持有 WS）          │
│ 解析 ready/speak_start/PCM/speak_end/audio_saved                 │
│ AVAudioEngine + AVAudioPlayerNode：Int16LE→Float32→scheduleBuffer│
│   （scheduleBuffer 天然无缝排队，无需手动 playhead）             │
│ 换 run_id → node.stop() 冲掉旧排队(改口)；speak_end 不清         │
│ 共用既有 AVAudioSession .playback + audio 后台模式 → 后台/锁屏播 │
│ 断线自动重连（有界退避，enabled 时）                            │
│ 与回放 AVQueuePlayer 互斥：实时 speak_start 暂停回放；回放起停实时│
└──────────────────────────────────────────────────────────────┘
```

## 2. 原生新增（FlopsAudioModule.swift，同类内）

**导出方法**
- `startRealtime(wsUrl: String)` → Promise：若已连同 URL 则忽略；不同则重连。配置 session、起 engine、连 WS。
- `stopRealtime()` → Promise：关 WS、停 node、（回放不在则）释放 session。

**PCM 播放**
- `AVAudioEngine`，`AVAudioPlayerNode` → mainMixer；播放格式 **Float32 24kHz mono**（引擎原生偏好，避免 Int16 接口转换坑）。
- 收二进制帧：`Data` → Int16LE 数组（处理奇数字节 carry）→ `Float32 = i16/32768` → `AVAudioPCMBuffer` → `playerNode.scheduleBuffer(buf)`（顺序无缝播）。
- `speak_start`：若 `run_id != currentRunId` → `playerNode.stop()`（冲掉未播队列）+ `play()`（改口打断）；记 currentRunId。
- `speak_end`：不动（尾音自然播完）。
- `ready`：确认 24kHz；起 engine/node。

**事件（supportedEvents 增补）**
- `onRealtimeState` `{ state:'connecting'|'open'|'ready'|'speaking'|'ended'|'closed'|'error', runId?, error? }`
- `onAudioSaved` `{ runId, audio }`（转发给 JS，未来可即时点亮回放按钮；MVP 先透传）

**WS**：`URLSessionWebSocketTask`；递归 `receive`；`.string` 走 JSON 帧、`.data` 走 PCM。断线且仍 enabled → 退避重连（1s/2s/5s，上限几次）。

**互斥/中断**：实时 `speak_start` 时 `player?.pause()`（回放）；`loadAndPlay`(回放) 时停实时 node。既有 interruption/route 监听扩展到 engine（.began 暂停 engine，.ended 恢复）。

## 3. JS 新增

**`src/audio/ttsRealtime.ts`（app 级单例）**
- 内部状态 `{ enabled, convId, session }` + `connectedUrl`。
- `setEnabled(b)` / `setActiveConversation(convId, session)` / `refreshFromPrefs(session)`（拉 `tts_autoplay`）→ 都触发 `reconcile()`。
- `reconcile()`：`enabled && convId && session` → 构造 `wsUrl=buildAudioWsUrl(base,token,convId)` → 若与 `connectedUrl` 不同则 `Native.startRealtime(wsUrl)`；否则 `Native.stopRealtime()`。
- `buildAudioWsUrl`：仿 `voiceDictationMobile.buildAsrUrl`，`https→wss`，`/api/ws/audio?conversation_id=..&access_token=..`。
- `useTtsRealtime()`：订阅 `onRealtimeState` → `{connected, speaking, runId}`（供 UI 显示"正在朗读"指示，可选）。
- iOS-only；Android/无原生模块 → 全 no-op。

**`src/components/TtsRealtimeController.tsx`**：mount 于 App(session 内)。`useEffect([session])` → `ttsRealtime.refreshFromPrefs(session)`。不渲染 UI。

**ChatScreen**：`useFocusEffect(useCallback(() => { ttsRealtime.setActiveConversation(conversationIdRef.current, session); }, [session]))`；**blur/卸载不清除**（保证不断流）。conversationId 变化的 effect 里也同步一次。

**UsageSettingsScreen**：加 `tts_autoplay` 开关，沿用 `show_token_usage_in_chat` 范式（乐观 + `setLayoutPreferences({tts_autoplay})`），并 `ttsRealtime.setEnabled(next)`。

## 4. 生命周期矩阵

| 事件 | 行为 |
|---|---|
| App 启动(已登录) | 读 tts_autoplay；true 则等 setActiveConversation 后连 |
| 开关 ON + 在对话 X | 连 X 的 WS，边生边朗读 |
| assistant 流式 | speak_start→PCM 无缝播→speak_end |
| LLM 改口(run_id 变) | 停旧队列、播新 run |
| 离开 ChatScreen 到 Today | **不断流**（单例保留 X，WS 续，尾音/后续照播） |
| 切到对话 Y | setActiveConversation(Y) → 断 X 连 Y |
| 锁屏/切 App | 后台模式 + .playback → 继续朗读 |
| 开关 OFF | stopRealtime，断 WS 停 engine |
| 登出 | controller 见 session=null → setEnabled(false)/断 |

## 5. 不在本次范围
- `audio_saved` 即时点亮回放按钮（需 run_id→消息映射；现状是回放按钮随历史刷新出现）。MVP 只透传事件。
- Android。
- 实时流的锁屏 scrub/进度（live 流无进度语义）；仅设最简 nowPlaying 标题。

## 6. 验证
- 开关 ON → 进对话发消息 → 边回复边出声；改口不叠音；离开对话页声音不断；锁屏继续；切对话切流；关开关即停。
- 回归：回放按钮(mp3)、ASR 听写、既有后台/锁屏均不受影响。
</content>
