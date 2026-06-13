/**
 * useResponsive —— 全局自适应布局探测层（iPad / 大屏 / 分屏的唯一判据来源）。
 *
 * 设计原则（与用户敲定的地基决策一致）：
 *  1. 一律用 useWindowDimensions()，永不假定 width = 整块物理屏宽。
 *     这是「支持 Split View」唯一的硬纪律：iPad 被拖成半屏/三分屏时 width 会实时缩小，
 *     本 hook 自动让 sidebarShell 翻 false → 退回手机（compact）覆盖式抽屉。我们不为
 *     「iPad 半屏」这个尺寸单独画布局，只让它自然落到手机那套。
 *  2. 断点按「当前可用宽度」判，不按 Platform.isPad。
 *  3. compact（手机覆盖式抽屉）是一等公民：iPhone 主力 + iPad 分屏窄宽度兜底。
 *
 * 两套布局外壳（关键设计）：
 *  - **compact**（width < 断点）：手机版那种「几乎独占整页」的覆盖式动画抽屉。
 *  - **sidebarShell**（width ≥ 断点 = iPad 全屏，横竖通用）：一个 **push 式、可收起/展开的侧栏**。
 *    横屏与竖屏是「同一个侧栏的两个状态」（默认展开 / 默认收起），**同一棵组件树**，旋转只是
 *    侧栏宽度在两个默认值之间过渡 → 不 remount、不闪。竖屏 iPad 仍有 ~768pt，侧栏 push 出来后
 *    主区还剩 ~468pt（比 iPhone 还宽），所以不需要手机那种覆盖式抽屉。
 *
 * 改这里的断点 / 宽度即可全局生效。
 */
import { useWindowDimensions } from 'react-native';

/**
 * 进入「push 式侧栏外壳」(sidebarShell) 的可用宽度阈值（dp）。横竖屏都按这一个宽度判。
 *  - iPad 全屏：竖屏 ≈ 768–834、横屏 ≈ 1024–1366 → 均 ≥ 700 → sidebarShell。
 *  - iPad 1/2、1/3 分屏 / Slide Over ≈ 320–680 → < 700 → compact（手机覆盖式抽屉）。
 *  - iPhone（最宽 ~440）始终 < 700 → 永远 compact。
 */
export const SIDEBAR_BREAKPOINT = 700;

/**
 * sidebarShell 的第二判据：窗口「最短边」下限（dp）。
 * 手机横屏宽度（iPhone Pro Max 横 ≈ 932）会越过 SIDEBAR_BREAKPOINT，但它不是平板——
 * 若进 sidebar 外壳会整棵树 remount（compact ↔ sidebar 是两套树），且转回竖屏时再切回来，
 * 前景层（文档预览等）重放入场动画。最短边把手机排除：手机最短边 ≈ 390–440 < 500，
 * iPad 全屏最短边 ≥ 768；iPad 分屏窄条宽度本就 < 700 已被第一判据排除。
 * （手机原本锁竖屏碰不到这条；附件预览解锁转屏后必须有它。）
 */
export const SIDEBAR_MIN_SHORT_SIDE = 500;

/** sidebarShell 展开态侧栏宽度（dp）。承载 DrawerContent。收起态宽度动画到 0。 */
export const SIDEBAR_WIDTH = 300;

/**
 * 居中阅读 / 内容栏最大宽度（dp）。宽屏上正文不铺满整块画布——行宽过长会显著降低可读性，
 * 文档沉浸阅读、聊天等「以读为主」的内容限到这个 measure 居中，两侧留白。
 */
export const READING_MAX_WIDTH = 720;

export type LayoutTier = 'compact' | 'sidebar';

export interface ResponsiveInfo {
  /** 当前窗口（不是物理屏）可用宽度 */
  width: number;
  /** 当前窗口可用高度 */
  height: number;
  /** 横屏（宽 > 高） */
  isLandscape: boolean;
  /** 是否用 push 式可收起侧栏外壳（iPad 全屏，横竖通用、同一棵树）。
   *  false = compact 手机覆盖式抽屉（iPhone / iPad 分屏窄宽度）。见 {@link SIDEBAR_BREAKPOINT}。 */
  sidebarShell: boolean;
  /** sidebarShell 下侧栏默认是否展开：横屏默认展开、竖屏默认收起。
   *  旋转时此值翻转 → DrawerShell 把侧栏动画到对应默认态（「一个东西的两个过程」）。 */
  sidebarDefaultOpen: boolean;
  /** 语义化层级 */
  tier: LayoutTier;
  /** sidebarShell 展开态侧栏宽度 */
  sidebarWidth: number;
  /** 宽阅读上下文（iPad 全屏，含竖屏）：文档/正文限宽居中沉浸阅读时用。等价于 sidebarShell。 */
  expanded: boolean;
}

export function useResponsive(): ResponsiveInfo {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  /** iPad 级宽度即用 push 侧栏外壳（横竖通用）；窄于断点退回手机覆盖式抽屉。
   *  最短边条件排除「手机横屏」误入 sidebar 外壳（见 SIDEBAR_MIN_SHORT_SIDE）。 */
  const sidebarShell =
    width >= SIDEBAR_BREAKPOINT && Math.min(width, height) >= SIDEBAR_MIN_SHORT_SIDE;
  return {
    width,
    height,
    isLandscape,
    sidebarShell,
    /** 横屏默认展开、竖屏默认收起。 */
    sidebarDefaultOpen: isLandscape,
    tier: sidebarShell ? 'sidebar' : 'compact',
    sidebarWidth: SIDEBAR_WIDTH,
    expanded: sidebarShell,
  };
}
