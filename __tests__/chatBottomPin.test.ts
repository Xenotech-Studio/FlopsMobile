/**
 * 聊天列表钉底状态机：打开对话要在「内容还在陆续量高」的那段时间里持续贴底，
 * 其它触发保持一次性，用户一碰就放弃。
 */
import {
  BOTTOM_PIN_WINDOW_MS,
  armForOpen,
  armOnce,
  consumeScrollIntent,
  createBottomPinState,
  release,
} from '../src/utils/chatBottomPin';

const T0 = 1_700_000_000_000;

test('默认不滚：没人武装时内容变高不该动视图', () => {
  const s = createBottomPinState();
  expect(consumeScrollIntent(s, T0)).toBeNull();
});

test('一次性触发只滚一次（展开折叠卡片不会被误滚）', () => {
  const s = createBottomPinState();
  armOnce(s);
  expect(consumeScrollIntent(s, T0)).toEqual({ animated: true });
  // 第二次内容变高（比如用户展开了一张工具卡片）不再滚
  expect(consumeScrollIntent(s, T0 + 10)).toBeNull();
});

test('打开对话：首帧无动画贴底，随后每次内容变高都继续贴底', () => {
  const s = createBottomPinState();
  armForOpen(s, T0);

  // 首个 onContentSizeChange —— 此时图片高度还没量出来
  expect(consumeScrollIntent(s, T0)).toEqual({ animated: false });
  // 图片 getSize 回来了，内容变高 → 还要再贴一次（这正是原来漏掉的）
  expect(consumeScrollIntent(s, T0 + 300)).toEqual({ animated: false });
  // flowdoc 附件又量完 → 继续
  expect(consumeScrollIntent(s, T0 + 2500)).toEqual({ animated: false });
});

test('钉底窗口有上限，过期后不再自动贴底', () => {
  const s = createBottomPinState();
  armForOpen(s, T0);
  consumeScrollIntent(s, T0);
  expect(consumeScrollIntent(s, T0 + BOTTOM_PIN_WINDOW_MS - 1)).not.toBeNull();
  expect(consumeScrollIntent(s, T0 + BOTTOM_PIN_WINDOW_MS)).toBeNull();
  expect(consumeScrollIntent(s, T0 + BOTTOM_PIN_WINDOW_MS + 5000)).toBeNull();
});

test('用户一碰列表就放弃钉底（正往上翻时图片加载完不能被拽回底部）', () => {
  const s = createBottomPinState();
  armForOpen(s, T0);
  consumeScrollIntent(s, T0);

  release(s); // onTouchStartCapture / onScrollBeginDrag
  expect(consumeScrollIntent(s, T0 + 100)).toBeNull();
  expect(consumeScrollIntent(s, T0 + 3000)).toBeNull();
});

test('release 也作废还没消费的一次性 latch', () => {
  const s = createBottomPinState();
  armOnce(s);
  release(s);
  expect(consumeScrollIntent(s, T0)).toBeNull();
});

test('窗口期内来的一次性触发：仍然只滚一次，且动画标记不串到窗口补滚上', () => {
  const s = createBottomPinState();
  armForOpen(s, T0);
  consumeScrollIntent(s, T0); // 打开时那一发

  armOnce(s, true); // 窗口还没过就发了条消息
  expect(consumeScrollIntent(s, T0 + 500)).toEqual({ animated: true });
  // 后续窗口内的补滚一律无动画，不会因为上一发带动画就跟着弹
  expect(consumeScrollIntent(s, T0 + 600)).toEqual({ animated: false });
});

test('窗口过期后一次性触发照常工作（发消息仍会滚到底）', () => {
  const s = createBottomPinState();
  armForOpen(s, T0);
  consumeScrollIntent(s, T0);
  expect(consumeScrollIntent(s, T0 + BOTTOM_PIN_WINDOW_MS)).toBeNull();

  armOnce(s);
  expect(consumeScrollIntent(s, T0 + BOTTOM_PIN_WINDOW_MS + 1)).toEqual({ animated: true });
});
