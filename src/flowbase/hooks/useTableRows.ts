/**
 * useTableRows —— 一次性拉全表行（看板/日历这类需要全量的视图用）+ WS 实时 + presence + 命令式补丁。
 * 与 GridView 共用 applyRtChanges / useTableSocket；GridView 自己走分页故不用此 hook。
 * 注：单次查询上限 1000 行（后端约束），超大表在看板/日历里只覆盖前 1000 行（P2 可接受）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { queryRows } from '../api';
import type { Field, RowRecord } from '../types';
import { applyRtChanges } from '../rt/applyChanges';
import { useTableSocket } from '../rt/useTableSocket';
import type { RtChange } from '../rt/socket';

const FULL_LIMIT = 1000;

export function useTableRows(
  baseId: string,
  tableId: string,
  opts?: { schema?: Field[]; onSchemaChanged?: (schema: Field[]) => void },
) {
  const { session } = useSession();
  const onSchemaChanged = opts?.onSchemaChanged;
  const primaryFieldId = opts?.schema?.[0]?.id; // 代表格：presence 广播用（卡片视图无单元格粒度）

  const [rows, setRows] = useState<RowRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const rowsRef = useRef<RowRecord[]>([]);
  const snapshotReadyRef = useRef(false);
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const applyChanges = useCallback(
    (changes: RtChange[], meta: { catchup?: boolean; reload?: boolean }) => {
      if (meta.reload) {
        loadRef.current();
        return;
      }
      const res = applyRtChanges(rowsRef.current, changes, seqRef.current);
      seqRef.current = res.maxSeq;
      if (res.changed) setRows(res.rows);
      if (res.schema) onSchemaChanged?.(res.schema);
    },
    [onSchemaChanged],
  );

  const getSeq = useCallback(() => seqRef.current, []);
  const { connected, occupantAt, presenceByRow, sendPresence, markReady } = useTableSocket({
    session,
    tableId,
    getSeq,
    onChange: applyChanges,
    snapshotReadyRef,
  });

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const res = await queryRows(session, baseId, tableId, { limit: FULL_LIMIT, offset: 0 });
      setRows(res.rows);
      seqRef.current = res.seq;
      snapshotReadyRef.current = true;
      markReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session, baseId, tableId, markReady]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    setRows([]);
    load();
  }, [load]);

  const applyRowUpdate = useCallback(
    (row: RowRecord) =>
      setRows((prev) => prev.map((r) => (r.row_id === row.row_id ? { ...r, ...row } : r))),
    [],
  );
  const prependRow = useCallback((row: RowRecord) => setRows((prev) => [row, ...prev]), []);
  const removeRow = useCallback(
    (rowId: string) => setRows((prev) => prev.filter((r) => r.row_id !== rowId)),
    [],
  );
  const setLocalPresence = useCallback(
    (rowId: string | null) =>
      sendPresence({
        cell: rowId && primaryFieldId ? { row_id: rowId, field_id: primaryFieldId } : null,
        editing: false,
      }),
    [sendPresence, primaryFieldId],
  );

  return {
    rows,
    loading,
    error,
    refresh: useCallback(() => loadRef.current(), []),
    connected,
    occupantAt,
    presenceByRow,
    applyRowUpdate,
    prependRow,
    removeRow,
    setLocalPresence,
  };
}
