/**
 * 把一批 WS change 幂等地应用到本地行集合（纯函数，供 GridView / useTableRows 共用）。
 * `seq<=appliedSeq` 的变更跳过；按 seq 升序应用；schema_changed 单独回传由上层处理。
 */
import type { Field, RowRecord } from '../types';
import type { RtChange } from './socket';

/** 按 row_order 升序就地插入；无 row_order 则追加。 */
export function insertSortedInPlace(arr: RowRecord[], row: RowRecord) {
  const ro = row.row_order;
  if (ro == null) {
    arr.push(row);
    return;
  }
  const i = arr.findIndex((r) => (r.row_order ?? Number.POSITIVE_INFINITY) > ro);
  if (i < 0) arr.push(row);
  else arr.splice(i, 0, row);
}

export type ApplyResult = {
  /** changed 为 false 时返回原引用（供 setState 短路）。 */
  rows: RowRecord[];
  changed: boolean;
  totalDelta: number;
  maxSeq: number;
  schema: Field[] | null;
};

export function applyRtChanges(
  current: RowRecord[],
  changes: RtChange[],
  appliedSeq: number,
): ApplyResult {
  const relevant = changes.filter((c) => c.seq > appliedSeq).sort((a, b) => a.seq - b.seq);
  if (!relevant.length) {
    return { rows: current, changed: false, totalDelta: 0, maxSeq: appliedSeq, schema: null };
  }

  const next = current.slice();
  let totalDelta = 0;
  let maxSeq = appliedSeq;
  let schema: Field[] | null = null;
  let changed = false;

  for (const ch of relevant) {
    if (ch.seq > maxSeq) maxSeq = ch.seq;
    if (ch.op === 'schema_changed') {
      if (Array.isArray(ch.delta.schema)) schema = ch.delta.schema as Field[];
      continue;
    }
    if (!ch.row_id) continue;
    const i = next.findIndex((r) => r.row_id === ch.row_id);
    if (ch.op === 'delete') {
      if (i >= 0) {
        next.splice(i, 1);
        totalDelta -= 1;
        changed = true;
      }
    } else if (ch.op === 'insert') {
      const row: RowRecord = {
        row_id: ch.row_id,
        data: (ch.delta.data as Record<string, unknown>) ?? {},
        row_order: ch.delta.row_order as number | undefined,
        version: ch.version ?? 0,
      };
      if (i >= 0) {
        next[i] = { ...next[i], ...row };
      } else {
        insertSortedInPlace(next, row);
        totalDelta += 1;
      }
      changed = true;
    } else if (ch.op === 'update') {
      if (i >= 0) {
        next[i] = {
          ...next[i],
          data: (ch.delta.data as Record<string, unknown>) ?? next[i].data,
          version: ch.version ?? next[i].version,
          row_order: (ch.delta.row_order as number | undefined) ?? next[i].row_order,
        };
        changed = true;
      }
    }
  }

  return { rows: changed ? next : current, changed, totalDelta, maxSeq, schema };
}
