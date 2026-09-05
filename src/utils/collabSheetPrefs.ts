/**
 * 协同抽屉的**每对话**本地偏好：上次有没有展开、展开到哪个高度。
 *
 * 为什么要存：协同布局改成了「默认收起、用户点右上角胶囊才展开」（数据侧有协同内容只让
 * 胶囊亮起角标，不再自动弹开）。那么"我上次在这个会话里把抽屉拉到过半屏"这件事就得记住，
 * 否则每次进来都要重新拉一遍。**纯本地视图状态**，不回写 /cowriter_layout，桌面端无感知。
 *
 * 存储形态与 utils/conversationSnapshot 同源：单个 AsyncStorage key 装一张 map，模块 import
 * 时就把读排进队列（预热），之后渲染期同步读内存镜像。区别是这里的数据极小（每条两个数），
 * 一次全量读写就够，不需要分 key。
 *
 * 【position 为什么存百分比而不是档位下标】
 * 下标绑死了"当前有几档"。将来加一档（比如 1/4 屏）或调整比例，旧数据就得迁移，且 index=1
 * 的含义会整个漂移。存百分比则是**几何量**：0 = 最低档、1 = 最高档，中间档按它在这两档
 * 之间的实际高度比例落点。读的时候拿当前档位表算出各档的百分比、取最近邻 —— 加档、改档
 * 都不用迁移数据，老会话只会落到"最接近的那一档"。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFS_KEY = '@FlopsMobile/collabSheetPrefs.v1';

/** 最多记多少个会话。超了按写入时间淘汰最旧的 —— 这是便利性状态，丢了最多是少一次自动展开。 */
const MAX_ENTRIES = 200;

/** 落盘防抖：拖档位时 onChange 可能连来几发，攒一下再写。 */
const PERSIST_DEBOUNCE_MS = 400;

export type CollabSheetPref = {
  /** 用户上次是不是把抽屉展开着 */
  opened: boolean;
  /** 展开到的高度，0..1；0 = 最低档，1 = 最高档（见文件头） */
  position: number;
  /** 写入时间，仅用于淘汰 */
  at: number;
};

type PrefsFile = { v: 1; items: Record<string, CollabSheetPref> };

let memo: PrefsFile = { v: 1, items: {} };
let ready = false;

function parse(raw: string | null): PrefsFile {
  if (!raw) return { v: 1, items: {} };
  try {
    const obj = JSON.parse(raw) as PrefsFile;
    if (!obj || obj.v !== 1 || !obj.items || typeof obj.items !== 'object') {
      return { v: 1, items: {} };
    }
    const items: Record<string, CollabSheetPref> = {};
    for (const [id, p] of Object.entries(obj.items)) {
      if (!p || typeof p !== 'object') continue;
      const position = typeof p.position === 'number' && Number.isFinite(p.position) ? p.position : 0;
      items[id] = {
        opened: p.opened === true,
        position: Math.min(1, Math.max(0, position)),
        at: typeof p.at === 'number' ? p.at : 0,
      };
    }
    return { v: 1, items };
  } catch {
    return { v: 1, items: {} };
  }
}

/** 预热：模块 import 时就发起，别挪进组件/effect（那就赶不上首次同步读了）。 */
const warmup: Promise<void> = (async () => {
  try {
    memo = parse(await AsyncStorage.getItem(PREFS_KEY));
  } catch {
    memo = { v: 1, items: {} };
  }
  ready = true;
})();

/** 预热读完了没。没完的话同步读会一律返回 null，调用方应改走 ensureCollabSheetPrefs()。 */
export function collabSheetPrefsReady(): boolean {
  return ready;
}

/** 异步兜底：等预热读完（同步路径没赶上时用）。 */
export async function ensureCollabSheetPrefs(): Promise<void> {
  try {
    await warmup;
  } catch {
    /* ignore */
  }
}

/** 同步读某个会话的偏好；没有记录 / 还没预热完则 null。 */
export function readCollabSheetPref(conversationId: string): CollabSheetPref | null {
  if (!ready || !conversationId) return null;
  return memo.items[conversationId] ?? null;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function writeNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  AsyncStorage.setItem(PREFS_KEY, JSON.stringify(memo)).catch(() => {});
}

/**
 * 记下某个会话的偏好。**内存镜像立刻更新**（同一次会话切换里马上读得到），磁盘防抖写。
 * 传 conversationId 为空（新会话还没建出 id）时直接忽略。
 */
export function saveCollabSheetPref(
  conversationId: string,
  pref: { opened: boolean; position: number },
): void {
  if (!conversationId) return;
  memo.items[conversationId] = {
    opened: pref.opened,
    position: Math.min(1, Math.max(0, Number.isFinite(pref.position) ? pref.position : 0)),
    at: Date.now(),
  };
  const ids = Object.keys(memo.items);
  if (ids.length > MAX_ENTRIES) {
    /* 超额按写入时间淘汰最旧的那批。 */
    ids
      .sort((a, b) => (memo.items[a].at ?? 0) - (memo.items[b].at ?? 0))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete memo.items[id]);
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeNow();
  }, PERSIST_DEBOUNCE_MS);
}

/** 立刻落盘（切走会话 / 组件卸载时用，别把最后一次改动留在防抖窗口里丢掉）。 */
export function flushCollabSheetPrefs(): void {
  if (!persistTimer) return;
  writeNow();
}

/**
 * 某一档在「最低档→最高档」这条轴上的百分比。
 * heights 是升序的档位像素高度表（= ChatScreen 的 collabSheetSnapHeights）。
 */
export function collabDetentPosition(heights: number[], index: number): number {
  if (!heights.length) return 0;
  const lo = heights[0];
  const hi = heights[heights.length - 1];
  const h = heights[Math.min(heights.length - 1, Math.max(0, index))];
  if (!(hi > lo)) return 0;
  return Math.min(1, Math.max(0, (h - lo) / (hi - lo)));
}

/**
 * 百分比 → 最接近的档位下标（最近邻）。档位表变了也不用迁移数据：
 * 老百分比只会落到新表里最接近的那一档。
 */
export function nearestCollabDetent(heights: number[], position: number): number {
  if (heights.length <= 1) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < heights.length; i++) {
    const d = Math.abs(collabDetentPosition(heights, i) - position);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
