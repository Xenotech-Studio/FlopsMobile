/**
 * ConversationContext 的两件事：服务端分页（增量追加 / 不重不漏 / 刷新窗口语义）
 * 与本地快照秒开（首帧就有行，不是空一帧再补）。
 *
 * 每个用例都 resetModules 重来一遍，模拟「冷启动」：快照模块的预热读是模块顶层副作用，
 * 只有重新 require 才会再跑一次。React / react-test-renderer / 被测模块必须从**同一个**
 * 注册表里 require（否则两份 React → hooks dispatcher 为 null），所以这里用 createElement
 * 而不是 JSX（JSX 会绑到文件顶层那份 react/jsx-runtime）。
 */
const SNAPSHOT_KEY = '@FlopsMobile/convSnapshot.v1';
const SESSION = { user_id: 'u1', server_base_url: 'https://x/', access_token: 't' };
const SESSION_2 = { user_id: 'u2', server_base_url: 'https://x/', access_token: 't2' };

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// 可变，给「换账号」用例切换（jest.mock 工厂只能引用 mock* 前缀的外部变量）
let mockSession: typeof SESSION | typeof SESSION_2 = SESSION;
jest.mock('../src/context/SessionContext', () => ({
  useSession: () => ({ session: mockSession }),
}));

// jest.mock 工厂只能引用 mock* 前缀的外部变量
const mockListConversations = jest.fn();
jest.mock('../src/api', () => ({
  CONV_LIST_PAGE_SIZE: 20,
  listConversations: (...a: unknown[]) => mockListConversations(...a),
  // SSE 永不 resolve：测试里不需要它，也别让它去连网络
  runInboxStream: () => new Promise(() => {}),
}));
jest.mock('../src/utils/clientInstanceId', () => ({
  getOrCreateClientInstanceId: () => Promise.resolve('inst-1'),
}));

type Row = { id: string; title: string };
const rows = (from: number, n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, title: `t${from + i}` }));

const snapshotOf = (userId: string, r: Row[], extra: Record<string, unknown> = {}) => ({
  v: 1,
  userId,
  savedAt: Date.now(),
  rows: r,
  running: {},
  unread: {},
  ...extra,
});

type Probe = {
  list: Row[];
  paging: { hasMore: boolean; loadingMore: boolean; loadMore: () => Promise<void> };
  actions: {
    refreshConversations: (opts?: { reset?: boolean }) => Promise<void>;
  };
};

/** 冷启动一次：清存储 →（可选）预置快照 → 重新 require（触发预热）→ 挂 Provider。
 *  frames 记录每一帧 convList 的长度，用来断言「首帧就有行」。 */
async function coldStart(preloadSnapshot?: unknown) {
  jest.resetModules();
  const asMod = require('@react-native-async-storage/async-storage');
  const AsyncStorage = asMod.default ?? asMod;
  await AsyncStorage.clear();
  if (preloadSnapshot) {
    await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(preloadSnapshot));
  }

  const React = require('react');
  const RTR = require('react-test-renderer');
  const ctxMod = require('../src/context/ConversationContext');
  const snapMod = require('../src/utils/conversationSnapshot');
  // 等模块顶层那次预热读落地——真实冷启动里它排在 session 恢复之前，首帧时必然已在内存
  await snapMod.ensureSnapshot('__warmup__');

  const frames: number[] = [];
  let probe: Probe | null = null;
  function Capture() {
    const list = ctxMod.useConversations();
    frames.push(list.length);
    probe = { list, paging: ctxMod.useConversationPaging(), actions: ctxMod.useConversationActions() };
    return null;
  }

  const element = React.createElement(
    ctxMod.ConversationProvider,
    null,
    React.createElement(Capture)
  );
  let tree!: { update: (el: unknown) => void };
  await RTR.act(async () => {
    tree = RTR.create(element);
  });

  return {
    frames,
    get: () => probe as unknown as Probe,
    act: (fn: () => Promise<void>) => RTR.act(fn),
    /** 让 Provider 重新读一次 useSession（用于换账号用例） */
    rerender: () =>
      RTR.act(async () => {
        tree.update(
          React.createElement(ctxMod.ConversationProvider, null, React.createElement(Capture))
        );
      }),
    AsyncStorage,
  };
}

beforeEach(() => {
  mockListConversations.mockReset();
  mockSession = SESSION;
});

test('首页请求 limit=20 offset=0，hasMore 透传给消费方', async () => {
  mockListConversations.mockResolvedValue({ conversations: rows(0, 20), hasMore: true, total: 100 });
  const t = await coldStart();
  expect(mockListConversations).toHaveBeenCalledWith(SESSION, { limit: 20, offset: 0 });
  expect(t.get().list).toHaveLength(20);
  expect(t.get().paging.hasMore).toBe(true);
});

test('滚到底加载下一页：增量追加、offset 按服务端行数推进', async () => {
  mockListConversations.mockResolvedValueOnce({ conversations: rows(0, 20), hasMore: true, total: 45 });
  const t = await coldStart();

  mockListConversations.mockResolvedValueOnce({ conversations: rows(20, 20), hasMore: true, total: 45 });
  await t.act(async () => {
    await t.get().paging.loadMore();
  });
  expect(mockListConversations).toHaveBeenLastCalledWith(SESSION, { limit: 20, offset: 20 });
  expect(t.get().list.map((c) => c.id)).toEqual(rows(0, 40).map((c) => c.id)); // 追加，非替换

  mockListConversations.mockResolvedValueOnce({ conversations: rows(40, 5), hasMore: false, total: 45 });
  await t.act(async () => {
    await t.get().paging.loadMore();
  });
  expect(mockListConversations).toHaveBeenLastCalledWith(SESSION, { limit: 20, offset: 40 });
  expect(t.get().list).toHaveLength(45);
  expect(t.get().paging.hasMore).toBe(false);
});

test('翻页途中会话上浮导致跨页重复：按 id 去重，offset 仍按服务端行数走（不漏行）', async () => {
  mockListConversations.mockResolvedValueOnce({ conversations: rows(0, 20), hasMore: true, total: 40 });
  const t = await coldStart();

  // 第二页头两条跟第一页尾部重了（两次请求之间服务端排序变了）
  mockListConversations.mockResolvedValueOnce({
    conversations: [...rows(18, 2), ...rows(20, 18)],
    hasMore: false,
    total: 40,
  });
  await t.act(async () => {
    await t.get().paging.loadMore();
  });
  const ids = t.get().list.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length); // 无重复
  expect(ids).toEqual(rows(0, 38).map((c) => c.id));
});

test('hasMore=false 时 loadMore 是 no-op（不空打服务端）', async () => {
  mockListConversations.mockResolvedValue({ conversations: rows(0, 8), hasMore: false, total: 8 });
  const t = await coldStart();
  const calls = mockListConversations.mock.calls.length;
  await t.act(async () => {
    await t.get().paging.loadMore();
  });
  expect(mockListConversations.mock.calls.length).toBe(calls);
});

test('下拉刷新 reset 回第一页；静默刷新则保持已加载窗口', async () => {
  mockListConversations.mockResolvedValueOnce({ conversations: rows(0, 20), hasMore: true, total: 60 });
  const t = await coldStart();
  mockListConversations.mockResolvedValueOnce({ conversations: rows(20, 20), hasMore: true, total: 60 });
  await t.act(async () => {
    await t.get().paging.loadMore();
  });

  // 不带 reset：重拉「已加载的 40 条」，列表不缩水
  mockListConversations.mockResolvedValueOnce({ conversations: rows(0, 40), hasMore: true, total: 60 });
  await t.act(async () => {
    await t.get().actions.refreshConversations();
  });
  expect(mockListConversations).toHaveBeenLastCalledWith(SESSION, { limit: 40, offset: 0 });
  expect(t.get().list).toHaveLength(40);

  // 下拉刷新：窗口回到第一页
  mockListConversations.mockResolvedValueOnce({ conversations: rows(0, 20), hasMore: true, total: 60 });
  await t.act(async () => {
    await t.get().actions.refreshConversations({ reset: true });
  });
  expect(mockListConversations).toHaveBeenLastCalledWith(SESSION, { limit: 20, offset: 0 });
  expect(t.get().list).toHaveLength(20);

  // 重置后下一页从 20 起（不是从 40）
  mockListConversations.mockResolvedValueOnce({ conversations: rows(20, 20), hasMore: true, total: 60 });
  await t.act(async () => {
    await t.get().paging.loadMore();
  });
  expect(mockListConversations).toHaveBeenLastCalledWith(SESSION, { limit: 20, offset: 20 });
});

test('冷启动首帧就有快照行（不是先空一帧），网络回来后整窗对账', async () => {
  const cached = rows(0, 12).map((c) => ({ ...c, title: `旧标题${c.id}` }));
  mockListConversations.mockResolvedValue({
    conversations: rows(0, 12).map((c) => ({ ...c, title: `新标题${c.id}` })),
    hasMore: true,
    total: 60,
  });
  const t = await coldStart(snapshotOf('u1', cached, { unread: { c3: true } }));

  expect(t.frames[0]).toBe(12); // 第一帧就有 12 行 —— 没有空列表那一帧
  expect(t.get().list[0].title).toBe('新标题c0'); // 网络回来覆盖旧标题（对账）
});

test('快照 user_id 不匹配时不 seed（换账号不闪上个账号的标题）', async () => {
  mockListConversations.mockResolvedValue({ conversations: rows(0, 5), hasMore: false, total: 5 });
  const t = await coldStart(snapshotOf('OTHER_USER', rows(0, 9)));
  expect(t.frames[0]).toBe(0);
  expect(t.get().list).toHaveLength(5);
});

test('网络失败不清空：保留快照 seed 的行（离线可用）', async () => {
  mockListConversations.mockRejectedValue(new Error('offline'));
  const t = await coldStart(snapshotOf('u1', rows(0, 7)));
  expect(t.get().list).toHaveLength(7);
});

test('直接换账号：上个账号的行当场清掉，分页游标归零（首页仍是 limit=20）', async () => {
  mockListConversations.mockResolvedValueOnce({ conversations: rows(0, 20), hasMore: true, total: 60 });
  const t = await coldStart();
  mockListConversations.mockResolvedValueOnce({ conversations: rows(20, 20), hasMore: true, total: 60 });
  await t.act(async () => {
    await t.get().paging.loadMore();
  });
  expect(t.get().list).toHaveLength(40);

  mockSession = SESSION_2;
  mockListConversations.mockResolvedValueOnce({ conversations: rows(100, 3), hasMore: false, total: 3 });
  await t.rerender();
  expect(mockListConversations).toHaveBeenLastCalledWith(SESSION_2, { limit: 20, offset: 0 });
  expect(t.get().list.map((c) => c.id)).toEqual(rows(100, 3).map((c) => c.id));
});

test('列表变化后防抖落盘，下次冷启动读得到', async () => {
  mockListConversations.mockResolvedValue({ conversations: rows(0, 20), hasMore: true, total: 60 });
  const t = await coldStart();
  await t.act(async () => {
    await new Promise((r) => setTimeout(r, 1200)); // 等过防抖窗
  });
  const raw = await t.AsyncStorage.getItem(SNAPSHOT_KEY);
  expect(raw).not.toBeNull();
  const saved = JSON.parse(raw as string);
  expect(saved.userId).toBe('u1');
  expect(saved.rows).toHaveLength(20);
});
