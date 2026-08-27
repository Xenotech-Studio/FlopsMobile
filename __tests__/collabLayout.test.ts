/**
 * 协同工作模式布局归一：分桶快照 / 单槽 delta 两种到达形态 + seq 守卫。
 * 这层错了的后果是「agent 开了文档但手机端不分叉」或「旧帧把新布局抹回去」，
 * 都是看不出报错、只能靠肉眼发现的那类 bug，值得钉住。
 */
import {
  EMPTY_COLLAB_LAYOUT,
  activeCollabTabKey,
  applyCollabLayoutPayload,
  collabLayoutActive,
  collabLayoutEqual,
  collabLayoutFromConversationMeta,
  collabTabs,
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
  expect(collabLayoutActive(s!)).toBe(true);
  expect(activeCollabTabKey(s!)).toBe('cowriter:d2');
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
  expect(activeCollabTabKey(s!)).toBe('coplanner:p1');
});

test('分桶快照：全空 → default（不分叉）', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: { active_mode: 'default' },
  });
  expect(s!.activeMode).toBe('default');
  expect(collabLayoutActive(s!)).toBe(false);
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

test('内容暂不支持的 mode：仍留在协同布局里，走马灯停到它那页占位', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 1, layout: bucket() })!;
  const next = applyCollabLayoutPayload(base, {
    seq: 2,
    layout: { layout_mode: 'cocoder' },
  })!;
  expect(next.activeMode).toBe('cocoder');
  // 闸门放宽后不再退回普通聊天页：滑一下还能滑回刚才那两篇文档
  expect(collabLayoutActive(next)).toBe(true);
  expect(activeCollabTabKey(next)).toBe('cocoder:');
  // 桶还留着：桌面端切回 cowriter 时不用重新拉
  expect(next.cowriter?.docIds).toEqual(['d1', 'd2']);
});

test('闸门：桶全空但 active_mode 命中协同 mode → 照样分叉（只有占位页）', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: { active_mode: 'cobrowser' },
  })!;
  expect(collabLayoutActive(s)).toBe(true);
  expect(activeCollabTabKey(s)).toBe('cobrowser:');
  expect(collabTabs(s).map((t) => t.key)).toEqual(['cocoder:', 'cobrowser:']);
});

test('走马灯序列：两桶铺开 + cocoder/cobrowser 各一项占位，顺序固定', () => {
  const s = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: bucket({ coplanner: { project_ids: ['p1', 'p2'], active_project_id: 'p2' } }),
  })!;
  expect(collabTabs(s)).toEqual([
    { mode: 'cowriter', id: 'd1', key: 'cowriter:d1' },
    { mode: 'cowriter', id: 'd2', key: 'cowriter:d2' },
    { mode: 'coplanner', id: 'p1', key: 'coplanner:p1' },
    { mode: 'coplanner', id: 'p2', key: 'coplanner:p2' },
    { mode: 'cocoder', id: '', key: 'cocoder:' },
    { mode: 'cobrowser', id: '', key: 'cobrowser:' },
  ]);
});

test('跟随目标是 (mode, id) 二元组：同 mode 内换焦点文档也要跳', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, { seq: 1, layout: bucket() })!;
  expect(activeCollabTabKey(base)).toBe('cowriter:d2');
  const next = applyCollabLayoutPayload(base, {
    seq: 2,
    layout: { layout_mode: 'cowriter', doc_ids: ['d1', 'd2'], active_doc_id: 'd1' },
  })!;
  expect(activeCollabTabKey(next)).toBe('cowriter:d1');
});

test('桶清空：该 mode 的 tab 全消失，焦点落到仍存在的项', () => {
  const base = applyCollabLayoutPayload(EMPTY_COLLAB_LAYOUT, {
    seq: 1,
    layout: bucket({ coplanner: { project_ids: ['p1'], active_project_id: 'p1' } }),
  })!;
  const next = applyCollabLayoutPayload(base, {
    seq: 2,
    layout: { layout_mode: 'cowriter', doc_ids: [] },
  })!;
  expect(collabTabs(next).map((t) => t.key)).toEqual(['coplanner:p1', 'cocoder:', 'cobrowser:']);
  expect(activeCollabTabKey(next)).toBe('coplanner:p1');
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
