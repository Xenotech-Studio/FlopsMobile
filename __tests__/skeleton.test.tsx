/**
 * 骨架屏：行数、盒模型与真实 ConversationRow 对齐（换行/改 padding 时这里会先炸），
 * 以及两套主题都有骨架色。
 *
 * 「高度对齐」在 jest 里没有 layout 引擎量不到真实像素，所以改成量**决定高度的那些值**：
 * paddingVertical / 两条文本行盒 / 分割线 —— 它们相等则渲染高度必然相等。
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet } from 'react-native';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
/* 这几个包发的是未编译 ESM / 需要原生侧（reanimated 4 起要 worklets 的 native part），
 * 在 RN preset 的 transformIgnorePatterns 下要么解析不了要么初始化不了。
 * 这组用例测的是**盒模型**（决定行高的那些数），不是扫光动效本身，所以桩掉即可。 */
jest.mock('react-native-linear-gradient', () => 'LinearGradient');
jest.mock('react-native-vector-icons/Ionicons', () => 'Ionicons');
// ConversationRow → ConversationContext → api / SessionContext → lib/srp → @noble/hashes
//（同样是未编译 ESM）。这里只拿 ConversationRow 的样式做基准，用不到真 api / session。
jest.mock('../src/api', () => ({ CONV_LIST_PAGE_SIZE: 20 }));
jest.mock('../src/context/SessionContext', () => ({ useSession: () => ({ session: null }) }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    Easing: { inOut: (fn: unknown) => fn, quad: () => 0 },
    cancelAnimation: () => {},
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => false,
    useSharedValue: (v: unknown) => ({ value: v }),
    withDelay: (_d: number, a: unknown) => a,
    withRepeat: (a: unknown) => a,
    withTiming: (v: unknown) => v,
  };
});

import { ThemeProvider } from '../src/context/ThemeContext';
import {
  ConversationListSkeleton,
  DrawerRecentsSkeleton,
  TodayContentSkeleton,
} from '../src/components/Skeleton';
import { ConversationRow } from '../src/components/ConversationRow';
import { darkColors, lightColors } from '../src/theme/appColors';
import { LIST_ROW_TITLE_SIZE } from '../src/theme/typography';
import { TASK_ROW_MIN_HEIGHT, TASK_ROW_PADDING_VERTICAL } from '../src/theme/layout';

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: Json[] | null;
};

async function render(node: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<ThemeProvider>{node}</ThemeProvider>);
  });
  return tree.toJSON() as unknown as Json;
}

/** 深度优先找第一个 flatten 后带 borderBottomWidth 的节点 = 列表行的外框 */
function findRowBox(node: Json | null): Record<string, number | string> | null {
  if (!node || typeof node !== 'object') return null;
  const flat = StyleSheet.flatten(node.props?.style as never) as Record<string, number | string>;
  if (flat && flat.borderBottomWidth !== undefined && flat.paddingVertical !== undefined) {
    return flat;
  }
  for (const child of node.children ?? []) {
    const hit = findRowBox(child);
    if (hit) return hit;
  }
  return null;
}

function countBy(node: Json | null, pred: (n: Json) => boolean): number {
  if (!node || typeof node !== 'object') return 0;
  let n = pred(node) ? 1 : 0;
  for (const child of node.children ?? []) n += countBy(child, pred);
  return n;
}

/** 骨架行 = 带 borderBottomWidth 的那层 */
const isRow = (n: Json) => {
  const flat = StyleSheet.flatten(n.props?.style as never) as Record<string, unknown>;
  return Boolean(flat && flat.borderBottomWidth !== undefined && flat.paddingVertical !== undefined);
};

/** 占位条 = 用 skeletonBase 上色的那层 */
const isBar = (base: string) => (n: Json) => {
  const flat = StyleSheet.flatten(n.props?.style as never) as Record<string, unknown>;
  return Boolean(flat && flat.backgroundColor === base && flat.overflow === 'hidden');
};

test('count 决定骨架行数', async () => {
  const three = await render(<ConversationListSkeleton count={3} />);
  const seven = await render(<ConversationListSkeleton count={7} />);
  expect(countBy(three, isRow)).toBe(3);
  expect(countBy(seven, isRow)).toBe(7);
});

test('骨架行盒模型与 ConversationRow 逐项相同（改了真实行这里会炸）', async () => {
  const skeleton = findRowBox(await render(<ConversationListSkeleton count={1} />));
  const real = findRowBox(
    await render(<ConversationRow title="随便什么标题" timeLabel="昨天" onPress={() => {}} />)
  );
  expect(skeleton).not.toBeNull();
  expect(real).not.toBeNull();
  for (const key of [
    'paddingVertical',
    'paddingHorizontal',
    'borderBottomWidth',
    'borderBottomColor',
    'flexDirection',
    'alignItems',
    'gap',
  ] as const) {
    expect([key, skeleton![key]]).toEqual([key, real![key]]);
  }
});

test('两条文本行盒 = 字号 × 1.2（真实 Text 的自然行高），行高才对得上', async () => {
  const tree = await render(<ConversationListSkeleton count={1} />);
  const heights: number[] = [];
  const walk = (n: Json | null) => {
    if (!n || typeof n !== 'object') return;
    const flat = StyleSheet.flatten(n.props?.style as never) as Record<string, unknown>;
    if (flat && flat.justifyContent === 'center' && typeof flat.height === 'number') {
      heights.push(flat.height);
    }
    (n.children ?? []).forEach(walk);
  };
  walk(tree);
  expect(heights).toEqual([
    Math.round(LIST_ROW_TITLE_SIZE * 1.2), // 标题行
    Math.round(12 * 1.2), // 时间标签行
  ]);
});

test('占位条用主题骨架色，深浅两套都有（且不是同一个色）', async () => {
  expect(lightColors.skeletonBase).toBeTruthy();
  expect(darkColors.skeletonBase).toBeTruthy();
  expect(lightColors.skeletonBase).not.toBe(darkColors.skeletonBase);
  expect(lightColors.skeletonHighlight).not.toBe(darkColors.skeletonHighlight);

  // 默认（jest 下 useColorScheme 为 light）渲染出来的条应当就是浅色骨架色
  const tree = await render(<ConversationListSkeleton count={2} />);
  expect(countBy(tree, isBar(lightColors.skeletonBase))).toBe(4); // 每行 标题 + 时间 两条
});

test('今日页整页骨架：任务段 + 对话段都在（对话骨架不再被任务 loading 挡掉）', async () => {
  const tree = await render(<TodayContentSkeleton paddingTop={100} taskRows={4} convRows={3} />);
  // 对话行 = 带 borderBottom 的行；任务行 = minHeight 76 的行
  expect(countBy(tree, isRow)).toBe(3);
  const taskRows: Record<string, unknown>[] = [];
  const walk = (n: Json | null) => {
    if (!n || typeof n !== 'object') return;
    const flat = StyleSheet.flatten(n.props?.style as never) as Record<string, unknown>;
    if (flat && flat.minHeight === TASK_ROW_MIN_HEIGHT) taskRows.push(flat);
    (n.children ?? []).forEach(walk);
  };
  walk(tree);
  expect(taskRows).toHaveLength(4);
  // 任务骨架行的盒模型跟 TaskRowContent 对齐
  expect(taskRows[0].paddingVertical).toBe(TASK_ROW_PADDING_VERTICAL);
  expect(taskRows[0].gap).toBe(12);
});

test('整页骨架的 paddingTop 透传（跟真实列表 contentContainerStyle 对齐，替换时不跳）', async () => {
  const tree = await render(<TodayContentSkeleton paddingTop={137} />);
  const outer = StyleSheet.flatten(tree.props?.style as never) as Record<string, unknown>;
  expect(outer.paddingTop).toBe(137);
});

test('抽屉 Recents 骨架：每行一条，行内 padding 与 MenuRow 一致', async () => {
  const tree = await render(<DrawerRecentsSkeleton count={5} />);
  expect(countBy(tree, isBar(lightColors.skeletonBase))).toBe(5);
  const rows: Record<string, unknown>[] = [];
  const walk = (n: Json | null) => {
    if (!n || typeof n !== 'object') return;
    const flat = StyleSheet.flatten(n.props?.style as never) as Record<string, unknown>;
    if (flat && flat.paddingVertical === 12 && flat.paddingHorizontal === 12) rows.push(flat);
    (n.children ?? []).forEach(walk);
  };
  walk(tree);
  expect(rows).toHaveLength(5); // MenuRow 的 paddingVertical/Horizontal 都是 12
});
