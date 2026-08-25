/**
 * 协同工作模式布局归一：分桶快照 / 单槽 delta 两种到达形态 + seq 守卫。
 * 这层错了的后果是「agent 开了文档但手机端不分叉」或「旧帧把新布局抹回去」，
 * 都是看不出报错、只能靠肉眼发现的那类 bug，值得钉住。
 */
import {
  EMPTY_COLLAB_LAYOUT,
  applyCollabLayoutPayload,
  collabLayoutEqual,
  collabLayoutFromConversationMeta,
  mobileCollabMode,
  type CollabLayoutState,
} from '../src/utils/collabLayout';

const bucket = (over: Record<string, unknown> = {}) => ({
  active_mode: 'cowriter',
  cowriter: { doc_ids: ['d1', 'd2'], active_doc_id: 'd2' },
  ...over,
});

test('分桶快照：active_mode + 桶内容 → cowriter', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 3, layout: bucket() });
  expect(s).not.toBeNull();
  expect(s!.activeMode).toBe('cowriter');
  expect(s!.cowriter).toEqual({ docIds: ['d1', 'd2'], activeDocId: 'd2' });
  expect(s!.seq).toBe(3);
  expect(mobileCollabMode(s!)).toBe('cowriter');
});

test('分桶快照：active 不在列表里 → 退回首个', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: bucket({ cowriter: { doc_ids: ['a', 'b'], active_doc_id: 'zzz' } }),
  });
  expect(s!.cowriter?.activeDocId).toBe('a');
});

test('分桶快照：active_mode 命中但该桶是空的 → 落到有内容的另一个桶', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: {
      active_mode: 'cowriter',
      cowriter: { doc_ids: [] },
      coplanner: { project_ids: ['p1'], active_project_id: 'p1' },
    },
  });
  expect(s!.activeMode).toBe('coplanner');
  expect(mobileCollabMode(s!)).toBe('coplanner');
});

test('分桶快照：全空 → default（不分叉）', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: { active_mode: 'default' },
  });
  expect(s!.activeMode).toBe('default');
  expect(mobileCollabMode(s!)).toBeNull();
});

test('单槽 delta：只动自己那个 mode，别的桶原样留着', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: {
      active_mode: 'coplanner',
      coplanner: { project_ids: ['p1'], active_project_id: 'p1' },
    },
  })!;
  const next = applyCollabLayoutPayload(base, {
    seq: 2,
    layout: { layout_mode: 'cowriter', doc_ids: ['d9'], active_doc_id: 'd9' },
  })!;
  expect(next.activeMode).toBe('cowriter');
  expect(next.cowriter?.docIds).toEqual(['d9']);
  // coplanner 桶不该被这帧碰到
  expect(next.coplanner?.projectIds).toEqual(['p1']);
});

test('单槽 delta 清空：关掉最后一篇文档 → 让位给还开着的 coplanner', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: {
      active_mode: 'cowriter',
      cowriter: { doc_ids: ['d1'], active_doc_id: 'd1' },
      coplanner: { project_ids: ['p1'], active_project_id: 'p1' },
    },
  })!;
  const next = applyCollabLayoutPayload(base, {
    seq: 2,
    layout: { layout_mode: 'cowriter', doc_ids: [] },
  })!;
  expect(next.cowriter).toBeNull();
  expect(next.activeMode).toBe('coplanner');
});

test('seq 守卫：旧帧 / 同 seq 帧一律丢弃', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 5, layout: bucket() })!;
  expect(
    applyCollabLayoutPayload(base, {
      seq: 4,
      layout: { layout_mode: 'cowriter', doc_ids: ['old'], active_doc_id: 'old' },
    }),
  ).toBeNull();
  expect(applyCollabLayoutPayload(base, { seq: 5, layout: bucket() })).toBeNull();
});

test('hydrate 不看 seq：换回旧会话时整桶快照仍然权威', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 99, layout: bucket() })!;
  const s = applyCollabLayoutPayload(
    base,
    { seq: 2, layout: bucket({ cowriter: { doc_ids: ['x'], active_doc_id: 'x' } }) },
    { hydrate: true },
  );
  expect(s!.cowriter?.docIds).toEqual(['x']);
  expect(s!.seq).toBe(2);
});

test('未知 layout_mode：整帧丢弃，不动本地布局', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 1, layout: bucket() })!;
  expect(
    applyCollabLayoutPayload(base, { seq: 2, layout: { layout_mode: 'copainter' } }),
  ).toBeNull();
});

test('桌面端专属 mode：状态如实记下，但手机端不分叉', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 1, layout: bucket() })!;
  const next = applyCollabLayoutPayload(base, {
    seq: 2,
    layout: { layout_mode: 'cocoder' },
  })!;
  expect(next.activeMode).toBe('cocoder');
  expect(mobileCollabMode(next)).toBeNull();
  // 桶还留着：桌面端切回 cowriter 时不用重新拉
  expect(next.cowriter?.docIds).toEqual(['d1', 'd2']);
});

test('会话 meta 没有布局字段 → 归零（换到普通会话不该留着上一个的文档）', () => {
  expect(collabLayoutFromConversationMeta(undefined, undefined)).toEqual(EMPTY_COLLAB_LAYOUT);
  expect(collabLayoutFromConversationMeta(null, 7)).toEqual(EMPTY_COLLAB_LAYOUT);
});

test('doc_ids 归一：trim / 去空 / 去重保序', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: bucket({ cowriter: { doc_ids: [' a ', '', 'b', 'a'], active_doc_id: ' b ' } }),
  })!;
  expect(s.cowriter?.docIds).toEqual(['a', 'b']);
  expect(s.cowriter?.activeDocId).toBe('b');
});

test('形状相等判定：seq 前进但可见内容没变 → 不该触发重渲染', () => {
  const a = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 1, layout: bucket() })!;
  const b = applyCollabLayoutPayload(a, { seq: 2, layout: bucket() })!;
  expect(collabLayoutEqual(a, b)).toBe(true);
  const c = applyCollabLayoutPayload(b, {
    seq: 3,
    layout: bucket({ cowriter: { doc_ids: ['d1', 'd2'], active_doc_id: 'd1' } }),
  })!;
  expect(collabLayoutEqual(b, c)).toBe(false);
});

test('坏载荷不炸也不改状态', () => {
  const base: CollabLayoutState = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: bucket(),
  })!;
  expect(applyCollabLayoutPayload(base, null)).toBeNull();
  expect(applyCollabLayoutPayload(base, { seq: 2 })).toBeNull();
  expect(applyCollabLayoutPayload(base, { seq: 'x', layout: bucket() })).toBeNull();
  expect(applyCollabLayoutPayload(base, { seq: 2, layout: 'nope' })).toBeNull();
});
