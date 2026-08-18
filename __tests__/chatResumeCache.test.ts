/**
 * 跨 ChatScreen 卸载的续流快照。
 *
 * 关键不变量：游标和内容是**一对**。`replay_from: N` 只发 N 之后的帧，所以只有在
 * conversation + run 都对得上、且真有半截内容时才能认这份快照；任何一条不满足都必须
 * 返回 null 让调用方退回全量回放 —— 认错一次的后果是界面上只剩答案后半段，前半段永久缺失。
 */
import {
  RESUME_SNAPSHOT_TTL_MS,
  clearResumeSnapshot,
  saveResumeSnapshot,
  takeResumeSnapshot,
} from '../src/utils/chatResumeCache';

const blocks = [{ type: 'text', content: '半截答案' }] as never;

const snap = (over: Record<string, unknown> = {}) => ({
  conversationId: 'c1',
  runId: 'r1',
  cursor: 42,
  blocks,
  text: '半截答案',
  status: 'thinking',
  savedAt: Date.now(),
  ...over,
});

beforeEach(() => clearResumeSnapshot());

test('存了就能按 (conversation, run) 取回来', () => {
  saveResumeSnapshot(snap());
  const got = takeResumeSnapshot('c1', 'r1');
  expect(got?.cursor).toBe(42);
  expect(got?.text).toBe('半截答案');
});

test('取一次就消费掉，不会被二次使用', () => {
  saveResumeSnapshot(snap());
  expect(takeResumeSnapshot('c1', 'r1')).not.toBeNull();
  expect(takeResumeSnapshot('c1', 'r1')).toBeNull();
});

test('对话对不上 → null（不能把别的对话的半截接上来）', () => {
  saveResumeSnapshot(snap());
  expect(takeResumeSnapshot('OTHER', 'r1')).toBeNull();
});

test('run 对不上 → null（新一轮 run 的游标空间与上一轮无关）', () => {
  saveResumeSnapshot(snap());
  expect(takeResumeSnapshot('c1', 'r2')).toBeNull();
});

test('超过 TTL → null，并且顺手清掉', () => {
  saveResumeSnapshot(snap({ savedAt: Date.now() - RESUME_SNAPSHOT_TTL_MS - 1 }));
  expect(takeResumeSnapshot('c1', 'r1')).toBeNull();
  // 已被清：即便把时间当成刚存的也取不到
  expect(takeResumeSnapshot('c1', 'r1')).toBeNull();
});

test('没有内容的快照不存也不取（有游标没内容会渲染出后半段，前半段永久缺失）', () => {
  saveResumeSnapshot(snap({ blocks: [] as never }));
  expect(takeResumeSnapshot('c1', 'r1')).toBeNull();
});

test('游标为 0 视为无效（等价于从头，不需要走续流）', () => {
  saveResumeSnapshot(snap({ cursor: 0 }));
  expect(takeResumeSnapshot('c1', 'r1')).toBeNull();
});

test('缺 conversationId / runId 一律不存', () => {
  saveResumeSnapshot(snap({ conversationId: '' }));
  expect(takeResumeSnapshot('', 'r1')).toBeNull();
  saveResumeSnapshot(snap({ runId: '' }));
  expect(takeResumeSnapshot('c1', '')).toBeNull();
});

test('clear 带 conversationId 时只清匹配的那份', () => {
  saveResumeSnapshot(snap());
  clearResumeSnapshot('OTHER'); // 不该动
  expect(takeResumeSnapshot('c1', 'r1')).not.toBeNull();

  saveResumeSnapshot(snap());
  clearResumeSnapshot('c1');
  expect(takeResumeSnapshot('c1', 'r1')).toBeNull();
});

test('同一 conversation+run 再存一次是覆盖（拿到的是新游标）', () => {
  saveResumeSnapshot(snap({ cursor: 10 }));
  saveResumeSnapshot(snap({ cursor: 99 }));
  expect(takeResumeSnapshot('c1', 'r1')?.cursor).toBe(99);
});
