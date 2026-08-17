/**
 * setUsageRuns 的 bail-out 判等。
 *
 * 背景：`usage` 帧在一次 run 里会被反复推送，旧写法每帧都 `[...prev]` 新建数组，
 * 于是每帧都强制重渲染整棵 ChatScreen —— 这是 "Maximum update depth exceeded"
 * 那条链上的一份压力来源。改成内容没变就返回 prev 让 React bail out。
 *
 * 判等错一点点后果都不小：判太松会把真实用量更新吞掉（界面上 token 数不再动），
 * 判太紧就退回天天重渲染。所以两个方向都得钉住。
 */
// 判等逻辑放在 utils/usageRuns 而不是 ChatScreen 里，正是为了能这样单独测：
// ChatScreen 本身拖着一长串未编译 ESM 的原生依赖（audio-api / 图标 / 手势 / 加密…），
// 在 jest 里根本 import 不进来。
import { usageRunEqual } from '../src/utils/usageRuns';

const run = (over: Record<string, unknown> = {}) => ({
  run_id: 'r1',
  last_message_index: 3,
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  ...over,
});

test('同一条 run、同样的用量 → 相等（这一帧不该重渲染）', () => {
  expect(usageRunEqual(run(), run())).toBe(true);
});

test('同一个对象引用 → 相等', () => {
  const r = run();
  expect(usageRunEqual(r, r)).toBe(true);
});

test('用量涨了 → 不相等（真实更新不能被吞）', () => {
  expect(
    usageRunEqual(run(), run({ usage: { prompt_tokens: 10, completion_tokens: 21, total_tokens: 31 } }))
  ).toBe(false);
});

test('多出一个用量字段 → 不相等', () => {
  expect(
    usageRunEqual(
      run(),
      run({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 1 } })
    )
  ).toBe(false);
});

test('少一个用量字段 → 不相等', () => {
  expect(usageRunEqual(run(), run({ usage: { prompt_tokens: 10 } }))).toBe(false);
});

test('run_id / last_message_index 变了 → 不相等', () => {
  expect(usageRunEqual(run(), run({ run_id: 'r2' }))).toBe(false);
  expect(usageRunEqual(run(), run({ last_message_index: 4 }))).toBe(false);
});

test('嵌套对象（by_model 之类）一律按不等处理 —— 宁可多渲染一次也不漏更新', () => {
  const withNested = run({ usage: { by_model: { a: 1 } } });
  expect(usageRunEqual(withNested, run({ usage: { by_model: { a: 1 } } }))).toBe(false);
});

test('缺 usage 的两条 → 相等；一边有一边没有 → 不相等', () => {
  expect(usageRunEqual(run({ usage: undefined }), run({ usage: undefined }))).toBe(true);
  expect(usageRunEqual(run(), run({ usage: undefined }))).toBe(false);
});

test('undefined 入参不炸', () => {
  expect(usageRunEqual(undefined, undefined)).toBe(true);
  expect(usageRunEqual(run(), undefined)).toBe(false);
  expect(usageRunEqual(undefined, run())).toBe(false);
});
