/**
 * 流程图视口（缩放 + 平移）**按项目**缓存 —— 对齐 Desktop 的 FitViewOnLoad + ViewportStore。
 *
 * Desktop 那侧的语义（FlopsDesktop/src/flowtask-core/components/FlowChart/FitViewOnLoad）：
 *  - key 粒度 = **projectId**（不带对话 id：同一个项目在哪儿打开都是同一个视口）；
 *  - 值 = ReactFlow 的 `{x, y, zoom}`，也就是我们这边的 `{tx, ty, scale}`；
 *  - **持久化**（Web=localStorage / Desktop=flopsCore 落文件），重启后仍在；
 *  - 有缓存就恢复，没有才 fitView。
 * 所以移动端也用持久化（AsyncStorage），不是内存级。
 *
 * 【坐标系为什么可以直接存三元组】两端**不共用存储**（这边写手机的 AsyncStorage，桌面端写
 * 它自己那台机器），所以不存在"桌面画布坐标搬到手机会错位"的问题。同一台设备内，视口尺寸
 * 变化（sheet 换档、转屏）会让恢复出来的画面构图偏一点，但内容不会丢 —— 这跟 Desktop 改窗口
 * 大小后的表现是一致的，不额外做归一化换算。
 *
 * 存储形态照抄 utils/collabSheetPrefs：单 key 装一张 map、模块 import 预热、渲染期同步读、
 * 防抖写盘。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_KEY = '@FlopsMobile/flowViewport.v1';

/** 最多记多少个项目的视口。超了按写入时间淘汰最旧的 —— 丢了最多是下次回到该项目重新 fit。 */
const MAX_ENTRIES = 120;

/** 落盘防抖：手势结束才写，本来就不密集，给一点窗口合并「连续捏合+平移」那种连发。 */
const PERSIST_DEBOUNCE_MS = 400;

export type FlowViewport = {
  scale: number;
  tx: number;
  ty: number;
  /** 写入时间，仅用于淘汰 */
  at: number;
};

type StoreFile = { v: 1; items: Record<string, FlowViewport> };

let memo: StoreFile = { v: 1, items: {} };
let ready = false;

function finite(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function parse(raw: string | null): StoreFile {
  if (!raw) return { v: 1, items: {} };
  try {
    const obj = JSON.parse(raw) as StoreFile;
    if (!obj || obj.v !== 1 || !obj.items || typeof obj.items !== 'object') {
      return { v: 1, items: {} };
    }
    const items: Record<string, FlowViewport> = {};
    for (const [id, p] of Object.entries(obj.items)) {
      if (!p || typeof p !== 'object') continue;
      const scale = finite(p.scale, 0);
      /* scale <= 0 的记录直接丢：拿它去算 1/scale 会炸出 Infinity，宁可退回 fit。 */
      if (!(scale > 0)) continue;
      items[id] = {
        scale,
        tx: finite(p.tx, 0),
        ty: finite(p.ty, 0),
        at: finite(p.at, 0),
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
    memo = parse(await AsyncStorage.getItem(STORE_KEY));
  } catch {
    memo = { v: 1, items: {} };
  }
  ready = true;
})();

/** 预热读完了没。没完时同步读一律返回 null，调用方应改走 ensureFlowViewports()。 */
export function flowViewportsReady(): boolean {
  return ready;
}

/** 异步兜底：等预热读完（同步路径没赶上时用）。 */
export async function ensureFlowViewports(): Promise<void> {
  try {
    await warmup;
  } catch {
    /* ignore */
  }
}

/** 同步读某个项目的视口；没有记录 / 还没预热完则 null。 */
export function readFlowViewport(projectId: string): FlowViewport | null {
  if (!ready || !projectId) return null;
  return memo.items[projectId] ?? null;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function writeNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  AsyncStorage.setItem(STORE_KEY, JSON.stringify(memo)).catch(() => {});
}

/**
 * 记下某个项目的视口。**内存镜像立刻更新**（同一次会话里马上读得到），磁盘防抖写。
 * scale 非正数直接忽略 —— 那种值恢复出来是废的，不如留着让下次走 fit。
 */
export function saveFlowViewport(
  projectId: string,
  vp: { scale: number; tx: number; ty: number },
): void {
  if (!projectId) return;
  const scale = Number(vp.scale);
  if (!Number.isFinite(scale) || scale <= 0) return;
  const tx = Number(vp.tx);
  const ty = Number(vp.ty);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
  memo.items[projectId] = { scale, tx, ty, at: Date.now() };
  const ids = Object.keys(memo.items);
  if (ids.length > MAX_ENTRIES) {
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

/** 立刻落盘（组件卸载 / 切项目时用，别把最后一次改动留在防抖窗口里丢掉）。 */
export function flushFlowViewports(): void {
  if (!persistTimer) return;
  writeNow();
}
