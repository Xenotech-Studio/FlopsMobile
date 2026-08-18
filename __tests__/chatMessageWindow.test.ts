/**
 * 流式期间的消息窗口裁剪。这段边界判定踩过两次坑，所以两个方向都钉住：
 *   - 后台任务灰条（task_event）必须留住，否则流式时灰条会被截掉；
 *   - 但真 user 之后的**助手内容**必须丢掉 —— 它马上会由流重新渲染。留着的话那条会被当成
 *     已完成消息渲染（挂复制/重新生成按钮），同时气泡里又流一遍同样内容，就是
 *     「切回前台先显示结束态、再变活跃、还跳一下滚动」。
 */
import { truncateMessagesAfterLastUser } from '../src/utils/chatMessageWindow';

type M = { role: string; content: string };
const msgs = (...roles: string[]): M[] => roles.map((r, i) => ({ role: r, content: `${r}${i}` }));
const roles = (list: unknown[]) => (list as M[]).map((m) => m.role);

test('普通一轮：丢掉最后一条 user 之后的助手回复', () => {
  const out = truncateMessagesAfterLastUser(msgs('user', 'assistant', 'user', 'assistant') as never);
  expect(roles(out)).toEqual(['user', 'assistant', 'user']);
});

test('带后台任务：灰条留住，但夹在中间的助手半截要丢', () => {
  // 服务端形如 … user, assistant(已落库的半截), task_event, …  —— 正是出问题的那个形状
  const out = truncateMessagesAfterLastUser(msgs('user', 'assistant', 'task_event') as never);
  expect(roles(out)).toEqual(['user', 'task_event']);
});

test('多条灰条 + 多段助手半截：只留 user 与灰条', () => {
  const out = truncateMessagesAfterLastUser(
    msgs('user', 'assistant', 'user', 'assistant', 'task_event', 'assistant', 'task_event') as never
  );
  expect(roles(out)).toEqual(['user', 'assistant', 'user', 'task_event', 'task_event']);
});

test('灰条在最后一条 user 之前：不受影响，按 user 切', () => {
  const out = truncateMessagesAfterLastUser(msgs('user', 'task_event', 'user', 'assistant') as never);
  expect(roles(out)).toEqual(['user', 'task_event', 'user']);
});

test('最后就是 user：原样返回', () => {
  const out = truncateMessagesAfterLastUser(msgs('user', 'assistant', 'user') as never);
  expect(roles(out)).toEqual(['user', 'assistant', 'user']);
});

test('没有任何 user / task_event：不动（没有边界可切）', () => {
  const out = truncateMessagesAfterLastUser(msgs('assistant', 'assistant') as never);
  expect(roles(out)).toEqual(['assistant', 'assistant']);
});

test('空列表', () => {
  expect(truncateMessagesAfterLastUser([])).toEqual([]);
});

test('只有灰条：留住灰条，不留它前面的助手内容', () => {
  const out = truncateMessagesAfterLastUser(msgs('assistant', 'task_event') as never);
  expect(roles(out)).toEqual(['task_event']);
});

test('不改原数组', () => {
  const input = msgs('user', 'assistant', 'task_event');
  const before = roles(input);
  truncateMessagesAfterLastUser(input as never);
  expect(roles(input)).toEqual(before);
});
