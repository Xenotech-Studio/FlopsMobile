/**
 * 对话行右侧指示器的优先级：agent 在跑 / 后台任务在跑 → 转圈；都不跑但未读 → 对勾。
 * 两条「在跑」来源互相独立（见 bgTaskRunning.test），这里只盯渲染分支。
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
    if (n.type === 'InboxRunSpinner' || n.type === 'InboxUnreadCheck') found.push(n.type);
    (n.children ?? []).forEach(walk);
  };
  walk(tree.toJSON() as unknown as Json);
  return found;
}

test('agent 在跑 → 转圈', async () => {
  expect(await indicatorOf({ running: true })).toEqual(['InboxRunSpinner']);
});

test('后台任务在跑（agent 没跑）→ 一样转圈，这正是之前手机上什么都不显示的那种情况', async () => {
  expect(await indicatorOf({ bgRunning: true })).toEqual(['InboxRunSpinner']);
});

test('两者都在跑 → 只画一个转圈', async () => {
  expect(await indicatorOf({ running: true, bgRunning: true })).toEqual(['InboxRunSpinner']);
});

test('在跑压过未读（后台任务在跑时不画对勾）', async () => {
  expect(await indicatorOf({ bgRunning: true, unread: true })).toEqual(['InboxRunSpinner']);
});

test('都不跑但未读 → 对勾', async () => {
  expect(await indicatorOf({ unread: true })).toEqual(['InboxUnreadCheck']);
});

test('都没有 → 不画指示器', async () => {
  expect(await indicatorOf({})).toEqual([]);
});
