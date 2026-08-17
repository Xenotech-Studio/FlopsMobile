/**
 * 任务本地快照（utils/taskSnapshot）的行为约定：预热后可同步读、按 user_id 隔离、
 * 窄行读出来要还原成形状完整的 TaskItem、今日任务优先且截断、防抖只写最终态、登出清空。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const SNAPSHOT_KEY = '@FlopsMobile/taskSnapshot.v1';
const LEGACY_TASKS_KEY = '@FlopsMobile/cachedTasks';
const LEGACY_PROJECTS_KEY = '@FlopsMobile/cachedProjects';

type AnyTask = Record<string, unknown>;

/** 造一条「胖」任务（带画布字段），用来验证窄快照确实把它们丢掉了 */
const fatTask = (id: string, extra: AnyTask = {}): AnyTask => ({
  id,
  type: 'task',
  project_id: 'p1',
  title: `任务${id}`,
  description: 'x'.repeat(500),
  childrenId: ['a', 'b', 'c'],
  relPos: { x: 12, y: 34 },
  choreZone: { big: 'payload' },
  done: false,
  ismine: true,
  createddatetime: '2026-08-01T10:00:00Z',
  lastediteddatetime: '2026-08-02T10:00:00Z',
  ...extra,
});

/** 每个用例都要一份「刚 import 完（= 冷启动预热刚跑完）」的模块实例。 */
async function freshModule() {
  let mod!: typeof import('../src/utils/taskSnapshot');
  jest.isolateModules(() => {
    mod = require('../src/utils/taskSnapshot');
  });
  // 预热是模块顶层的一次异步读，让出一轮事件循环等它落地
  await new Promise((r) => setTimeout(r, 0));
  return mod;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useRealTimers();
});

test('预热后可同步读出上次快照', async () => {
  await AsyncStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({
      v: 1,
      userId: 'u1',
      savedAt: Date.now(),
      tasks: [{ id: 't1', type: 'task', project_id: 'p1', title: '写代码', done: false, ismine: true }],
      projects: [{ id: 'p1', name: '项目一' }],
    })
  );
  const mod = await freshModule();
  const snap = mod.readTaskSnapshotSync('u1');
  expect(snap?.tasks).toHaveLength(1);
  expect(snap?.tasks[0].title).toBe('写代码');
  expect(snap?.projects[0].name).toBe('项目一');
  expect(snap?.stale).toBe(false);
});

test('窄行读出来是形状完整的 TaskItem（画布字段补安全默认值，不会崩）', async () => {
  const mod = await freshModule();
  const snap = mod.buildTaskSnapshot('u1', [fatTask('t1') as never], [], []);
  // 存的时候胖字段被丢掉
  expect(snap.tasks[0]).not.toHaveProperty('description');
  expect(snap.tasks[0]).not.toHaveProperty('choreZone');

  await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  const mod2 = await freshModule();
  const restored = mod2.readTaskSnapshotSync('u1')!.tasks[0];
  // 读回来结构性字段一定在（项目页画布会直接读 relPos.x / childrenId.length）
  expect(restored.relPos).toEqual({ x: 0, y: 0 });
  expect(restored.childrenId).toEqual([]);
  expect(restored.description).toBe('');
  expect(restored.title).toBe('任务t1');
});

test('user_id 对不上不认（换账号不串任务）', async () => {
  await AsyncStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({ v: 1, userId: 'u1', savedAt: Date.now(), tasks: [], projects: [] })
  );
  const mod = await freshModule();
  expect(mod.readTaskSnapshotSync('u2')).toBeNull();
});

test('旧的只写不读缓存（cachedTasks / cachedProjects）启动时被清掉', async () => {
  await AsyncStorage.setItem(LEGACY_TASKS_KEY, JSON.stringify([fatTask('t1')]));
  await AsyncStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify([{ id: 'p1' }]));
  await freshModule();
  expect(await AsyncStorage.getItem(LEGACY_TASKS_KEY)).toBeNull();
  expect(await AsyncStorage.getItem(LEGACY_PROJECTS_KEY)).toBeNull();
});

test('陈旧判定：>24h 的快照照样返回，但标 stale', async () => {
  await AsyncStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({
      v: 1,
      userId: 'u1',
      savedAt: Date.now() - 25 * 3600 * 1000,
      tasks: [{ id: 't1', type: 'task', project_id: 'p1', title: 'x', done: false, ismine: true }],
      projects: [],
    })
  );
  const mod = await freshModule();
  const snap = mod.readTaskSnapshotSync('u1');
  expect(snap?.tasks).toHaveLength(1); // 仍然显示（离线有总比没有强）
  expect(snap?.stale).toBe(true); // 但调用方据此立刻强刷
});

test('今日任务排最前：截断时先丢的一定不是今日页要画的', async () => {
  const mod = await freshModule();
  const all = Array.from({ length: mod.SNAPSHOT_MAX_TASKS + 50 }, (_, i) => fatTask(`t${i}`));
  const todays = [fatTask('today-a'), fatTask('today-b')];
  const snap = mod.buildTaskSnapshot('u1', all as never, todays as never, []);
  expect(snap.tasks).toHaveLength(mod.SNAPSHOT_MAX_TASKS);
  expect(snap.tasks[0].id).toBe('today-a');
  expect(snap.tasks[1].id).toBe('today-b');
});

test('今日任务同时也在全量里时不重复存', async () => {
  const mod = await freshModule();
  const shared = fatTask('t1');
  const snap = mod.buildTaskSnapshot('u1', [shared, fatTask('t2')] as never, [shared] as never, []);
  expect(snap.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
});

test('防抖落盘：窗口内多次调用只写一次，且写的是最终态', async () => {
  // 先等预热（它自己就靠 setTimeout 让路），再切假定时器——顺序反了预热永远醒不过来
  const mod = await freshModule();
  jest.useFakeTimers();
  mod.schedulePersistTaskSnapshot(() => mod.buildTaskSnapshot('u1', [fatTask('a')] as never, [], []));
  mod.schedulePersistTaskSnapshot(() =>
    mod.buildTaskSnapshot('u1', [fatTask('a'), fatTask('b')] as never, [], [])
  );
  expect(await AsyncStorage.getItem(SNAPSHOT_KEY)).toBeNull(); // 还没到点
  jest.runAllTimers();
  jest.useRealTimers();
  const saved = JSON.parse((await AsyncStorage.getItem(SNAPSHOT_KEY)) as string);
  expect(saved.tasks).toHaveLength(2);
  // 写完立刻可同步读到（内存镜像同步更新）
  expect(mod.readTaskSnapshotSync('u1')?.tasks).toHaveLength(2);
});

test('clearTaskSnapshot：清内存 + 清盘 + 撤销待写', async () => {
  const mod = await freshModule();
  jest.useFakeTimers();
  mod.schedulePersistTaskSnapshot(() => mod.buildTaskSnapshot('u1', [fatTask('a')] as never, [], []));
  jest.runAllTimers();
  jest.useRealTimers();
  expect(mod.readTaskSnapshotSync('u1')).not.toBeNull();

  mod.clearTaskSnapshot();
  expect(mod.readTaskSnapshotSync('u1')).toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(await AsyncStorage.getItem(SNAPSHOT_KEY)).toBeNull();
});
