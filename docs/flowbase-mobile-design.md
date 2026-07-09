# FlopsMobile FlowBase 原生渲染设计方案

状态：v3（P0 已落地）· 作者：PM · 日期：2026-07-08
变更（v2）：自定义 App 确认走沙箱 WebView（与 Web/Desktop 一致）；建 Base/改 schema 纳入移动端能力；仪表盘/视图编辑纳入但后置；实时同步待专项调研（留 TODO）。
变更（v3）：**后端架构已变** —— FlowBase 从 Flops 迁到 **flowdoc-server**，API `/api/flowbase/*` → **`/api/base/*`**（Flops server.py 已反代 `/api/base/*` + `/api/base/ws/{table_id}`，mobile 用 `${server_base_url}api/base/*` + 普通 Bearer 直连）。**实时协作已上线**：WS `/api/base/ws/{table_id}`（`?access_token=` 鉴权）、presence 广播、行级 `version` CAS（更新带 `base_version`，冲突回 409 `{error:"version_conflict", current_version, current_data}`）、change feed（`seq` 增量/`sync_since` 追帧）。**P0 已实现**（见文末「P0 实现落地」）。
目标读者：FlopsMobile 前端、FlowBase 后端、设计

---

## 0. TL;DR（给赶时间的人）

- **入口已经现成**：FlowBase 在数据模型里就是 FlowDoc 树上的一个 `flowbase` 节点（只存一个 `base_id` 指针），而 FlopsMobile 已经有一套成熟的原生 FlowDoc 块渲染器（`FlowDocBlocks.tsx` 的 `switch(block.type)`）。所以"接入 FlowBase"= **在文档里加一个 `flowbase` 块渲染成入口卡片 + 一个独立全屏 `FlowBaseScreen`**。不需要重写文档体系。
- **后端已经完全就绪**：`/api/flowbase/*` 是一套干净的纯 REST API（Base/Table/View/Row/Dashboard/App 全 CRUD，行查询支持服务端筛选/排序/分组/聚合），移动端只要写一个 REST client，**不碰 Yjs、不碰实时 CRDT**。
- **四类视图全原生**：表格、看板、日历、仪表盘都用现有原生基建（`react-native-svg` / `reanimated` / `gesture-handler` / `@gorhom/bottom-sheet` / `FlatList`）渲染，不用 WebView。
- **自定义 App 走沙箱 WebView**：它在 Web/Desktop 上本就是 Agent 生成的 HTML+CSS+JS 跑在沙箱 iframe 里。移动端**用受控 WebView + 原生 bridge 复刻 `FlowBaseSDK`**，与 Web 端行为一致——这里的"WebView"不违背"不要 WebView"原则（该原则针对的是**表格/仪表盘这类结构化内容不该用 WebView 糊弄**，而 App 本身就是任意网页）。详见 §6。
- **移动端也能建 Base / 改 schema / 编辑仪表盘视图**（不只是看数据），但结构编辑与仪表盘编辑后置到 P4。
- **实时同步是待定大项**：另有专项调研飞书多维表格协作方案，本方案先留 TODO（§9 R4 / §8）。
- **建议分 5 期交付**，MVP（表格只读 + 记录卡片编辑 + 日历）2~3 周可用。

---

## 1. 背景与目标

FlopsMobile 目前没有 FlowBase 支持——用户在手机上只能看 FlowDoc 文档，遇到多维表格/仪表盘就是断头路。

用户诉求：
1. 在手机上**查看**多维表格、仪表盘、自定义 App；
2. 能做基本**操作**（改单元格、加行、切视图、看图表）；
3. **原生渲染，不要 WebView**（性能、手势、观感、与 App 一致性）。

本方案给出：接入点、架构、各视图的原生渲染方案、"自定义 App"这个硬骨头的处理、以及分期计划。

---

## 2. 现状梳理（三方已摸清）

### 2.1 FlopsMobile（React Native 0.84 / React 19）

- 导航：React Navigation v7（Stack）+ `@gorhom/bottom-sheet`；响应式（iPhone 抽屉 / iPad 侧边栏，同一棵组件树）。
- 状态：纯 React Context（`SessionContext` 管 token 和 baseURL），**无 Redux/Zustand**。
- 网络：`src/api.ts`（Bearer token，baseURL 默认 `https://flops.xenotech.studio`）。
- **文档渲染体系（关键）**：`src/flowdoc-native-input/FlowDocBlocks.tsx`（~3000 行）是核心块渲染器，`switch(block.type)` 逐块映射到原生组件；已有 `paragraph / heading / code / quote / image / file_attachment / table` 等 case，**其中 `table` 就是一套 View+ScrollView 手写的原生表格**（`TableRenderer`）。文档从后端拉 Yjs 快照解码而来（`yjsToDocument.ts`）。
- 现有能力：`react-native-svg`（已用于 `TaskFlowChartView` 手画甘特图）、`reanimated` v4、`gesture-handler` v2.30、`draggable-flatlist`、`@gorhom/bottom-sheet` v5。**没有** 任何表格库/图表库。
- FlowBase 相关代码：**零**（全新增量，无历史包袱）。

### 2.2 FlowBase 后端（`backend/flowbase_system/` + `routers/flowbase.py`）

- 模型三层：**Base → Table → Row**；Base 同时挂 Dashboard、App。
- 数据存独立 SQLite（`flowbase.db`，WAL），与 FlowDoc 的 Redis/Yjs 完全解耦。
- 12 种字段类型：`text / long_text / number / checkbox / select / multi_select / date / datetime / url / email / link / formula`。行数据是**稀疏 JSON**（`{field_id: value}`），公式字段**只读、已物化**。
- 视图三种：`grid / kanban / calendar`，纯元数据（筛选/排序/分组/字段可见性），不含行数据。
- 仪表盘：一组 `metric / chart / pivot / view` 组件 + 网格布局；`/dashboards/{id}/query` 一次并行解析所有组件（10s TTL 缓存），单组件报错内联不拖垮整体。
- API 是**纯 REST**（详见 §4 附录），Bearer 鉴权，**无 WebSocket、无实时推送**（Web 端也是手动刷新）。
- 软删（30 天可恢复）、schema 改动是元数据操作、link 删除级联清空引用。

### 2.3 Web/Desktop 参考实现（`FlopsWeb/src/flops-chat-ui/components/`）

- `FlowBaseView.jsx`（~2600 行）主编排：侧栏（表/仪表盘/App/子文档）+ 数据区。
- 表格是**手写 `<table>`**（非 ag-grid），支持列拖拽/冻结/隐藏、单元格点击内联编辑；一次只拉 200 行、无虚拟化。
- 看板：拖拽卡片、按 select/text 字段分组；日历：月视图 + 每天最多 4 个卡片。
- 仪表盘：`react-grid-layout` 12 列网格；图表用 **Apache ECharts**（bar/line/pie）+ 4 种组件类型 + 4 种时间序列 transform（streak/growth_rate/running_total/cumulative_goal）。
- 自定义 App：`srcdoc` + `sandbox="allow-scripts"`（不给 same-origin）沙箱 iframe，注入 `window.FlowBaseSDK`，所有取数走 postMessage RPC 代理到 REST，**MVP 阶段只读**。
- 鉴权：`flowBaseAuth.js` 的 `setFlowBaseAuthProvider(fn)` 依赖注入，每次请求带 `Authorization: Bearer`。

**结论**：Web 端是很好的功能参照，但其表格库/`react-grid-layout`/ECharts/iframe 都是 Web-only，移动端要重做渲染层——这正是本方案的核心。

---

## 3. 核心设计决策

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| D1 | 接入点 | 复用 FlowDoc 块渲染 seam：`flowbase` 块 → 入口卡片；点开进独立全屏 `FlowBaseScreen` | Base 是 2D 全屏体验，塞进文档流里体验差；但入口天然在文档里 |
| D2 | 数据层 | 新写 **REST client**（`src/flowbase/api.ts`），复用 `SessionContext` 的 token/baseURL | 后端就是 REST，不碰 Yjs；auth 现成 |
| D3 | 状态管理 | 延续 Context + 局部 hook（`useFlowBase*`）；每个 Base 一个轻量 store | 与全 App 风格一致，不引入 Redux |
| D4 | 渲染 | **全原生**，四类视图各自映射到原生组件；**零 WebView** | 硬性要求 |
| D5 | 编辑范式 | **不做桌面式内联单元格编辑**，改为"点击行 → 底部 sheet 记录卡片编辑" | 移动端手指操作，记录卡片比 Excel 内联好用得多，且复用现有 bottom-sheet |
| D6 | 图表 | 自研轻量 **SVG 图表层**（bar/line/pie），复用 `react-native-svg` | 只需 3 种图；ECharts 无原生版；避免重依赖，延续 `TaskFlowChartView` 先例 |
| D7 | 自定义 App | **沙箱 WebView + 原生 bridge 复刻 `FlowBaseSDK`**（§6） | 与 Web/Desktop 的 iframe 方案一致；App 本就是任意网页，非结构化内容 |
| D8 | 结构编辑 | 移动端**支持**建 Base / 建表 / 改 schema / 建视图；但排到 **P4** | 用户确认要，但非 MVP 主路径，先聚焦看+改数据 |
| D9 | 仪表盘/视图编辑 | 移动端**支持**，后置到 **P4**；P3 先只读渲染 | 同上，编辑态 UI 复杂，先保证可看 |
| D10 | 实时性 | **TODO（专项调研中）**；当前先拉取 + 乐观更新 + 下拉刷新 | 飞书式协作方案单独调研后再定，见 §9 R4 |

---

## 4. 架构设计

### 4.1 模块与文件结构（新增）

```
src/flowbase/
├── api.ts                    # REST client：bases/tables/views/rows/dashboards/apps
├── types.ts                  # Base/Table/Field/View/Row/Dashboard/Component TS 类型
├── store.ts                  # 单 Base 的轻量数据 store（schema+rows+views 缓存、乐观更新）
├── hooks/
│   ├── useBase.ts            # 加载 base + tables + views
│   ├── useRows.ts            # 分页拉行、筛选/排序、乐观 patch
│   └── useDashboard.ts       # 拉 dashboard config + /query 组件结果
├── fields/
│   ├── CellRenderer.tsx      # 只读单元格：按 field.type 分发
│   ├── CellEditor.tsx        # 编辑控件：文本/数字/日期picker/select/checkbox/link picker
│   └── formatValue.ts        # 值格式化（对齐 Web：checkbox→✓、multi_select→顿号拼接…）
├── views/
│   ├── GridView.tsx          # 原生表格（虚拟化 + 冻结首列）
│   ├── KanbanView.tsx        # 看板（分组列 + 卡片，拖拽后置）
│   ├── CalendarView.tsx      # 月视图（复用 MonthCalendar 思路）
│   └── RecordSheet.tsx       # 行详情/编辑底部卡片（D5 核心）
├── dashboard/
│   ├── DashboardView.tsx     # 组件纵向堆叠（移动端不做自由网格）
│   ├── charts/{Bar,Line,Pie}.tsx   # 自研 SVG 图表
│   ├── MetricCard.tsx / PivotTable.tsx / RowsTable.tsx
│   └── transforms.ts         # streak/growth_rate/running_total/cumulative_goal（可后端已算则直接用）
├── app/
│   ├── CustomAppWebView.tsx  # §6 沙箱 WebView 运行器
│   └── flowBaseSdkBridge.ts  # 注入 window.FlowBaseSDK，postMessage ↔ 原生 REST 代理
├── schema/                   # P4 结构编辑
│   ├── FieldEditorSheet.tsx  # 建/改字段（类型、选项、公式表达式）
│   ├── TableCreateSheet.tsx  # 建表
│   └── BaseCreateSheet.tsx   # 建 Base（同时在 FlowDoc 树建 flowbase 节点）
└── FlowBaseScreen.tsx        # 全屏容器：Base/Table 切换 + 视图切换 tab + 视图区 + "+新建"入口
```

文档/导航侧改动：
- `FlowDocBlocks.tsx` 的 `switch(block.type)` 增加 `case 'flowbase'` → 渲染 `FlowBaseEntryCard`（显示 Base 名/表数量，点击 `navigation.navigate('FlowBase', { baseId })`）。
- `RootNavigator.tsx` 注册 `FlowBaseScreen`。
- **新建入口**（因结构编辑纳入移动端）：文档树"+"菜单加"新建 FlowBase"；`FlowBaseScreen` 内提供建表/建视图/改字段入口。建 Base 时后端 `POST /bases` 会顺带在 FlowDoc 树挂一个 `flowbase` 节点（`skip_flowdoc_node` 默认 false），移动端刷新文档树即可看到。

### 4.2 数据流

```
SessionContext(token, baseURL)
        │
   flowbase/api.ts ──REST──> /api/flowbase/*
        │
   store.ts / hooks（缓存 schema+views，行分页，乐观更新）
        │
   FlowBaseScreen ──选视图──> GridView / KanbanView / CalendarView / DashboardView
        │                              │
   RecordSheet(编辑) ──PATCH row──> 乐观更新 + 失败回滚
```

- **schema 先行**：进入表先拉 `/schema` 和 `/views`，再按当前 view 的 config 拉首页行。
- **分页**：`limit=100&offset=N`，`FlatList` `onEndReached` 续拉（后端单次上限 1000）。
- **乐观更新**：编辑单元格立即改本地 + 后台 PATCH，失败 toast 回滚。公式字段只读、编辑后用返回值刷新（后端会重算并回传 `data`）。

---

## 5. 各视图的原生渲染方案

### 5.1 表格视图 GridView（核心，中高难度）

- **虚拟化**：`FlatList` 渲染行（Web 端无虚拟化、200 行封顶，移动端反而要做好）。
- **冻结首列**：RN 无 `position: sticky`。方案：左侧固定一个"首列 `FlatList`" + 右侧横向 `ScrollView` 包"其余列 `FlatList`"，两个纵向列表用**同一个 scroll offset 驱动**（reanimated 共享值同步）。MVP 可先只冻结第一列（标题列）。
- **单元格**：`CellRenderer` 按 12 种 `field.type` 分发（文本/数字右对齐/checkbox ✓/select 彩色 chip/multi_select 顿号/date 格式化/link 显示引用行标题/formula 只读灰底）。
- **编辑（D5）**：**不做内联编辑**。点击整行 → `RecordSheet` 从底部升起，字段以表单列出，`CellEditor` 提供各类型编辑控件；保存走 `PATCH /rows/{row_id}`。点单格可快捷聚焦到对应字段。
- **加行**：底部"+"→ 空 `RecordSheet` → `POST /rows`。
- **列宽/列拖拽**：MVP 用内容自适应/固定宽；列重排后置到 P3。

### 5.2 看板 KanbanView（中）

- 按分组字段（select/text）生成列，横向 `ScrollView`；每列纵向卡片列表，卡片展示前 3 个非分组字段。
- 拖拽换列 = 改该行分组字段值（`gesture-handler` + `reanimated`；`draggable-flatlist` 已在依赖里）。MVP 可先只读 + 点击卡片进 `RecordSheet` 改分组，拖拽 P2。

### 5.3 日历 CalendarView（低）

- 月网格，参考已有 `src/components/MonthCalendar.tsx`；按 date/datetime 字段落卡片，每天最多 N 个 + "+更多"。点击进 `RecordSheet`。纯渲染，最先能落地。

### 5.4 仪表盘 DashboardView（中高）

- 移动端**不做自由网格**（`react-grid-layout` 无原生版且小屏没意义）→ 组件按 `layout` 顺序**纵向堆叠**成卡片流。
- 取数：一次 `POST /dashboards/{id}/query`（后端并行 + 缓存），拿 `results[componentId]` 分发渲染：
  - `metric` → `MetricCard`（大数字 + 单位/趋势）；
  - `chart` → 自研 SVG `Bar/Line/Pie`；
  - `pivot` → `PivotTable`（可横向滚的交叉表）；
  - `view` → `RowsTable`（只读行表）。
- **图表（D6）**：只需 bar/line/pie，用 `react-native-svg` 自研一薄层（坐标轴、色板对齐 Web 8 色、null 处理 zero/skip/break）。transform 若后端已在 `/query` 里算好就直接用，否则 `transforms.ts` 前端补算。
- P3 只读优先；仪表盘编辑（增删组件/改 query）上移动端，排 **P4**（D9）。

### 5.5 记录卡片 RecordSheet（贯穿所有视图的编辑中枢）

这是移动端编辑范式的核心：所有视图的"编辑一行"都汇聚到它。复用 `@gorhom/bottom-sheet`，字段按 schema 顺序渲染 `CellEditor`，支持 link 字段的"选择引用行"picker、select 的选项 picker、date 的原生日期 picker。

---

## 6. 自定义 App：沙箱 WebView（与 Web/Desktop 一致）

**定位澄清**：本项目"不要 WebView"针对的是**表格/仪表盘这类结构化内容**——它们有明确数据模型，理应原生渲染，不能用 WebView 糊一张网页糊弄。而**自定义 App 本身就是一张任意网页**（Agent 生成的 `config.source`，HTML+CSS+JS），Web/Desktop 端本来就用沙箱 iframe 跑它。因此移动端用**受控 WebView** 跑同一份 source，是与既有实现**一致**的做法，不属于被禁止的场景。用户已确认此判断。

**方案：`react-native-webview`（依赖已在）+ 原生 bridge 复刻 Web 端的沙箱模型与 `FlowBaseSDK`。**

1. **加载 source**：把 `config.source` 通过 WebView 的 `source={{ html }}` 注入（等价于 Web 的 `srcdoc`）。
2. **沙箱收紧**：`originWhitelist={[]}`（禁止导航外链）、`javaScriptEnabled` 仅对本 App、`setSupportMultipleWindows(false)`、注入与 Web 一致的 CSP（`default-src 'none'`；仅允许 inline script 与 data: 图片）；iOS 用 `WKWebView`（默认）、Android 关闭文件/内容访问。
3. **数据桥（`flowBaseSdkBridge.ts`）**：`injectedJavaScriptBeforeContentLoaded` 注入 `window.FlowBaseSDK`（`table().list/query/getRow`、`dashboard().list/results`），内部用 `window.ReactNativeWebView.postMessage` 发 RPC；原生侧 `onMessage` 收到后**在原生层校验 base_id 锁定 + 读写权限**，再调 `flowbase/api.ts` 的 REST，把结果 `injectJavaScript` 回传。**取数不在 WebView 里直连后端**——token 只留在原生侧，WebView 永远拿不到 `Authorization`，与 Web 端"父页面代理"同构。
4. **权限**：沿用 Web 的 MVP 策略——默认只读，写方法在原生 bridge 处拒绝（除非 `config.permissions` 显式放开）。
5. **自适应高度**：App 内 `postMessage('__flowbase_resize', scrollHeight)`，原生调整 WebView 高度（min 80 / max 8000），与 Web 一致。

**排期**：放在 **P3**（与仪表盘同期），因为它依赖 §4 的 REST client 与权限校验已就绪。

> 安全要点：WebView 是唯一能碰到"任意第三方代码"的面，必须保证 (a) token 绝不进 WebView、(b) 所有取数经原生 bridge 鉴权与 base 锁定、(c) CSP + 沙箱禁止任意网络与导航。这三条与 Web 端沙箱等价，评审时重点看这里。

---

## 7. 关键难点与取舍汇总

| 难点 | 取舍 |
|------|------|
| 冻结列（无 sticky） | MVP 只冻结首列，用双列表 + 共享 scroll offset；多列冻结 P3 |
| 内联单元格编辑（无 contentEditable） | **放弃内联，改记录卡片编辑**（D5），移动端反而更好用 |
| 图表（ECharts 无原生版） | 自研 SVG bar/line/pie（D6），不引重库 |
| 仪表盘自由网格 | 移动端改纵向卡片流，不做 drag-resize |
| 大表性能 | FlatList 虚拟化 + 服务端分页/投影（Web 没做，移动端必须做） |
| 实时协同 | **TODO 专项调研**（§9 R4）；暂拉取 + 乐观更新 + 下拉刷新 |
| 自定义 App | 沙箱 WebView + 原生 bridge（§6），token 不进 WebView |
| 结构编辑（建表/改 schema） | 复用 RecordSheet 式底部表单；公式字段编辑器需校验表达式（可靠后端返回错误） |

---

## 8. 分期交付计划

- **P0 · 打通链路（~3 天）**：`flowbase/api.ts` + types + `FlowBaseScreen` 骨架；`flowbase` 块入口卡片 + 导航注册；能进屏、列出 Base 的表和视图。
- **P1 · MVP 可用（~1.5 周）**：GridView 只读（虚拟化 + 首列冻结）+ `RecordSheet` 记录卡片**编辑/加行/删行**（乐观更新）+ CalendarView 只读 + 下拉刷新。→ **手机上能看能改多维表格**。
- **P2 · 视图与看板（~1 周）**：KanbanView（读 + 拖拽换组）+ 视图切换（grid/kanban/calendar 按 view config）+ 筛选/排序 UI + link/select/multi_select/date 各编辑控件完善。
- **P3 · 仪表盘 + 自定义 App（~1.5 周）**：DashboardView 纵向卡片流（只读）+ MetricCard/Pivot/RowsTable + 自研 SVG 图表 + transforms；**自定义 App 沙箱 WebView + 原生 bridge**（§6）。
- **P4 · 结构编辑 + 编辑态（~1.5 周）**：建 Base / 建表 / 改 schema（`schema/` 那组 sheet）+ 建/改视图 + **仪表盘/视图编辑**；多列冻结、列重排等打磨。
- **P5 · 实时同步（TODO，待调研定方案）**：见 §9 R4，方案确定后单独排期。

MVP（P0+P1）后即可交付"手机看/改多维表格"，约 2~3 周；结构编辑与自定义 App 在 P3/P4。

---

## 9. 风险与开放问题

**风险**
- R1 冻结列 + 横向滚 + 虚拟化三者叠加是 RN 的经典难点，需预留联调时间（P1 最大不确定性）。
- R2 自研图表覆盖度：若后续需要更多图型（散点/堆叠/组合），自研成本上升——届时再评估 `victory-native` 之类。
- R3 后端行查询单次上限 1000、无游标分页，超大表（10 万行）靠 offset 深翻页会变慢；MVP 场景下可接受。
- **R4（大项 · TODO）实时同步**：多人同时改同一 Base 时移动端看到旧数据。后端当前无 WebSocket、Web 也靠手动刷新。**正在另开专项调研飞书多维表格的实时协作方案**（CRDT / OT / 增量订阅 / 版本号轮询等），结论出来前本方案按"拉取 + 乐观更新 + 下拉刷新"落地，实时能力作为 **P5** 独立排期。→ 待调研补充：选型、后端改造范围、对移动端 store 的影响。

**已确认决策（原开放问题）**
1. ✅ 自定义 App → 沙箱 WebView + 原生 bridge（与 Web/Desktop 一致，§6、D7）。
2. ✅ 建 Base / 建表 / 改 schema → 移动端要做，排 **P4**（D8、§4.1 的 `schema/`）。
3. ✅ 仪表盘/视图编辑 → 移动端要做，P3 先只读、编辑排 **P4**（D9）。
4. ⏳ 实时同步 → 见 R4，专项调研中，留 TODO。

---

## 附录 A：FlowBase REST API（移动端要用的子集）

根路径 `/api/flowbase`，全部 `Authorization: Bearer <token>`。

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/bases` | 我的 Base 列表 |
| GET | `/bases/{base}` | Base 详情 + 表概览 |
| GET | `/bases/{base}/tables` | 表列表 |
| GET | `/bases/{base}/tables/{t}/schema` | 字段定义 |
| GET | `/bases/{base}/tables/{t}/views` | 视图列表（grid/kanban/calendar + config） |
| GET | `/bases/{base}/tables/{t}/rows` | 查行（filter/sort/order/limit/offset/fields/group_by/aggregate/having） |
| POST | `/bases/{base}/tables/{t}/rows` | 加行 `{rows:[{field_id:value}]}` |
| PATCH | `/bases/{base}/tables/{t}/rows/{row}` | 改行 `{values:{field_id:value}}`（null 清空，`__row_order__` 重排） |
| DELETE | `/bases/{base}/tables/{t}/rows` | 批量删 `{row_ids:[]}` 或 `{filter:[...]}` |
| PATCH | `/bases/{base}/tables/{t}/schema` | 改字段（P4，MVP 不用） |
| GET | `/bases/{base}/dashboards` | 仪表盘列表 |
| GET | `/bases/{base}/dashboards/{d}` | 仪表盘详情（config: layout+components） |
| POST | `/bases/{base}/dashboards/{d}/query` | 并行解析组件结果（10s 缓存，单组件错误内联） |
| GET | `/bases/{base}/apps` / `/apps/{a}` | App 列表/详情（含 `config.source`，见 §6） |

字段类型（12）：`text long_text number checkbox select multi_select date datetime url email link formula`。行数据稀疏 JSON `{field_id: value}`；`formula` 只读已物化；`link` 存被引用行的 `row_id`。

---

## 附录 B：P0 实现落地（2026-07-08）

**目标**：打通链路 —— 能进屏、列出一个 Base 的表 / 视图 / 字段。已完成，`tsc` 通过（新增文件零类型错误）。

**新增文件**（`FlopsMobile/src/flowbase/`）：
- `types.ts` —— Base / Table / Field / FieldType(12) / View / RowRecord，对齐 `/api/base` 契约（含行级 `version` 备 P1 CAS）。
- `api.ts` —— REST 客户端。`baseUrl = ${session.server_base_url}api/base`，普通 Bearer；统一 `{success,...}` 解包 + `FlowBaseApiError`（保留 409 body 供 P1 重放）。P0 导出 `listBases / getBase / getTableSchema / listViews`。
- `FlowBaseScreen.tsx` —— 入口屏骨架：解析 `baseId` → 加载 Base+表 → 表切换 chips → 选中表的视图 chips + 字段 schema 列表 + 行数；网格视图占位（P1）。含 loading/error/重试与「meta.base_id 缺失」兜底。

**接入点（关键决定）**：不新开路由，而是在 **`DocBodyView.tsx` 加 `docType === 'flowbase'` 分支**（与 `paper` 同构，位于 `!isSupported` 占位之前），读 `meta.base_id`/`meta.baseId` 渲染 `FlowBaseScreen`。好处：compact 与 iPad 两条预览流共用同一 `DocPreviewScreen → DocBodyView`，一处改动全覆盖，复用现有 header/chrome。已验证 `bodyDocType = item.type`、`bodyMeta = item.meta`，且 `flowbase` 不在 `FOLDER_LIKE_TYPES` 内。

**遗留/待跟进**：
- ~~需确认树是否透出 `flowbase` 节点~~ → 已确认：FlowDoc 树共享全类型，`_create_flowdoc_node` 标准流程即带 `type:'flowbase'` + `meta.base_id`，入口链路完整。
- 视图 chips 目前仅展示，切换渲染 grid/kanban/calendar 在 P2。

---

## 附录 C：P1 实现落地（只读网格 + 记录卡片编辑，2026-07-08）

**范围**：`queryRows` + 只读原生 `GridView`（虚拟化 + 冻结首列）+ `RecordSheet` 记录卡片编辑。`tsc` 通过（flowbase 代码零类型错误；仓库既有 19 个报错与本次无关）。WS 实时客户端本期未做，留到 P1.5/P2。

**API 增补**（`src/flowbase/api.ts`）：`queryRows`（filter/sort/分页/投影，返回含 `seq` 备 WS 追帧）、`insertRows`、`updateRow`（CAS：带 `base_version`，`isVersionConflict()` 判 409 并暴露 `current_data/current_version` 供 rebase）、`deleteRows`。

**新增渲染层**：
- `fields/formatValue.ts` + `fields/CellRenderer.tsx` —— 只读单元格：checkbox→✓、select→彩色 chip（读 options.choices.color）、multi_select→顿号拼接、number 右对齐、formula 灰显、datetime 本地化。
- `views/GridView.tsx` —— **冻结首列 + 其余列横滚 + 纵向虚拟化**。实现：左右两个纵向 `FlatList`，右列为主滚动源 `onScroll` 驱动左列 `scrollToOffset`（左列 `scrollEnabled=false` 无回环），固定行高 44 + `getItemLayout` 保证像素对齐；表头与正文同处一个横向 `ScrollView` 天然横向同步；容器高度 `onLayout` 实测后再挂定高列表（规避「FlatList 在横向 ScrollView 内高度不定」）。分页 `onEndReached`；命令式 `applyRowUpdate/prependRow/removeRow/refresh` 供编辑后就地补丁，免全量刷新。底部工具条「＋新建记录」+ 行数。
- `views/RecordSheet.tsx` —— `@gorhom/bottom-sheet` 记录卡片。逐字段编辑器：文本/多行/url/email/number（`BottomSheetTextInput`）、checkbox（Switch）、select/multi_select（chip 单/多选）、date/datetime（文本 + 占位，P2 换原生 picker）、link/formula 只读。保存：新建 `insertRows`；编辑仅发 diff 字段 + CAS `base_version`；**409 冲突自动 rebase 到服务端最新 + 提示 + 同步刷新网格**。删除走 `deleteRows` + 二次确认。

**接线**：`FlowBaseScreen` 改为 flex 布局——顶部定高（Base 名 + 表切换 chips + 视图 chips），主区 `GridView` 占满；宿主 `RecordSheet`，行点击→编辑、＋→新建、保存/删除→命令式补丁网格。`GridView` 按 `activeTableId` `key` 重挂以彻底重置。

**待跟进（P2）**：
- 真机验证：需连真实 Base 跑一遍（本地仅过 `tsc`，未起模拟器）。
- date/datetime 原生 picker；link 字段的「选择引用行」picker；列宽自适应/多列冻结。

---

## 附录 F：单元格级 presence（与 Desktop 对齐，2026-07-09）

**问题**：Mobile 能看到数据实时同步，但看不到他人「选中/编辑单元格」的视觉反馈。根因是 **presence 线格式与 Desktop 不一致**——Desktop（`useFlowBaseRealtime.js`）广播 `{type:'presence', cell:{row_id,field_id}, editing, value}`、颜色由 `client_id` 派生；而 Mobile 之前发/收的是**扁平** `{row_id, field_id, user_color}`，两端互相解析不到 → Mobile 对 Desktop 的选中零反馈（反之亦然）。且 GridView 只在冻结列画行级色条，没有单元格粒度。`tsc` + Metro bundle 均通过。

**改动**：
- `rt/socket.ts`：`RtPresence`/`PresencePayload` 改为 `{cell:{row_id,field_id}|null, editing, value}`；新增 `presence_query` 收发（`sendPresenceQuery` + `onPresenceQuery`）。
- `fields/presenceColor.ts`：`colorForClient(clientId)` = `hsl(hash%360,70%,45%)`，**与 Desktop 完全同公式**（同一协作者跨端同色）。
- `rt/useTableSocket.ts`：维护 `collaborators`（client_id → {color, cell, editing, value, lastSeen}）；派生 **`occupantAt(row,field)`**（每格代表：编辑态优先、同态取最近）+ `occupancy`（供 FlatList extraData 触发重绘）+ `presenceByRow`（聚合，看板/日历卡片用）；**心跳 8s 重播本端 presence**（防对端 24s stale-prune）+ 兜底 stale 清理；`hello`/`presence_query` 时重播本端并请对端重播。
- `views/GridView.tsx`：每格（冻结 + 滚动列）按 `occupantAt` 画 **内嵌彩色边框（选中 1px / 编辑 2px）+ 右上角 7px 角标**；他人正在编辑且带 `value` 时，格内显示其**实时值**（斜体着色）——与 Desktop 一致。`occupancy` 进 extraData 保证 presence 变化即时重绘。
- 出站：Mobile 无单元格粒度（整条记录编辑），故用**冻结/首列作代表格**广播 `{cell:{row_id, field_id:firstField}, editing:false}`——让 Desktop 看得到「谁在看这行」，`editing:false` 不上锁（并发写靠 CAS 兜底）。看板/日历经 `useTableRows({schema})` 拿到代表格；卡片仍用 `presenceByRow` 画色条（`collaborator.color`）。

**取舍**：`cursor:not-allowed`（Desktop 编辑态）在触屏无对应，用 **2px 更粗边框**表达「他人正在编辑」；Mobile 不硬阻止进入 RecordSheet（整条记录编辑 vs 单格锁语义不同，且 CAS 已防写坏）。真机需验：Desktop↔Mobile 双向 presence 彩框/角标/实时值、同色一致性、断线重连后 presence 重同步。

---

## 附录 G：GridView 去掉冻结首列（2026-07-09）

移动端屏窄，冻结首列反而更挤（Desktop 那套「冻结列 + 最左 # 行号列」不适配手机）。GridView 改为**所有列统一横向滚动**：
- 去掉冻结列的双 FlatList + 纵向 scroll 同步逻辑（删 `leftRef/rightRef/syncLeft/FROZEN_W/frozenField·otherFields` 拆分），合成**单个横向 `ScrollView`（表头 + 正文 FlatList 同处其中，横向天然同步）内嵌一个纵向虚拟化 FlatList**（每行渲染全部列）。代码更简单、少一次 scroll 同步。
- presence 出站的「代表格」由冻结列改为 `schema[0]`（首列），语义不变。
- 无 # 行号列（对齐用户预期，手机不需要）。`tsc` + Metro bundle 通过。

---

## 附录 D：P1.5 实现落地（实时协作 WS 客户端，2026-07-08）

**范围**：WS 客户端，实时把他端变更同步进网格 + presence 显示他人选中。`tsc` 通过（flowbase 代码零类型错误）。

**新增 `src/flowbase/rt/socket.ts`（`TableSocket`）**：
- URL：`buildWsUrl` 把 `server_base_url` 的 http→ws，拼 `api/base/ws/{table_id}?access_token=`（RN 不能给 WS 设头，走 query，与后端 `_ws_auth_user_id` query 分支一致；经 Flops 反代到 flowdoc-server）。
- 生命周期：`onopen`→等 `hello`{seq,client_id}→**快照就绪（markReady）+ hello 双条件**满足后发 `sync_since{seq}` 补齐这段增量；之后持续收 `change`。25s `ping` 保活；断线**指数退避重连**（1s→30s，握手成功归位），重连用 `getSeq()` 取「当前已应用 seq」再 `sync_since`，不漏帧不重放。
- 消息：处理 `hello / change{changes,catchup,reload} / presence / presence_leave / pong`；`sendPresence` 广播本端选中。

**GridView 接入实时**：
- `seqRef` 由首屏 `queryRows.seq` 播种；`applyChanges` 幂等应用（`seq<=已应用`跳过，按 seq 升序）：`insert`（按 row_order 有序插入，已存在则合并——覆盖乐观插入的临时值/补公式）、`update`（合并 data/version）、`delete`（移除）、`schema_changed`（上抛宿主 `onSchemaChanged`）；`reload=true`（落后过多）→ 全量重拉。`total` 增量维护，与乐观补丁去重（已存在的 insert 回声/已删的 delete 回声不重复计数）。
- **presence**：他人 `presence` 按行归组，冻结列渲染彩色左条（`user_color` 或按 user_id 取色板）；`presence_leave` 清除；过滤自身 `client_id` 回声。底部工具条「实时/离线」状态点。
- 命令式句柄加 `setLocalPresence(rowId|null)`；socket 生命周期只依赖 `[session, tableId]`（`applyChanges` 走 ref，避免重连churn）。切表时 GridView 按 key 重挂 → 旧 socket 关闭、新表新连。

**FlowBaseScreen**：`onSchemaChanged=setSchema`；打开记录卡片 → `setLocalPresence(row_id)`，关闭 → `setLocalPresence(null)`。

**一致性模型**：本端写仍走 REST（乐观补丁 + CAS），他端写经 WS `change` 落地；同一行冲突由 `updateRow` 的 `base_version` 兜底（409 自动 rebase）。presence 为 ephemeral，不落库。

**已知取舍/待验**：乐观插入的新行暂置顶，WS 回声按 row_order 合并但不重排（刷新后归位）；跨未加载分页的插入可能提前出现——均属可接受小瑕疵。真机需验证：多端并发下网格增删改同步、presence 彩条、断网重连追帧。

---

## 附录 E：P2 实现落地（看板/日历 + 视图切换，2026-07-08）

**范围**：KanbanView + CalendarView + 视图切换。`tsc` 通过（flowbase 代码零类型错误）。

**共用 plumbing 抽取（先重构再加视图，避免三视图各写一份数据/socket）**：
- `rt/applyChanges.ts` —— 纯函数 `applyRtChanges(current, changes, appliedSeq)`（幂等应用 insert/update/delete/schema_changed，返回 `{rows,changed,totalDelta,maxSeq,schema}`）+ `insertSortedInPlace`。
- `rt/useTableSocket.ts` —— 把 TableSocket 生命周期 + presence 封成 hook，回调走 ref，effect 只依赖 `[session,tableId,enabled]`（防重连 churn）；返回 `{connected, presenceByRow, sendPresence, markReady}`。
- `hooks/useTableRows.ts` —— 一次性拉全表（limit 1000）+ `useTableSocket` 实时 + presence + 命令式补丁（`applyRowUpdate/prependRow/removeRow/setLocalPresence`），供看板/日历用（GridView 保留自己的分页故不用）。
- `views/viewHandle.ts` —— 三视图共用 `TableViewHandle`（applyRowUpdate/prependRow/removeRow/setLocalPresence）；`fields/presenceColor.ts` —— 共用取色。
- GridView 重构为消费 `applyRtChanges` + `useTableSocket`（行为不变，去重复代码）；`GridViewHandle = TableViewHandle`（去掉未用的 refresh），使宿主可用单一 `viewRef` 指向任一视图。

**KanbanView（`views/KanbanView.tsx`）**：按「单选/文本」字段分组（`view.config` 指定或自动挑第一个 select→text）；select 用选项播种保证空列在、顺序稳；列内卡片显示标题 + 至多 3 个摘要字段 + presence 彩条；点卡片→编辑（改分组字段即换列）。P2 暂不做拖拽换列（改组经记录卡片完成）。

**CalendarView（`views/CalendarView.tsx`）**：按 date/datetime 字段落日（`view.config` 或自动挑）；**月网格 + 选中日事件列表**（移动端标准做法：网格给概览小圆点，下方列表可完整访问当天全部记录，不受"每格最多 N 条"限制）；月导航 ‹›；点事件→编辑。`dayKey` 归一 date（slice10）/datetime（本地 Y-M-D）。

**FlowBaseScreen 视图切换**：`activeViewId` 状态；视图 chips 可点切换（`views.length>1` 才显示）；按 `activeView.view_type` 渲染 Grid/Kanban/Calendar，`key=tableId:viewId` 精确重挂；**单一 `viewRef: TableViewHandle`** 指向当前视图 → RecordSheet 的保存/删除/presence 一处作用到活动视图。换表回默认视图；`loadedTableId` 门控，schema/views 就绪前只显 spinner，避免视图提前挂载导致双拉 + socket 抖动。

**待跟进（P3）**：看板拖拽换列（gesture-handler + reanimated）；真机全量验证（三视图切换、看板分组、日历落日、跨视图实时一致）。

---

## 附录 H：仪表盘 + 自定义 App（2026-07-09）

**范围**：仪表盘（纵向卡片流 + 自研 SVG 图表）+ 自定义 App（沙箱 WebView）。`tsc` + Metro bundle 通过。

**顶层区切换（`FlowBaseScreen`）**：初版用「表格/仪表盘/应用」三段切换；**已按用户要求改为与 Web 一致的单一 page tab bar**（见附录 I）。

**API/类型**：`types.ts` 加 Dashboard / DashboardComponent / AggGroup / ComponentResult / App；`api.ts` 加 `listDashboards / getDashboard / queryDashboard / listApps / getApp` + 导出低层 `flowbaseRequest`（供 App 桥忠实代理任意读端点）。

**仪表盘（`dashboard/`）**：
- `format.ts` —— CHART_PALETTE（对齐 Web 8 色）、`fmtNum`（不依赖 Intl，Hermes 安全）、`fieldName`、`groupLabel`。
- `charts.tsx` —— **自研 react-native-svg 图表** BarChart / LineChart / PieChart：坐标轴 + nice 刻度 + 类目标签（多则旋转）+ 多 series；折线按 null 断段（`connectNulls` 对应 skip）；饼图donut（单片退化为同心环）。ECharts 无原生版，只需三种图，自绘一薄层。
- `DashboardView.tsx` —— 拉 `getDashboard(config.components)` + `queryDashboard`（并行）+ 各组件来源表 schema；纵向卡片流按 `component.type` 渲染：metric 大数字（优先 `transform.value`）/ chart（归一 groups→categories+series/slices）/ pivot 交叉表（横滚）/ view 原始行表（横滚）。结果 shape 完全对齐 Web ChartRenderer。下拉刷新。移动端**不做自由网格**（Desktop 的 react-grid-layout 无原生版且小屏无意义）。

**自定义 App（`app/CustomAppWebView.tsx`）**：与 Web/Desktop 沙箱 iframe **同构**，移动端用 `react-native-webview`：
- srcdoc = CSP（`default-src 'none'`…封网）+ 注入只读 `window.FlowBaseSDK`（`table(name).list/query/getRow`、`dashboard(name).list/results`）+ App 源码。
- SDK 走 `window.ReactNativeWebView.postMessage` 发 RPC，原生 `onMessage` 收到后**在原生侧**（持 session token）校验+调 REST，再 `injectJavaScript(window.__flowbaseDeliver(...))` 回传。**token 绝不进 WebView**；base_id 锁死；只读白名单（写/未知方法拒绝）；表名→id 仅在本 Base 内解析。
- 自适应高度（`__flowbase_resize` → 80~8000，外层 ScrollView 承滚，WebView `scrollEnabled=false`）；`onShouldStartLoadWithRequest` 拒绝 http(s)/file 导航；关多窗口/文件访问。

**待跟进**：真机验证图表渲染与交互、App 沙箱双向 RPC（尤其 dashboard.results / grouped table.query）、大数据集性能；仪表盘/视图/App 的移动端**编辑**仍为后续（当前只读）。看板拖拽换列未做。

---

## 附录 I：page tab bar 混排（对齐 Web，2026-07-09）

用户要求不分三段，而是像 Web 一样把 **表 / 仪表盘 / app 当作平级 page**，按用户指定顺序平铺在一个 tab bar 里。

**Web 机制**（`FlopsWeb/.../FlowBaseView.jsx`）：顺序存在 **`base.config.entry_order`** = `[{kind,id}]`（kind ∈ table/dashboard/app/subdoc）。前端把 tables+dashboards+apps(+subdocs) 拼成扁平 `entries`，按 `entry_order` 里 `${kind}:${id}` 的位置排序，未登记项稳定排在后面；拖拽后 `PATCH base {config:{entry_order}}` 持久化。

**Mobile 改动**（`FlowBaseScreen`）：
- 去掉三段 segmented switcher，改为**单一 page tab bar**（横向 chips）。`entries` 用与 Web **完全相同**的排序：`tables+dashboards+apps` 按 `base.config.entry_order` 排，未登记稳定靠后（`p=Infinity` + 原序）。每个 chip 带类型小图标（表 grid-outline / 仪表盘 stats-chart-outline / 应用 cube-outline）区分。
- 选中态 `activePageKey = ${kind}:${id}`，缺省取 `entries[0]`；`activeTableId/activeDashId/activeAppId` 由当前 page 派生。主区按 `activePage.kind` 渲染 GridView·Kanban·Calendar / DashboardView / CustomAppWebView。表页额外显示视图（grid/kanban/calendar）chips。切表自动回默认视图。
- Mobile 只读，暂不做拖拽重排 `entry_order`（顺序完全跟随 Web 端设置）；subdoc 类 page 暂不纳入（那是内嵌 FlowDoc 文档，非本期范围）。`tsc` + Metro bundle 通过。
