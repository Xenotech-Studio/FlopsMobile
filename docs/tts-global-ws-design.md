# TTS 全局 WS + 多端优先级路由 — 设计（不写代码）

> 目标：同一用户在 Mobile / Desktop / Web 多端在线时，**同一时刻只有一个渠道类型收到语音**，
> 按固定优先级裁决。核心是把「调度/合成」与「扇出到哪条 WS」**拆开**，新增一个**优先级裁决路由层**。
> 决策已定：① 成本闸门用兴趣集（客户端上报要听哪些对话）；② Desktop 上报开着的 tab、但只播聚焦 panel；
> ③ 全局端点 `/api/ws/audio/global`。**本文只做设计。**

## 1. 优先级模型（同一用户，自上而下，命中即独占）

| 级 | 渠道类型 | 触发条件 | 收到什么 | 同时其它端 |
|---|---|---|---|---|
| **P1** | `mobile-broadcast` | Mobile 开了"播报模式" | 该用户**全部对话**的语音（调度后） | Desktop/Web 连着也**不发** |
| **P2** | `mobile-single` | Mobile 未开播报、在某对话页内且 tts_autoplay 开 | **当前这一个对话**的语音 | Desktop/Web 连着也**不发** |
| **P3** | `desktop-global` | Mobile 既非 P1 也非 P2（在列表页/文档页/后台/未连） | 语音（限 openTabIds 内的对话） | Web 连着也**不发** |
| **P4** | `web-perconv` | 只有 Web 在线 | 各 tab 订阅对话的语音 | — |

**裁决是"每用户全局"的**：Mobile 一旦在场（P1/P2），Desktop 与 Web 整体静音，而不是按对话细分。

> ⚠️ **必须确认的后果**：P2 下 Mobile 只听当前对话 X。若此刻 Desktop 打开的对话 Y 在生成，按规则 Desktop 不发、Mobile 也不要 Y → **Y 在所有端都听不到**（不合成、不推送）。这是严格优先级的直接结果，请确认是预期行为。

## 2. 渠道识别：后端怎么知道这条 WS 是哪种

识别 = **端点 + `client` 查询参数 + 上行注册消息**：

| 渠道类型 | 端点 | 识别依据 | interest（要听的对话） |
|---|---|---|---|
| web-perconv | `/api/ws/audio?conversation_id=X` | 无 `client` 参数（默认 web） | `{X}`（来自 query） |
| mobile-single | `/api/ws/audio?conversation_id=X&client=mobile` | `client=mobile` | `{X}` |
| mobile-broadcast | `/api/ws/audio/global` | 上行 `{type:"register",client:"mobile",mode:"broadcast"}` | `ALL` |
| desktop-global | `/api/ws/audio/global` | 上行 `{type:"register",client:"desktop"}` + `{type:"interest",conversation_ids:[...]}` | `openTabIds`（动态上报） |

要点：
- **Web 零改动**：不带 `client` 的 per-conv 连接一律判为 `web-perconv`，interest=query 里的 conversation_id。
- **mobile-single 走 per-conv 端点**（贴合"和 Web 一样走 per-conv"），仅多一个 `client=mobile` 参数把优先级抬到 P2。per-conv 端点因此只需新增读一个可选 query 参数，不需要上行解析。
- **global 端点是双向的**：其 `reader()` 要解析上行 `register` / `interest` 消息（decision B 的兴趣集就走这里）。mobile-broadcast 的 interest 恒为 ALL、无需持续上报；desktop 随开关 tab 上报 openTabIds。

## 3. 架构拆分：调度/合成 ↔ 扇出路由（本设计的核心）

```
                 ┌───────────────── 不变：调度 + 合成 ─────────────────┐
 LLM run tokens →│ RunTtsSynthesizer 切句 → UserSpeechScheduler 串行档 │
                 │  → 火山合成 → 产出 speak_start / PCM / speak_end     │
                 └───────────────┬────────────────────────────────────┘
                                 │ hub.publish(user, conv, frame)
                 ┌───────────────▼──────────── 新增：DecisionRouter ───┐
                 │ 按 user 现有渠道集裁出"获胜渠道类型 + 有效 interest" │
                 │ 只把 frame 投递给获胜类型中 interest 命中 conv 的队列 │
                 └───────────────┬────────────────────────────────────┘
                     每连接一个 asyncio.Queue（pump 只负责 drain→socket，dumb）
```

- **调度/合成不变**：切句、`UserSpeechScheduler` 每用户串行档、burst 机制原样。
- **变的只有两处谓词**：
  1. **"某对话此刻算不算被订阅"**：`has_subscribers(user, conv)` → `is_delivered(user, conv)`（见 §4），供合成闸门用（`audio_broker.py:239` 起、`:324` 中途复查）。
  2. **`publish` 的投递目标**：从"该 (user,conv) 的所有订阅者"→"获胜渠道类型里 interest 命中 conv 的连接"。

## 4. DecisionRouter：裁决与投递

后端按 user 维护渠道注册表：
```
Channel { queue, ctype: 1..4(=优先级), interest: Set[cid] | ALL }
_channels: Dict[user_id, Set[Channel]]
```
裁决（纯函数，O(渠道数)）：
```
winning_ctype(user)      = 该 user 现有渠道里最小的 ctype（1>2>3>4）；无渠道 → None
effective_interest(user) = 获胜类型各渠道 interest 的并集（broadcast=ALL）
is_delivered(user, conv) = winning 存在 且 (effective_interest==ALL 或 conv∈effective_interest)
deliver(user, conv, frame):
    for ch in 获胜类型的渠道:
        if ch.interest==ALL or conv in ch.interest: ch.queue.put(frame)  # 慢队列丢最旧帧不变
```
- `is_delivered` **同时驱动**合成闸门与投递 → 不会"合成一堆没人收"。
- 渠道集变化（连/断/interest 更新/播报开关）→ 下一次 `publish` 自然用新裁决；**无需断开任何 WS**（回答"Desktop WS 不用断，只是不投递"）。
- 获胜类型中途变化（如播报模式刚开）：正在合成的 burst 在 `:324` 复查 `is_delivered`，命中就续投给新赢家、不命中就收尾。

## 5. 与合成闸门 `has_subscribers` 的关系

- 现状：`has_subscribers(user,conv)` 决定"要不要连火山合成本对话"。
- 改为 `is_delivered(user,conv)`（优先级感知）。语义：**只有当本对话会被当前获胜渠道收到时，才合成**。
- 效果：
  - P1 播报：`effective_interest=ALL` → 用户任意对话一生成就合成（导航式，符合预期成本）。
  - P2 单对话：只合成 Mobile 当前那个 X（Desktop/Web 想听的一律不合成——因为它们被静音）。
  - P3 Desktop：只合成 openTabIds 内、且此刻 Mobile 不在场时的对话。
  - P4 Web：只合成各 tab 订阅的对话（≈现状）。
- 合成的"排队/串行档/切句"机制**完全不动**，动的只是这一个布尔谓词。

## 6. Mobile 双模式（单条 WS，按模式切端点）

两模式**互斥**，任一时刻**最多一条 WS**：
```
reconcile():
  if broadcastMode:                          # P1
      → 连 /api/ws/audio/global，register{client:mobile,mode:broadcast}
  elif activeConvId 且 tts_autoplay:          # P2
      → 连 /api/ws/audio?conversation_id=activeConvId&client=mobile
  else:                                       # 不连
      → 断开
  # 切换模式/对话 = 断旧连新（URL 变即重连；同 URL 幂等）
```
- **播报模式开关**：新开关，独立于 tts_autoplay。
  - 存储：建议 layout-preferences 键 **`tts_broadcast_mode`**（bool，跨会话记忆）。**语义上是 Mobile 专属**（Web/Desktop 忽略该键）；**后端不读这个 pref**——后端只从"这条 global WS 的 register 消息"得知播报模式。pref 只是客户端记住开关状态、下次启动自动重连。
  - 交互：`broadcastMode` 优先于 tts_autoplay（开了播报，即使进对话也走播报、不走单对话订阅）。是否要求 tts_autoplay 也开才允许播报？→ **待确认**（建议：播报模式独立生效，不依赖 tts_autoplay）。
- 播报模式下**离开对话页/锁屏/后台**都继续（已有 audio 后台模式 + 原生进程级 WS 支撑）——正是"导航软件"体验。
- 原生出声：global 流帧带 conversation_id；播报模式 interest=ALL 全播；单对话模式其实只会收到该 conv，直接播。

## 7. Desktop（全局单例 WS + openTabIds 上报 + 只播聚焦）

- 一条 `/api/ws/audio/global`，`register{client:desktop}` + 随 tab 开关上报 `interest=openTabIds`。
- 一个共享 AudioContext + 单 playhead（每用户 burst 串行，本就不会叠）。
- **出声过滤（decision ②）**：后端按 openTabIds 投递（这样各 tab 的 `audio_saved` 都到、回放按钮即时亮）；**客户端只播 `conversation_id == 聚焦 panel` 的 PCM**，其余丢弃。
  - 取舍已定：上报 openTabIds、只播聚焦。好处：非聚焦 tab 的回放按钮也即时点亮；坏处：会合成 openTabIds 内正在生成的对话（这些是用户开着的 tab，成本可接受）。
- panel 不再各自建 subscriber；由 ChatTab/context 持有单例，用 `{ttsAutoplay, session, openTabIds, focusedConvId}` 驱动。

## 8. Web —— 不变
继续 `/api/ws/audio?conversation_id=X`，每 tab 一条。P1/P2/P3 在场时被 DecisionRouter 静音（连接不断、只是不投递）。控制帧多出的 `conversation_id` 字段被忽略。

## 9. 帧 / 上行协议
```
下行（两端点通用；global 版控制帧多 conversation_id）:
  {"type":"ready",...}
  {"type":"speak_start","conversation_id":cid,"run_id":rid,"sample_rate":sr}
  <二进制 s16le PCM>        # 归属"最近 speak_start 的 conversation_id"（每用户 burst 串行保证不交错）
  {"type":"speak_end","conversation_id":cid,"run_id":rid}
  {"type":"audio_saved","conversation_id":cid,"run_id":rid,"audio":{...}}

上行（仅 global 端点）:
  {"type":"register","client":"mobile"|"desktop","mode":"broadcast"?}
  {"type":"interest","conversation_ids":[...]}     # desktop 随开关 tab 更新；mobile-broadcast 无需
```

## 10. 路由层放哪
- **DecisionRouter 放 AudioHub 内**（扇出的归属地）：它掌握 per-user 渠道集与 interest，`publish`/`is_delivered` 都在这里裁决。
- **pump（tts.py 每连接）保持 dumb**：只 `queue.get()`→`send`。唯一新增：global 端点 pump 给控制帧补 conversation_id、`reader()` 解析 register/interest。
- 好处：裁决集中一处、可单测；连接层不含业务优先级。

## 11. 改动量评估

| 模块 | 改动 | 量 |
|---|---|---|
| `audio_broker.py` AudioHub | 渠道注册表（ctype+interest）、DecisionRouter、`publish` 改投递、`has_subscribers`→`is_delivered` | **中**（核心，但集中一处） |
| `audio_broker.py` 合成闸门 | `:239`/`:324` 换谓词 | 小 |
| `routers/tts.py` | per-conv 端点读 `client` 参数；新增 `/api/ws/audio/global`（accept/ready/pump/reader 解析 register+interest/注销） | **中** |
| `AudioFrame` | 无需加字段（conversation_id 由 publish 形参带入 global 队列项） | 极小 |
| Mobile `ttsRealtime` + 原生 | reconcile 按模式切端点、播报模式开关、原生按 conversation_id 出声 | **中** |
| Mobile 设置 UI | 新增"播报模式"开关（layout-preferences `tts_broadcast_mode`） | 小 |
| Desktop | per-panel subscriber → 全局单例 + openTabIds 上报 + 只播聚焦 | **中** |
| Web | 不动 | 0 |
| 现有 `/api/ws/audio?conversation_id=`（Web） | 行为不变（仅多认一个可选 `client` 参数） | 极小 |

## 12. 待你拍板
1. **§1 的后果**：P2 下 Desktop 正在生成的对话 Y 会全端静音——确认这是预期？
2. **§6**：播报模式是否独立于 tts_autoplay（建议独立）？
3. 播报模式开关存 **layout-preferences `tts_broadcast_mode`**（跨会话记忆、Mobile 专属语义）可否？
4. mobile-single 用 **per-conv 端点 + `client=mobile` 参数**识别（而非也走 global）——确认。
