/**
 * 聊天列表「钉底」状态机。
 *
 * 为什么需要它：打开对话时把列表滚到底，不能只在**第一次** onContentSizeChange 里滚一下。
 * 那一次事件往往发生在内容还没量完的时候——markdown 里的远端图片走 react-native-fit-image，
 * 高度靠 `Image.getSize()` 异步回调再 setState（在那之前占位高度接近 0）；flowdoc 附件、
 * exec 卡片预览、resume 回来的流式气泡同理。等它们陆续量出来、内容继续变高时，一次性的
 * latch 早就被消费掉了，视图就永远停在「当时那个底部」，用户得自己往下滚。
 * ScrollView 上开着 maintainVisibleContentPosition（为「加载更旧」不抖），内容长高时原生会
 * 主动把可见位置钉住不动，于是这个偏差是**永久**的，不会被后续任何滚动纠正。
 *
 * 对齐 Web：FlopsWeb pages/Chat.jsx 的 snapChatThreadToEnd 连滚三次（立即 + 两次 rAF）
 * 正是为了熬过同样的「布局还没稳」窗口，另有 scrollThreadIfNearBottom 做流式跟随。
 * 手机端这边只有 Android 补了 rAF + 200ms 两发，iOS 一发都没有（注释写的是「iOS 同步布局
 * 基本一次到位」——对纯文本成立，对图片/原生视图不成立），所以 iOS 上必现。
 *
 * 规则：
 * - armForOpen()：打开对话时武装一个**窗口**（默认 6s）。窗口内每次内容变高都重新滚到底。
 * - armOnce()：其它「该滚到底」的时机（发消息、回复结束……）保持原来的一次性语义，
 *   不武装窗口——避免用户展开折叠工具卡片时被误滚（见 ChatScreen shouldScrollToEndRef 原注释）。
 * - release()：用户一碰列表就放弃钉底。正在往上翻的时候，图片加载完不能把人拽回底部。
 */

/** 打开对话后的钉底时长。够覆盖弱网下图片 getSize 的往返，又不至于长到影响后续交互。 */
export const BOTTOM_PIN_WINDOW_MS = 6000;

export type BottomPinState = {
  /** 一次性触发（发消息 / 回复完成等），消费一次即清 */
  once: boolean;
  /** 窗口截止时间戳（Date.now() 口径）；0 = 没有窗口 */
  until: number;
  /** 一次性触发时是否带动画（打开对话首次定位用无动画） */
  animated: boolean;
};

export function createBottomPinState(): BottomPinState {
  return { once: false, until: 0, animated: true };
}

/** 打开对话：既要立刻滚一次，也要在随后的布局抖动里持续跟到底。 */
export function armForOpen(
  s: BottomPinState,
  now: number,
  windowMs: number = BOTTOM_PIN_WINDOW_MS
): void {
  s.once = true;
  s.animated = false; // 首次定位无动画，别让用户看着列表自己飞一段
  s.until = now + windowMs;
}

/** 一次性滚到底（不开窗口）。animated 默认 true，与旧的 scrollToEndAnimatedRef 语义一致。 */
export function armOnce(s: BottomPinState, animated: boolean = true): void {
  s.once = true;
  s.animated = animated;
}

/** 用户开始触摸/拖动列表 → 放弃钉底（一次性 latch 也一并作废）。 */
export function release(s: BottomPinState): void {
  s.once = false;
  s.until = 0;
}

/**
 * 还在「打开对话」窗口里吗？
 *
 * 给**视口高度**变化那条触发路径用（协同模式下 sheet 进场/换档/键盘会连着改视口高，
 * 而内容高度一动不动，光靠 onContentSizeChange 收不到任何信号）。刻意只看窗口、
 * 不碰 once：一次性 latch 的语义是「下次内容**变高**时滚」，被一次纯视口变化
 * （比如发完消息键盘收起）提前消费掉的话，真正的新消息反倒会被落在屏幕外。
 */
export function isInOpenWindow(s: BottomPinState, now: number): boolean {
  return s.until > 0 && now < s.until;
}

/**
 * 内容尺寸变了：要不要滚到底？
 * 返回 null = 不滚；否则给出这次滚动是否带动画。**会消费**一次性 latch（窗口不消费）。
 */
export function consumeScrollIntent(
  s: BottomPinState,
  now: number
): { animated: boolean } | null {
  const inWindow = s.until > 0 && now < s.until;
  if (!s.once && !inWindow) return null;
  const animated = s.once ? s.animated : false; // 窗口内的补滚一律无动画，否则会看到连续弹跳
  s.once = false;
  s.animated = true;
  return { animated };
}
