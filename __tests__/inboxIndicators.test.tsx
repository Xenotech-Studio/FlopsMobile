/**
 * 三个指示器组件本身的冒烟测试：能挂载、结构是预期的那一个。
 *
 * jest 里量不到「有没有真的在转」（没有 UI 线程、没有布局），所以这里只钉住**结构**：
 * 转圈是一个带旋转样式的 Animated.View、时钟是 Ionicons time-outline、对勾是 ✓ 文本。
 * 动画本身只能真机验。加这一层是因为转圈曾经悄悄坏过一次（旧实现每次 render 重挂插值节点，
 * 在随 SSE 每帧重渲染的列表里就定住不动了），而 ConversationRow 的用例把这三个组件都 mock 掉了，
 * 谁也发现不了。
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('react-native-vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    Easing: { linear: 'linear' },
    cancelAnimation: jest.fn(),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useSharedValue: (v: number) => ({ value: v }),
    withRepeat: (a: unknown) => a,
    withTiming: (v: number) => v,
  };
});

import { ThemeProvider } from '../src/context/ThemeContext';
import {
  InboxBgTaskIcon,
  InboxRunSpinner,
  InboxUnreadCheck,
} from '../src/components/InboxListIndicators';

type Json = { type: string; props: Record<string, unknown>; children: Json[] | null };

async function renderIndicator(node: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return tree.toJSON() as unknown as Json;
}

function findByType(node: Json | null, type: string): Json | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const c of node.children ?? []) {
    const hit = findByType(c, type);
    if (hit) return hit;
  }
  return null;
}

test('转圈：挂载后带 rotate 变换（动画本身要真机看）', async () => {
  const tree = await renderIndicator(<InboxRunSpinner />);
  const { StyleSheet } = require('react-native');
  const flat = StyleSheet.flatten(tree.props?.style as never) as Record<string, unknown>;
  expect(flat.width).toBe(14);
  expect(flat.borderRadius).toBe(7);
  // useAnimatedStyle 的返回值被 mock 直接求值，transform 应当带上 rotate
  expect(JSON.stringify(flat.transform)).toContain('rotate');
});

test('时钟：用 Ionicons 的 time-outline，不是转圈', async () => {
  const tree = await renderIndicator(<InboxBgTaskIcon />);
  const icon = findByType(tree, 'Ionicons');
  expect(icon).not.toBeNull();
  expect(icon!.props.name).toBe('time-outline');
  // 浅色主题下用 Desktop 那个蓝（.conversation-tab-task-icon）
  expect(icon!.props.color).toBe('#2563eb');
});

test('对勾：绿色 ✓', async () => {
  const tree = await renderIndicator(<InboxUnreadCheck />);
  const flatten = (n: Json | null): string => {
    if (!n) return '';
    if (typeof n === 'string') return n;
    return (n.children ?? []).map(flatten).join('');
  };
  expect(flatten(tree)).toContain('✓');
});
