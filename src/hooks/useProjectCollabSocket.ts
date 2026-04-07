import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskApiAuth } from '../taskApi';
import { buildProjectWebSocketUrl } from '../taskApi';
import { getOrCreateClientInstanceId } from '../utils/clientInstanceId';
import { sha256Hex } from '../utils/sha256Hex';

export const REMOTE_PROJECT_RELOAD_DEBOUNCE_MS = 220;
export const PROJECT_WS_RECONNECT_MS = 1500;

export type RemoteCollabSession = {
  client_instance_id?: string;
  user_id?: string;
  kind?: string;
  task_id?: string;
  task_ids?: string[];
};

function pickStr(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const s = String(c);
    if (s) return s;
  }
  return undefined;
}

/** 服务端/历史载荷可能用 camelCase 或把动作放在 type 上 */
function normalizeRemoteSession(raw: unknown): RemoteCollabSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userNested =
    r.user && typeof r.user === 'object' && !Array.isArray(r.user)
      ? pickStr(
          (r.user as Record<string, unknown>).id,
          (r.user as Record<string, unknown>).user_id,
          (r.user as Record<string, unknown>).userId
        )
      : undefined;
  const client_instance_id = pickStr(
    r.client_instance_id,
    r.clientInstanceId,
    r.instance_id,
    r.instanceId,
    r.socket_client_id,
    r.client_id,
    r.clientId
  );
  const user_id = pickStr(
    r.user_id,
    r.userId,
    r.uid,
    userNested,
    typeof r.user === 'string' ? r.user : undefined
  );
  const task_id = pickStr(r.task_id, r.taskId);
  const ti = r.task_ids ?? r.taskIds;
  const task_ids = Array.isArray(ti) ? ti.map((x) => String(x)).filter(Boolean) : undefined;
  const kind = pickStr(r.kind, r.type);
  return {
    client_instance_id,
    user_id,
    kind,
    task_id,
    task_ids,
  };
}

function normalizeSessionList(raw: unknown): RemoteCollabSession[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeRemoteSession).filter((s): s is RemoteCollabSession => s != null);
}

function isPseudoProjectId(id: string): boolean {
  return id.startsWith('__');
}

export function useProjectCollabSocket(options: {
  projectId: string;
  enabled: boolean;
  auth: TaskApiAuth | null;
  onRemoteProjectTasksRefresh: () => Promise<void>;
}): { visibleRemoteSessions: RemoteCollabSession[] } {
  const { projectId, enabled, auth, onRemoteProjectTasksRefresh } = options;

  const [remoteSessions, setRemoteSessions] = useState<RemoteCollabSession[]>([]);
  const [localClientInstanceId, setLocalClientInstanceId] = useState<string | null>(null);
  const [tokenHash, setTokenHash] = useState<string | null>(null);

  const reloadRef = useRef(onRemoteProjectTasksRefresh);
  reloadRef.current = onRemoteProjectTasksRefresh;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    let cancelled = false;
    getOrCreateClientInstanceId()
      .then((id) => {
        if (!cancelled) setLocalClientInstanceId(id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!auth?.accessToken) {
        setTokenHash(null);
        return;
      }
      const h = await sha256Hex(auth.accessToken);
      if (!cancelled) setTokenHash(h);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [auth?.accessToken]);

  const scheduleReload = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      reloadRef.current().catch(() => {});
    }, REMOTE_PROJECT_RELOAD_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    if (!enabled || !auth || !localClientInstanceId || isPseudoProjectId(projectId)) {
      return undefined;
    }

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByUnmount = false;

    const connect = () => {
      const url = buildProjectWebSocketUrl(projectId, {
        userId: auth.userId,
        clientInstanceId: localClientInstanceId,
      });
      ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse((event.data as string) || '{}') as Record<string, unknown>;
          const type = msg?.type;
          if (type === 'collab_presence_updated') {
            setRemoteSessions(normalizeSessionList(msg.sessions));
            return;
          }
          if (type === 'title_editors_updated') {
            const ed = normalizeSessionList(msg.editors).map((e) => ({
              ...e,
              kind: e.kind ?? 'title_edit',
            }));
            setRemoteSessions(ed);
            return;
          }
          if (type === 'project_changed' && projectIdRef.current === projectId) {
            if (
              msg.origin_client_instance_id &&
              msg.origin_client_instance_id === localClientInstanceId
            ) {
              return;
            }
            if (
              msg.origin_user_id &&
              auth.userId &&
              msg.origin_user_id === auth.userId &&
              msg.origin_token_hash &&
              tokenHash &&
              msg.origin_token_hash === tokenHash
            ) {
              return;
            }
            scheduleReload();
          }
        } catch {
          /* ignore malformed */
        }
      };

      ws.onclose = () => {
        if (closedByUnmount) return;
        reconnectTimer = setTimeout(connect, PROJECT_WS_RECONNECT_MS);
      };

      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();

    return () => {
      closedByUnmount = true;
      setRemoteSessions([]);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [enabled, auth, projectId, localClientInstanceId, tokenHash, scheduleReload]);

  /**
   * 网页端要求 client_instance_id 存在才展示；服务端常见只带 user_id 或字段名不一致，
   * 会导致「sessions 有 1 条但底部条始终为空」。这里：仅当可确定是本机时才隐藏，其余一律展示。
   */
  const visibleRemoteSessions = remoteSessions.filter((s) => {
    if (
      localClientInstanceId &&
      s.client_instance_id &&
      s.client_instance_id === localClientInstanceId
    ) {
      return false;
    }
    if (!s.client_instance_id && auth?.userId && s.user_id && s.user_id === auth.userId) {
      return false;
    }
    return true;
  });

  return { visibleRemoteSessions };
}
