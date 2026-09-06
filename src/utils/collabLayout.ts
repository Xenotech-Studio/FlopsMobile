/**
 * 协同工作模式（CoWriter / CoPlanner / …）布局态 —— 服务端 `cowriter_layout` 桶的客户端归一化。
 *
 * 服务端契约（backend/llm_system/cowriter_layout.py + server.py POST /conversations/{id}/cowriter_layout）：
 *   会话 meta 里存一对字段 `cowriter_layout` / `cowriter_layout_seq`，值是 **per-mode 分桶**：
 *     { active_mode: 'default'|'cowriter'|'coplanner'|'cocoder'|'cobrowser',
 *       cowriter: { doc_ids, active_doc_id, focus? },
 *       coplanner: { project_ids, active_project_id }, ... }
 *
 * 它有两种到达形态，本模块都吃：
 *   - **分桶快照**（无 `layout_mode`）：初始 GET 会话时带的整桶，全部 mode 权威；
 *   - **单槽 delta**（带 `layout_mode`）：run 内工具驱动经 SSE 下发的一帧，只讲一个 mode，
 *     不能拿它去清别的 mode 的本地态。
 *
 * seq 单调递增，乱序 / 重放帧靠它丢弃（与 FlopsWeb applyCowriterLayoutFromServerPayload 同款守卫）。
 *
 * 注：`cowriter.focus`（agent 刚改了哪几个块）在 Phase 1 **刻意不解析** —— 手机端目前是只读文档
 * 渲染，没有可跳转的锚点消费方；等编辑/定位能力落地再补，免得先摆一份没人读的死状态。
 */

/** 服务端 LAYOUT_MODES 的镜像（llm_system/cowriter_layout.py）。新增 mode 时两边一起改。 */
export const COLLAB_LAYOUT_MODES = ['cowriter', 'coplanner', 'cocoder', 'cobrowser'] as const;

export type CollabLayoutMode = 'default' | (typeof COLLAB_LAYOUT_MODES)[number];

/**
 * 手机端协同工作区的 **tab 顺序**：四个 mode 一视同仁地铺进同一条走马灯。
 * cocoder（终端 / 文件树）与 cobrowser（浏览器分栏）目前只有页面没有内容 —— 服务端 layout
 * 对它们只给 active_mode、不给对象 id（见 applyCollabLayoutPayload），所以各占一项 mode 级
 * 占位，UI 画「请在桌面端查看」；等四模态对齐后再换成真内容。
 *
 * **coplanner 排最左**（产品定的）：项目是"这次协同在做什么"的总纲，文档/代码/浏览器都是
 * 它下面的具体材料，从左往右正好是从纲到目。其余三个保持原有相对次序。
 *
 * 注意这个顺序**只管走马灯怎么铺**。桶被清空后 active 落到哪儿是另一回事，仍归
 * activeAfterClear —— 它要跟服务端 `_remaining`（按 LAYOUT_MODES = cowriter 在前遍历）
 * 一致，两边分家会让"关掉最后一篇文档"后两端停在不同 mode 上。
 */
export const MOBILE_COLLAB_MODES = ['coplanner', 'cowriter', 'cocoder', 'cobrowser'] as const;
export type MobileCollabMode = (typeof MOBILE_COLLAB_MODES)[number];

export type CowriterSlot = {
  /** 打开着的文档 tab（去重、保序）。 */
  docIds: string[];
  /** 当前聚焦文档；恒为 docIds 里的一项（服务端不给或给了不在列表里时取首个）。 */
  activeDocId: string;
};

export type CoplannerSlot = {
  projectIds: string[];
  activeProjectId: string;
};

export type CollabLayoutState = {
  activeMode: CollabLayoutMode;
  cowriter: CowriterSlot | null;
  coplanner: CoplannerSlot | null;
  /** 已应用的 cowriter_layout_seq。 */
  seq: number;
};

export const EMPTY_COLLAB_LAYOUT: CollabLayoutState = {
  activeMode: 'default',
  cowriter: null,
  coplanner: null,
  seq: 0,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 字符串 id 数组归一：trim + 去空 + 去重保序。 */
function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const s = String(x ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** `{ids, active}` 归一：active 不在列表里就取首个；列表空 → null（= 该 mode 没开）。 */
function slotFrom(idsRaw: unknown, activeRaw: unknown): { ids: string[]; active: string } | null {
  const ids = normalizeIds(idsRaw);
  if (ids.length === 0) return null;
  const wanted = String(activeRaw ?? '').trim();
  return { ids, active: wanted && ids.includes(wanted) ? wanted : ids[0] };
}

function cowriterFrom(raw: unknown): CowriterSlot | null {
  if (!isRecord(raw)) return null;
  const s = slotFrom(raw.doc_ids, raw.active_doc_id);
  return s ? { docIds: s.ids, activeDocId: s.active } : null;
}

function coplannerFrom(raw: unknown): CoplannerSlot | null {
  if (!isRecord(raw)) return null;
  const s = slotFrom(raw.project_ids, raw.active_project_id);
  return s ? { projectIds: s.ids, activeProjectId: s.active } : null;
}

/**
 * 某个 mode 的桶被清空后，active 该落到哪儿：还有内容的桶优先（cowriter > coplanner），
 * 都空则 default。与服务端 POST 端点里的 `_remaining` 规则同构 —— 关掉最后一篇文档时，
 * 若 coplanner 还开着就该露出 coplanner，而不是直接退回纯聊天。
 */
function activeAfterClear(next: CollabLayoutState): CollabLayoutMode {
  if (next.cowriter) return 'cowriter';
  if (next.coplanner) return 'coplanner';
  return 'default';
}

/**
 * 把一帧服务端载荷（SSE 事件本体 / hydrate 时自造的 `{seq, layout}`）应用到当前布局态。
 *
 * @returns 新状态；**该帧应被忽略时返回 null**（seq 过期、载荷不成形、未知 mode），
 *          调用方据此跳过 setState —— 流式期间每秒几十帧，空写会把整棵 ChatScreen 推着重渲染。
 */
export function applyCollabLayoutPayload(
  prev: CollabLayoutState,
  payload: unknown,
  opts: { hydrate?: boolean } = {},
): CollabLayoutState | null {
  if (!isRecord(payload)) return null;
  const hydrate = opts.hydrate === true;
  const seq = Math.floor(Number(payload.seq));
  const seqOk = Number.isFinite(seq);
  /* hydrate（初始 GET）无条件权威：整桶快照就是服务端此刻的真相，即便 seq 没往前走
     （换会话回来时本地 seq 可能还停在上一个会话的高水位）。 */
  if (!hydrate && (!seqOk || seq <= prev.seq)) return null;
  const layout = payload.layout;
  if (!isRecord(layout)) return null;

  const next: CollabLayoutState = {
    ...prev,
    seq: seqOk ? seq : prev.seq,
  };

  const rawMode = String(layout.layout_mode ?? '').trim().toLowerCase();
  if (rawMode) {
    /* 单槽 delta：只动这一个 mode 的桶。未知 mode 直接丢帧 —— 宁可不动，也不要按猜的语义
       去改用户正开着的布局（服务端对未知 layout_mode 也是 400 拒绝而非静默降级）。 */
    if (!(COLLAB_LAYOUT_MODES as readonly string[]).includes(rawMode)) return null;
    if (rawMode === 'cowriter') {
      next.cowriter = cowriterFrom(layout);
      next.activeMode = next.cowriter ? 'cowriter' : activeAfterClear(next);
      return next;
    }
    if (rawMode === 'coplanner') {
      next.coplanner = coplannerFrom(layout);
      next.activeMode = next.coplanner ? 'coplanner' : activeAfterClear(next);
      return next;
    }
    /* cocoder / cobrowser：手机端画不出内容，但 active_mode 要如实记下 —— 走马灯要停到
       对应那页占位（见 activeCollabTabKey），而不是继续显示上一个 mode 的内容。 */
    next.activeMode = rawMode as CollabLayoutMode;
    return next;
  }

  /* 分桶快照：全部 mode 权威。 */
  next.cowriter = cowriterFrom(layout.cowriter);
  next.coplanner = coplannerFrom(layout.coplanner);
  const am = String(layout.active_mode ?? '').trim().toLowerCase();
  if (am === 'cowriter' && next.cowriter) next.activeMode = 'cowriter';
  else if (am === 'coplanner' && next.coplanner) next.activeMode = 'coplanner';
  else if (am === 'cocoder' || am === 'cobrowser') next.activeMode = am;
  else next.activeMode = activeAfterClear(next);
  return next;
}

/** 从会话 meta（GET /api/conversations/{id} 的 cowriter_layout(_seq)）hydrate 出初始布局态。 */
export function collabLayoutFromConversationMeta(
  layout: unknown,
  seq: unknown,
): CollabLayoutState {
  const applied = applyCollabLayoutPayload(
    EMPTY_COLLAB_LAYOUT,
    { seq: Math.floor(Number(seq)) || 0, layout },
    { hydrate: true },
  );
  return applied ?? EMPTY_COLLAB_LAYOUT;
}

/**
 * 手机端此刻要不要分叉成协同布局（工作区占页面主体 + 聊天落进 sheet）。
 *
 * 判据是「任一桶有内容 **或** active_mode 命中任一协同 mode」，比早期「active_mode 命中且
 * 该桶非空」宽：走马灯把四个 mode 铺成一条 tab 序列后，桌面端切到 cocoder 不该把手机端
 * 整个踢回普通聊天页（连刚才那几篇文档的 tab 一起消失），滑一下还应能滑回文档。
 * 具体停在哪个 tab 由 activeCollabTabKey + 本地跟随决定，不由这里挑。
 */
export function collabLayoutActive(state: CollabLayoutState): boolean {
  return !!state.cowriter || !!state.coplanner || state.activeMode !== 'default';
}

/** 走马灯里的一项：桶里有对象数据的铺 id，cocoder/cobrowser 只有 mode（id 为空串）。 */
export type CollabTabRef = { mode: MobileCollabMode; id: string; key: string };

/** tab 身份 = (mode, id) 二元组压成的串；跨帧比对选中项、做 React key 都用它。 */
export function collabTabKey(mode: MobileCollabMode, id: string): string {
  return `${mode}:${id}`;
}

/**
 * 布局态 → 扁平 tab 序列（顺序即 MOBILE_COLLAB_MODES）：
 * cowriter 铺开 docIds、coplanner 铺开 projectIds、cocoder/cobrowser 各一项占位。
 */
export function collabTabs(state: CollabLayoutState): CollabTabRef[] {
  const out: CollabTabRef[] = [];
  const push = (mode: MobileCollabMode, id: string) =>
    out.push({ mode, id, key: collabTabKey(mode, id) });
  for (const mode of MOBILE_COLLAB_MODES) {
    if (mode === 'cowriter') {
      for (const id of state.cowriter?.docIds ?? []) push(mode, id);
    } else if (mode === 'coplanner') {
      for (const id of state.coplanner?.projectIds ?? []) push(mode, id);
    } else {
      push(mode, '');
    }
  }
  return out;
}

/**
 * 服务端此刻聚焦的那一项在序列里的 key —— 本地跟随的目标是 **(activeMode, activeId) 二元组**：
 * 桌面端换 mode、或同一 mode 内换焦点文档，手机端都要跟着跳到对应 tab。
 * 恒返回 collabTabs 里存在的一项（前提是 collabLayoutActive 为真）。
 */
export function activeCollabTabKey(state: CollabLayoutState): string {
  const mode = state.activeMode;
  if (mode === 'cowriter' && state.cowriter) {
    return collabTabKey('cowriter', state.cowriter.activeDocId);
  }
  if (mode === 'coplanner' && state.coplanner) {
    return collabTabKey('coplanner', state.coplanner.activeProjectId);
  }
  if (mode === 'cocoder' || mode === 'cobrowser') return collabTabKey(mode, '');
  /* default，或 active_mode 指着一个空桶：落到首个有内容的项（同 activeAfterClear 的优先级）。 */
  if (state.cowriter) return collabTabKey('cowriter', state.cowriter.activeDocId);
  if (state.coplanner) return collabTabKey('coplanner', state.coplanner.activeProjectId);
  return collabTabKey('cocoder', '');
}

/** 结构相等（seq 不算）：新帧没带来任何可见变化时跳过 setState，避免白重渲染整棵聊天页。 */
export function collabLayoutEqual(a: CollabLayoutState, b: CollabLayoutState): boolean {
  if (a === b) return true;
  if (a.activeMode !== b.activeMode) return false;
  if (!!a.cowriter !== !!b.cowriter) return false;
  if (!!a.coplanner !== !!b.coplanner) return false;
  if (a.cowriter && b.cowriter) {
    if (a.cowriter.activeDocId !== b.cowriter.activeDocId) return false;
    if (a.cowriter.docIds.length !== b.cowriter.docIds.length) return false;
    if (a.cowriter.docIds.some((id, i) => id !== b.cowriter!.docIds[i])) return false;
  }
  if (a.coplanner && b.coplanner) {
    if (a.coplanner.activeProjectId !== b.coplanner.activeProjectId) return false;
    if (a.coplanner.projectIds.length !== b.coplanner.projectIds.length) return false;
    if (a.coplanner.projectIds.some((id, i) => id !== b.coplanner!.projectIds[i])) return false;
  }
  return true;
}
