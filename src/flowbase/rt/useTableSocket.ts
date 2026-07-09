/**
 * useTableSocket —— TableSocket 生命周期 + presence（在场感知），供 GridView / useTableRows 共用。
 * 回调走 ref，effect 只依赖 [session, tableId, enabled]，避免父组件重渲染导致 WS 频繁重连。
 *
 * presence 对齐 Desktop `useFlowBaseRealtime.js`：精确到单元格 `{row_id, field_id}` + `editing`，
 * 颜色由 client_id 派生（跨端同色）。派生 `occupantAt(row,field)`（每格代表协作者：编辑态优先、
 * 同态取最近）供网格画彩色边框+角标；`presenceByRow` 供看板/日历卡片做「这行有没有人」。
 * 心跳重播本端 presence（保活 + 防对端 stale-prune），并做兜底 stale 清理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../../api';
import { TableSocket, type PresencePayload, type RtCell, type RtChange, type RtPresence } from './socket';
import { colorForClient } from '../fields/presenceColor';

export type Collaborator = {
  client_id: string;
  user_id: string | null;
  color: string;
  cell: RtCell | null;
  editing: boolean;
  value: string | null;
  lastSeen: number;
};

const HEARTBEAT_MS = 8000; // 周期重播本端 presence
const STALE_MS = 24000; // 超过此时长没再收到某人 presence → 判离（兜底 leave 丢失）
const cellKey = (rowId: string, fieldId: string) => `${rowId} ${fieldId}`;

export type UseTableSocketArgs = {
  session: Session | null;
  tableId: string;
  enabled?: boolean;
  getSeq: () => number;
  onChange: (changes: RtChange[], meta: { catchup?: boolean; reload?: boolean }) => void;
  snapshotReadyRef: React.MutableRefObject<boolean>;
};

export function useTableSocket({
  session,
  tableId,
  enabled = true,
  getSeq,
  onChange,
  snapshotReadyRef,
}: UseTableSocketArgs) {
  const [collaborators, setCollaborators] = useState<Record<string, Collaborator>>({});
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<TableSocket | null>(null);
  const clientIdRef = useRef('');
  const myPresenceRef = useRef<PresencePayload | null>(null); // 最近一次本端 presence（供心跳/重连/查询回放）
  const onChangeRef = useRef(onChange);
  const getSeqRef = useRef(getSeq);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    getSeqRef.current = getSeq;
  }, [getSeq]);

  const upsertPresence = useCallback((p: RtPresence) => {
    if (!p.client_id || p.client_id === clientIdRef.current) return; // 忽略自身回声
    setCollaborators((prev) => ({
      ...prev,
      [p.client_id]: {
        client_id: p.client_id,
        user_id: p.user_id ?? null,
        color: colorForClient(p.client_id),
        cell: p.cell ?? null,
        editing: !!p.editing,
        value: p.value != null ? String(p.value) : null,
        lastSeen: Date.now(),
      },
    }));
  }, []);

  useEffect(() => {
    if (!session || !enabled) return;
    const sock = new TableSocket(session, tableId, () => getSeqRef.current(), {
      onHello: (_seq, clientId) => {
        clientIdRef.current = clientId;
        sock.sendPresenceQuery(); // 请在场者各自重播 presence
        if (myPresenceRef.current) sock.sendPresence(myPresenceRef.current); // 重播自己
      },
      onChange: (c, m) => onChangeRef.current(c, m),
      onPresence: (p) => upsertPresence(p),
      onPresenceQuery: () => {
        if (myPresenceRef.current) sock.sendPresence(myPresenceRef.current); // 有人加入 → 重播本端
      },
      onPresenceLeave: (p) =>
        setCollaborators((prev) => {
          if (!prev[p.client_id]) return prev;
          const next = { ...prev };
          delete next[p.client_id];
          return next;
        }),
      onStatus: setConnected,
    });
    socketRef.current = sock;
    if (snapshotReadyRef.current) sock.markReady();
    sock.connect();

    const heartbeat = setInterval(() => {
      if (myPresenceRef.current) sock.sendPresence(myPresenceRef.current);
    }, HEARTBEAT_MS);
    const prune = setInterval(() => {
      const cutoff = Date.now() - STALE_MS;
      setCollaborators((prev) => {
        let changed = false;
        const next: Record<string, Collaborator> = {};
        for (const [cid, c] of Object.entries(prev)) {
          if (c.lastSeen >= cutoff) next[cid] = c;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      clearInterval(prune);
      sock.close();
      socketRef.current = null;
      setConnected(false);
      setCollaborators({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, tableId, enabled, upsertPresence]);

  const markReady = useCallback(() => socketRef.current?.markReady(), []);
  const sendPresence = useCallback((payload: PresencePayload) => {
    myPresenceRef.current = payload.cell ? payload : null; // 离开时清空 → 心跳停播
    socketRef.current?.sendPresence(payload);
  }, []);

  // 每格代表协作者：编辑态优先于选中态；同态取最近 lastSeen。
  const occupancy = useMemo(() => {
    const map = new Map<string, Collaborator>();
    for (const c of Object.values(collaborators)) {
      if (!c.cell || !c.cell.row_id || !c.cell.field_id) continue;
      const k = cellKey(c.cell.row_id, c.cell.field_id);
      const cur = map.get(k);
      if (!cur) map.set(k, c);
      else if (c.editing && !cur.editing) map.set(k, c);
      else if (!!c.editing === !!cur.editing && c.lastSeen > cur.lastSeen) map.set(k, c);
    }
    return map;
  }, [collaborators]);

  const occupantAt = useCallback(
    (rowId: string, fieldId: string): Collaborator | null => occupancy.get(cellKey(rowId, fieldId)) ?? null,
    [occupancy],
  );

  // 按行聚合（看板/日历卡片：这行是否有人在看/编辑）
  const presenceByRow = useMemo(() => {
    const m: Record<string, Collaborator[]> = {};
    for (const c of Object.values(collaborators)) {
      if (c.cell?.row_id) (m[c.cell.row_id] ??= []).push(c);
    }
    return m;
  }, [collaborators]);

  return { connected, occupancy, occupantAt, presenceByRow, markReady, sendPresence };
}
