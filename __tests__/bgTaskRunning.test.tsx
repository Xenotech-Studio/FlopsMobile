/**
 * 「后台任务在跑」这条状态（inbox SSE 的 inbox_snapshot.tasks 种子 + task_status 增量）。
 *
 * 背景：会话列表的转圈有两条**互不相干**的来源——chat_v2 agent 在跑（列表字段
 * chat_v2_running + conversation_run 事件），以及 agent 没跑但会话名下还有后台任务在跑。
 * 后者只在 inbox SSE 上有，`GET /api/conversations` 的行投影里根本没有对应字段，
 * 所以它必须独立于 runningMap 维护：列表刷新既补不出它，也绝不能清它。
 *
 * 套路同 conversationPaging.test：resetModules 模拟冷启动，React / react-test-renderer /
 * 被测模块从同一注册表 require（两份 React 会让 hooks dispatcher 为 null），故用 createElement。
 */
export {};

const SESSION = { user_id: 'u1', server_base_url: 'https://x/', access_token: 't' };

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../src/context/SessionContext', () => ({
  useSession: () => ({ session: SESSION }),
}));
jest.mock('../src/utils/clientInstanceId', () => ({
  getOrCreateClientInstanceId: () => Promise.resolve('inst-1'),
}));

const mockListConversations = jest.fn();
/** 捕获 ConversationProvider 注册的 SSE 帧处理器，测试里直接往里灌事件 */
let sseHandler: ((msg: Record<string, unknown>) => void) | null = null;
jest.mock('../src/api', () => ({
  CONV_LIST_PAGE_SIZE: 20,
  listConversations: (...a: unknown[]) => mockListConversations(...a),
  runInboxStream: (_s: unknown, _sig: unknown, onMsg: (m: Record<string, unknown>) => void) => {
    sseHandler = onMsg;
    return new Promise(() => {}); // 永不 resolve：保持"连接中"
  },
}));

const rows = (ids: string[]) => ids.map((id) => ({ id, title: `t${id}` }));

type Probe = {
  running: Record<string, boolean>;
  bgRunning: Record<string, boolean>;
  unread: Record<string, boolean>;
};

async function mount(listRows = rows(['c1', 'c2', 'c3'])) {
  jest.resetModules();
  sseHandler = null;
  const asMod = require('@react-native-async-storage/async-storage');
  await (asMod.default ?? asMod).clear();

  const React = require('react');
  const RTR = require('react-test-renderer');
  // jest 环境里 AppState.currentState 是 undefined，而 ConversationProvider 只在 'active'
  // 时才起 inbox SSE —— 不设这个，runInboxStream 根本不会被调，收不到任何帧。
  require('react-native').AppState.currentState = 'active';
  const ctxMod = require('../src/context/ConversationContext');

  let probe: Probe | null = null;
  function Capture() {
    probe = {
      running: ctxMod.useRunningConvMap(),
      bgRunning: ctxMod.useBgTaskRunningConvMap(),
      unread: ctxMod.useUnreadConvMap(),
    };
    return null;
  }

  mockListConversations.mockResolvedValue({ conversations: listRows, hasMore: false, total: listRows.length });
  await RTR.act(async () => {
    RTR.create(React.createElement(ctxMod.ConversationProvider, null, React.createElement(Capture)));
  });

  return {
    get: () => probe as unknown as Probe,
    /** 灌一帧 SSE */
    emit: async (msg: Record<string, unknown>) => {
      await RTR.act(async () => {
        sseHandler?.(msg);
      });
    },
    /** 重新拉列表（今日页下拉刷新 / sidebar_refresh / 回前台 catchup 都走它） */
    refresh: async (conversations = listRows) => {
      mockListConversations.mockResolvedValue({
        conversations,
        hasMore: false,
        total: conversations.length,
      });
      await RTR.act(async () => {
        sseHandler?.({ type: 'sidebar_refresh' });
        await Promise.resolve();
      });
    },
  };
}

beforeEach(() => {
  mockListConversations.mockReset();
});

test('inbox_snapshot.tasks 种子：{cid:[taskId]} → bgRunning 为 true', async () => {
  const t = await mount();
  await t.emit({ type: 'inbox_snapshot', running: {}, unread: {}, tasks: { c2: ['task-a'] } });
  expect(t.get().bgRunning).toEqual({ c2: true });
  // 不串到 agent 在跑那份上
  expect(t.get().running).toEqual({});
});

test('task_status：running 加入、结束移除', async () => {
  const t = await mount();
  await t.emit({ type: 'task_status', conversation_id: 'c1', task_id: 'task-a', status: 'running' });
  expect(t.get().bgRunning).toEqual({ c1: true });

  await t.emit({ type: 'task_status', conversation_id: 'c1', task_id: 'task-a', status: 'exited' });
  expect(t.get().bgRunning).toEqual({});
});

test('按 task_id 存集合：一个会话多个任务，先结束的那个不会误灭转圈', async () => {
  const t = await mount();
  await t.emit({ type: 'task_status', conversation_id: 'c1', task_id: 'a', status: 'running' });
  await t.emit({ type: 'task_status', conversation_id: 'c1', task_id: 'b', status: 'running' });
  expect(t.get().bgRunning).toEqual({ c1: true });

  await t.emit({ type: 'task_status', conversation_id: 'c1', task_id: 'a', status: 'exited' });
  expect(t.get().bgRunning).toEqual({ c1: true }); // b 还在跑

  await t.emit({ type: 'task_status', conversation_id: 'c1', task_id: 'b', status: 'killed' });
  expect(t.get().bgRunning).toEqual({});
});

test('列表刷新不碰后台任务集合（行投影里根本没这个字段，清了就再也回不来）', async () => {
  const t = await mount();
  await t.emit({ type: 'task_status', conversation_id: 'c2', task_id: 'a', status: 'running' });
  expect(t.get().bgRunning).toEqual({ c2: true });

  // 服务端列表对这条会话的 chat_v2_running 恒 false（agent 确实没跑）
  await t.refresh(rows(['c1', 'c2', 'c3']).map((r) => ({ ...r, chat_v2_running: false })));
  expect(t.get().running).toEqual({});
  expect(t.get().bgRunning).toEqual({ c2: true }); // 关键：没被 mergeFlag 抹掉
});

test('重连的 inbox_snapshot 即权威：断线期间跑完的任务被清掉，不残留转圈', async () => {
  const t = await mount();
  await t.emit({ type: 'inbox_snapshot', running: {}, unread: {}, tasks: { c1: ['a'], c2: ['b'] } });
  expect(t.get().bgRunning).toEqual({ c1: true, c2: true });

  // 重连：服务端这次只报 c2 还在跑（c1 的任务在断线期间结束了）
  await t.emit({ type: 'inbox_snapshot', running: {}, unread: {}, tasks: { c2: ['b'] } });
  expect(t.get().bgRunning).toEqual({ c2: true });

  // tasks 缺省 = 一个都没在跑
  await t.emit({ type: 'inbox_snapshot', running: {}, unread: {} });
  expect(t.get().bgRunning).toEqual({});
});

test('空数组 / 脏数据不产生幽灵 key', async () => {
  const t = await mount();
  await t.emit({
    type: 'inbox_snapshot',
    running: {},
    unread: {},
    tasks: { c1: [], c2: null, c3: ['ok'] },
  });
  expect(t.get().bgRunning).toEqual({ c3: true });
});

test('agent 在跑与后台任务在跑互不覆盖（两份独立，UI 侧取或）', async () => {
  const t = await mount();
  await t.emit({ type: 'conversation_run', conversation_id: 'c1', running: true });
  await t.emit({ type: 'task_status', conversation_id: 'c2', task_id: 'a', status: 'running' });
  expect(t.get().running).toEqual({ c1: true });
  expect(t.get().bgRunning).toEqual({ c2: true });

  // agent 跑完不影响后台任务那份
  await t.emit({ type: 'conversation_run', conversation_id: 'c1', running: false });
  expect(t.get().running).toEqual({});
  expect(t.get().bgRunning).toEqual({ c2: true });
});

test('task_status 缺 task_id 时忽略（不把整条会话标成在跑）', async () => {
  const t = await mount();
  await t.emit({ type: 'task_status', conversation_id: 'c1', status: 'running' });
  expect(t.get().bgRunning).toEqual({});
});
