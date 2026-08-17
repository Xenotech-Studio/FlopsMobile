/**
 * 会话列表本地快照（utils/conversationSnapshot）的行为约定：
 * 预热后可同步读、按 user_id 隔离、行数截断、防抖只写最终态、登出清空。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const SNAPSHOT_KEY = '@FlopsMobile/convSnapshot.v1';
const LEGACY_KEY = '@FlopsMobile/cachedConversations';

const rows = (n: number, prefix = 'c') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `t${i}` }));

/** 每个用例都要一份「刚 import 完（= 冷启动预热刚跑完）」的模块实例。 */
async function freshModule() {
  let mod!: typeof import('../src/utils/conversationSnapshot');
  jest.isolateModules(() => {
    mod = require('../src/utils/conversationSnapshot');
  });
  // 预热是模块顶层的一次异步读，await 掉它（ensureSnapshot 内部等的就是这个 promise）
  await mod.ensureSnapshot('__warmup__');
  return mod;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useRealTimers();
});

test('预热后可同步读出上次快照', async () => {
  await AsyncStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({ v: 1, userId: 'u1', savedAt: Date.now(), rows: rows(3), running: {}, unread: { c1: true } })
  );
  const mod = await freshModule();
  const snap = mod.readSnapshotSync('u1');
  expect(snap?.rows).toHaveLength(3);
  expect(snap?.unread).toEqual({ c1: true });
});

test('user_id 对不上不认（换账号不串标题）', async () => {
  await AsyncStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({ v: 1, userId: 'u1', savedAt: Date.now(), rows: rows(3), running: {}, unread: {} })
  );
  const mod = await freshModule();
  expect(mod.readSnapshotSync('u2')).toBeNull();
});

test('旧版裸数组缓存不误读，且启动时被清掉', async () => {
  await AsyncStorage.setItem(LEGACY_KEY, JSON.stringify(rows(5)));
  const mod = await freshModule();
  expect(mod.readSnapshotSync('u1')).toBeNull();
  expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
});

test('陈旧判定：>24h 为 stale', async () => {
  const mod = await freshModule();
  const fresh = mod.buildSnapshot('u1', rows(2), {}, {});
  expect(mod.isSnapshotStale(fresh)).toBe(false);
  expect(mod.isSnapshotStale({ ...fresh, savedAt: Date.now() - 25 * 3600 * 1000 })).toBe(true);
  expect(mod.isSnapshotStale(null)).toBe(true);
});

test('buildSnapshot 截到 SNAPSHOT_MAX_ROWS，map 只留保留行的 true 项', async () => {
  const mod = await freshModule();
  const all = rows(100);
  const snap = mod.buildSnapshot(
    'u1',
    all,
    { c0: true, c90: true },
    { c1: true, c95: true, cX: true }
  );
  expect(snap.rows).toHaveLength(mod.SNAPSHOT_MAX_ROWS);
  expect(snap.running).toEqual({ c0: true }); // c90 已被截掉
  expect(snap.unread).toEqual({ c1: true }); // c95 / 不存在的 cX 都不进
});

test('防抖落盘：窗口内多次调用只写一次，且写的是最终态', async () => {
  jest.useFakeTimers();
  const mod = await freshModule();
  mod.schedulePersistSnapshot(() => mod.buildSnapshot('u1', rows(1), {}, {}));
  mod.schedulePersistSnapshot(() => mod.buildSnapshot('u1', rows(2), {}, {}));
  mod.schedulePersistSnapshot(() => mod.buildSnapshot('u1', rows(3), {}, {}));
  expect(await AsyncStorage.getItem(SNAPSHOT_KEY)).toBeNull(); // 还没到点
  jest.runAllTimers();
  jest.useRealTimers();
  const raw = await AsyncStorage.getItem(SNAPSHOT_KEY);
  expect(JSON.parse(raw as string).rows).toHaveLength(3);
  // 写完立刻可同步读到（内存镜像同步更新，不用等下次冷启动）
  expect(mod.readSnapshotSync('u1')?.rows).toHaveLength(3);
});

test('clearSnapshot：清内存 + 清盘 + 撤销待写', async () => {
  jest.useFakeTimers();
  const mod = await freshModule();
  mod.schedulePersistSnapshot(() => mod.buildSnapshot('u1', rows(3), {}, {}));
  jest.runAllTimers();
  jest.useRealTimers();
  expect(mod.readSnapshotSync('u1')).not.toBeNull();

  mod.clearSnapshot();
  expect(mod.readSnapshotSync('u1')).toBeNull();
  await Promise.resolve();
  expect(await AsyncStorage.getItem(SNAPSHOT_KEY)).toBeNull();
});
