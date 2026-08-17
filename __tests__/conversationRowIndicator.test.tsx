/**
 * 对话行右侧指示器：三种状态三个图标，且优先级固定。
 *   agent 在跑        → 转圈 InboxRunSpinner
 *   后台任务在跑      → 时钟 InboxBgTaskIcon（**不能**也用转圈，那会让人以为 agent 在答）
 *   都不跑但未读      → 对勾 InboxUnreadCheck
 * 优先级 running > bgRunning > unread，与 Desktop 的 tab 一致（ChatTab.jsx）。
 * 两条「在跑」的数据来源互相独立，见 bgTaskRunning.test；这里只盯渲染分支。
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('react-native-vector-icons/Ionicons', () => 'Ionicons');
// ConversationRow → useRowTapGuard → ConversationContext → api / SessionContext（未编译 ESM 链）
jest.mock('../src/api', () => ({ CONV_LIST_PAGE_SIZE: 20 }));
jest.mock('../src/context/SessionContext', () => ({ useSession: () => ({ session: null }) }));
jest.mock('../src/components/InboxListIndicators', () => ({
  InboxRunSpinner: 'InboxRunSpinner',
  InboxBgTaskIcon: 'InboxBgTaskIcon',
  InboxUnreadCheck: 'InboxUnreadCheck',
}));

import { ThemeProvider } from '../src/context/ThemeContext';
import { ConversationRow } from '../src/components/ConversationRow';

type Json = { type: string; children: Json[] | null };

async function indicatorOf(props: { running?: boolean; bgRunning?: boolean; unread?: boolean }) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ThemeProvider>
        <ConversationRow title="随便什么标题" onPress={() => {}} {...props} />
      </ThemeProvider>
    );
  });
  const found: string[] = [];
  const walk = (n: Json | null) => {
    if (!n || typeof n !== 'object') return;
    if (
      n.type === 'InboxRunSpinner' ||
      n.type === 'InboxBgTaskIcon' ||
      n.type === 'InboxUnreadCheck'
    ) {
      found.push(n.type);
    }
    (n.children ?? []).forEach(walk);
  };
  walk(tree.toJSON() as unknown as Json);
  return found;
}

test('agent 在跑 → 转圈', async () => {
  expect(await indicatorOf({ running: true })).toEqual(['InboxRunSpinner']);
});

test('后台任务在跑（agent 没跑）→ 专用时钟图标，不是转圈', async () => {
  // 语义不同就必须长得不同：转圈 = agent 正在答（人在等），时钟 = 只是挂着后台任务。
  expect(await indicatorOf({ bgRunning: true })).toEqual(['InboxBgTaskIcon']);
});

test('agent 在跑压过后台任务：两者都真时画转圈（与 Desktop tab 优先级一致）', async () => {
  expect(await indicatorOf({ running: true, bgRunning: true })).toEqual(['InboxRunSpinner']);
});

test('后台任务在跑压过未读（不画对勾）', async () => {
  expect(await indicatorOf({ bgRunning: true, unread: true })).toEqual(['InboxBgTaskIcon']);
});

test('三者同真：只画优先级最高的转圈', async () => {
  expect(await indicatorOf({ running: true, bgRunning: true, unread: true })).toEqual([
    'InboxRunSpinner',
  ]);
});

test('都不跑但未读 → 对勾', async () => {
  expect(await indicatorOf({ unread: true })).toEqual(['InboxUnreadCheck']);
});

test('都没有 → 不画指示器', async () => {
  expect(await indicatorOf({})).toEqual([]);
});
