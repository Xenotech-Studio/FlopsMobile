/**
 * TaskContext 的本地快照秒开：冷启动首帧 todayTasks 就有行（今日页据此跳过骨架直接画真内容），
 * 换账号不串、网络失败保留、变化后防抖落盘。
 *
 * 与 conversationPaging.test 同款套路：每个用例 resetModules 重来一遍模拟冷启动，
 * React / react-test-renderer / 被测模块必须从同一个注册表 require（否则两份 React →
 * hooks dispatcher 为 null），所以用 createElement 而不是 JSX。
 */
// 没有顶层 import 的文件在 TS 眼里是「全局脚本」，跟别的测试文件同名常量会撞；
// 空 export 把它标成模块，作用域就关起来了。
export {};

const SNAPSHOT_KEY = '@FlopsMobile/taskSnapshot.v1';
const SESSION = { user_id: 'u1', server_base_url: 'https://x/', access_token: 't' };

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../src/context/SessionContext', () => ({
  useSession: () => ({ session: SESSION }),
}));

const mockFetchTasks = jest.fn();
const mockFetchProjects = jest.fn();
jest.mock('../src/taskApi', () => ({
  fetchTasks: (...a: unknown[]) => mockFetchTasks(...a),
  fetchProjects: (...a: unknown[]) => mockFetchProjects(...a),
  updateTask: jest.fn(),
  addTask: jest.fn(),
  deleteTask: jest.fn(),
}));

/** 今日页口径的「今天」：凌晨 4 点前算前一天。取当天 12:00 作为任务时间，
 *  不管测试在几点跑，belong date 都落在 todayDate 上。 */
function todayNoonISO(): string {
  const d = new Date();
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'task',
  project_id: 'p1',
  title: `任务${id}`,
  description: '',
  childrenId: [],
  relPos: { x: 0, y: 0 },
  done: false,
  ismine: true,
  createddatetime: todayNoonISO(),
  lastediteddatetime: todayNoonISO(),
  startdatetime: todayNoonISO(),
  ...extra,
});

const snapshotOf = (userId: string, ids: string[], savedAt = Date.now()) => ({
  v: 1,
  userId,
  savedAt,
  tasks: ids.map((id) => ({
    id,
    type: 'task',
    project_id: 'p1',
    title: `缓存任务${id}`,
    done: false,
    ismine: true,
    startdatetime: todayNoonISO(),
  })),
  projects: [{ id: 'p1', name: '项目一' }],
});

type Probe = {
  todayTasks: { id: string; title: string }[];
  tasks: { id: string }[];
  projects: { id: string; name?: string | null }[];
  tasksEverLoaded: boolean;
  loadTasks: (force?: boolean) => Promise<void>;
  loadProjects: (force?: boolean) => Promise<void>;
};

/** 冷启动一次：清存储 →（可选）预置快照 → 重新 require（触发预热）→ 挂 TaskProvider。 */
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
  const ctxMod = require('../src/context/TaskContext');
  // 等模块顶层那次预热读落地（真实冷启动里它排在 session 恢复之前）
  await new Promise((r) => setTimeout(r, 0));

  /** 每一帧 todayTasks 的条数——首帧非 0 就是「秒开」，今日页不会进骨架分支 */
  const frames: number[] = [];
  let probe: Probe | null = null;
  function Capture() {
    const ctx = ctxMod.useTask();
    frames.push(ctx.todayTasks.length);
    probe = ctx;
    return null;
  }

  await RTR.act(async () => {
    RTR.create(React.createElement(ctxMod.TaskProvider, null, React.createElement(Capture)));
  });

  return {
    frames,
    get: () => probe as unknown as Probe,
    act: (fn: () => Promise<void>) => RTR.act(fn),
    AsyncStorage,
  };
}

beforeEach(() => {
  mockFetchTasks.mockReset();
  mockFetchProjects.mockReset();
  mockFetchProjects.mockResolvedValue([{ id: 'p1', name: '项目一' }]);
});

test('冷启动首帧 todayTasks 就有快照行（不是先空一帧 → 今日页不闪骨架）', async () => {
  mockFetchTasks.mockResolvedValue([task('n1'), task('n2'), task('n3')]);
  const t = await coldStart(snapshotOf('u1', ['c1', 'c2']));

  expect(t.frames[0]).toBe(2); // 首帧就是缓存里那两条
  expect(t.get().todayTasks[0].title).toBe('缓存任务c1');
  expect(t.get().projects[0].name).toBe('项目一'); // 项目名也 seed 了，任务行副标题不空一拍
});

test('快照陈旧（>24h）：照样 seed 首帧，但立刻自己拉一次对账', async () => {
  mockFetchTasks.mockResolvedValue([task('n1')]);
  const stale = snapshotOf('u1', ['c1', 'c2'], Date.now() - 25 * 3600 * 1000);
  const t = await coldStart(stale);
  expect(t.frames[0]).toBe(2); // 陈旧也先画出来（离线时有总比没有强）
  expect(mockFetchTasks).toHaveBeenCalled(); // 不等今日页触发，Provider 自己强刷
  expect(t.get().todayTasks.map((x) => x.id)).toEqual(['n1']);
});

test('快照新鲜时 Provider 不自己发请求（交给页面按需拉）', async () => {
  mockFetchTasks.mockResolvedValue([task('n1')]);
  const t = await coldStart(snapshotOf('u1', ['c1']));
  expect(t.frames[0]).toBe(1);
  expect(mockFetchTasks).not.toHaveBeenCalled();
});

test('没有快照时首帧为空（今日页此时才该画骨架）', async () => {
  mockFetchTasks.mockResolvedValue([task('n1')]);
  const t = await coldStart();
  expect(t.frames[0]).toBe(0);
});

test('快照 user_id 不匹配时不 seed（换账号不闪上个账号的任务）', async () => {
  mockFetchTasks.mockResolvedValue([]);
  const t = await coldStart(snapshotOf('OTHER_USER', ['c1', 'c2']));
  expect(t.frames[0]).toBe(0);
});

test('网络回来后整表替换（对账）', async () => {
  mockFetchTasks.mockResolvedValue([task('n1'), task('n2'), task('n3')]);
  const t = await coldStart(snapshotOf('u1', ['c1', 'c2']));
  await t.act(async () => {
    await t.get().loadTasks(true);
  });
  expect(t.get().todayTasks.map((x) => x.id).sort()).toEqual(['n1', 'n2', 'n3']);
  expect(t.get().tasksEverLoaded).toBe(true);
});

test('网络失败不清空：保留快照 seed 的任务（离线可用）', async () => {
  mockFetchTasks.mockRejectedValue(new Error('offline'));
  const t = await coldStart(snapshotOf('u1', ['c1', 'c2']));
  await t.act(async () => {
    await t.get().loadTasks(true);
  });
  expect(t.get().todayTasks).toHaveLength(2);
  expect(t.get().tasksEverLoaded).toBe(true); // 失败也算跑过，界面能从骨架切到错误条
});

test('任务变化后防抖落盘，下次冷启动读得到（窄行 + 项目名）', async () => {
  mockFetchTasks.mockResolvedValue([task('n1'), task('n2')]);
  const t = await coldStart();
  await t.act(async () => {
    // 今日页挂载时这两个是一起调的
    await Promise.all([t.get().loadTasks(true), t.get().loadProjects(true)]);
  });
  // 防抖计时器要等落盘 effect 提交后才起步，所以另起一个 act 再等窗口
  await t.act(async () => {
    await new Promise((r) => setTimeout(r, 1200));
  });
  const saved = JSON.parse((await t.AsyncStorage.getItem(SNAPSHOT_KEY)) as string);
  expect(saved.userId).toBe('u1');
  expect(saved.tasks.map((x: { id: string }) => x.id).sort()).toEqual(['n1', 'n2']);
  expect(saved.projects[0].name).toBe('项目一');
  // 窄快照：画布字段不该被写进去
  expect(saved.tasks[0]).not.toHaveProperty('relPos');
  expect(saved.tasks[0]).not.toHaveProperty('childrenId');
});
