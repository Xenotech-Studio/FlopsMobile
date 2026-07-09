/**
 * TableSocket —— FlowBase 实时协作 WS 客户端（对齐 flowdoc-server `flowbase_rt/hub.py`）。
 *
 * 端点：`WS ${server_base_url→ws}api/base/ws/{table_id}?access_token=`（浏览器/RN 都不能给 WS 设头，
 * 故 token 走 query，与后端 `_ws_auth_user_id` 的 query 分支一致）。
 *
 * 生命周期：连上 → 收 `hello`{seq} → （快照就绪后）发 `sync_since`{seq} 补齐这段时间的变更 →
 * 之后持续收 `change`（增量）/`presence`/`presence_leave`。25s 一次 `ping` 保活；断线指数退避重连，
 * 重连后用「当前已应用的 seq」重新 sync_since（getSeq 访问器实时取），避免漏帧或重复。
 */
import type { Session } from '../../api';

export type RtOp = 'insert' | 'update' | 'delete' | 'schema_changed';

export type RtChange = {
  seq: number;
  table_id: string;
  row_id: string | null;
  op: RtOp;
  /** insert:{data,row_order} update:{data,row_order?} delete:{} schema_changed:{schema} */
  delta: Record<string, unknown>;
  actor: string | null;
  version: number | null;
  ts: string;
};

/** 单元格坐标（presence 精确到格）。 */
export type RtCell = { row_id: string; field_id: string };

/**
 * presence 消息（对齐 Desktop `useFlowBaseRealtime.js`）：
 * `cell` 是被选中/编辑的格（null=离开），`editing` 区分「选中 vs 正在编辑」，
 * `value` 是编辑中的实时值（仅 editing 时带）。颜色由 client_id 派生，不走消息字段。
 */
export type RtPresence = {
  type: 'presence';
  table_id?: string;
  client_id: string;
  user_id: string;
  cell?: RtCell | null;
  editing?: boolean;
  value?: string | null;
};

export type RtPresenceLeave = {
  type: 'presence_leave';
  table_id: string;
  client_id: string;
  user_id: string;
};

export type TableSocketHandlers = {
  onHello?: (seq: number, clientId: string) => void;
  onChange?: (changes: RtChange[], meta: { catchup?: boolean; reload?: boolean }) => void;
  onPresence?: (p: RtPresence) => void;
  onPresenceLeave?: (p: RtPresenceLeave) => void;
  /** 有人加入并请求在场者重播自己的 presence。 */
  onPresenceQuery?: (clientId: string) => void;
  onStatus?: (connected: boolean) => void;
};

export type PresencePayload = { cell: RtCell | null; editing?: boolean; value?: string | null };

const PING_INTERVAL = 25_000;
const MAX_BACKOFF = 30_000;

export function buildWsUrl(session: Session, tableId: string): string {
  // https://host/ → wss://host/ ; http://host/ → ws://host/
  const wsBase = session.server_base_url.replace(/^http/i, 'ws');
  return `${wsBase}api/base/ws/${encodeURIComponent(tableId)}?access_token=${encodeURIComponent(
    session.access_token,
  )}`;
}

export class TableSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private helloDone = false;
  private ready = false;
  private synced = false;
  private backoff = 1000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly session: Session,
    private readonly tableId: string,
    private readonly getSeq: () => number,
    private readonly handlers: TableSocketHandlers,
  ) {}

  connect() {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(buildWsUrl(this.session, this.tableId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.startPing();
    };
    this.ws.onmessage = (ev) => this.onMessage(ev);
    this.ws.onerror = () => {
      // onclose 会随后触发，统一在那里重连
    };
    this.ws.onclose = () => {
      this.handlers.onStatus?.(false);
      this.stopPing();
      this.helloDone = false;
      this.synced = false;
      if (!this.closed) this.scheduleReconnect();
    };
  }

  /** 快照（首屏 queryRows）就绪后调用；配合 hello 触发首次 sync_since。 */
  markReady() {
    this.ready = true;
    this.trySync();
  }

  sendPresence(payload: PresencePayload) {
    this.send({ type: 'presence', ...payload });
  }

  /** 请所有在场者重播各自的 presence（加入/重连时用）。 */
  sendPresenceQuery() {
    this.send({ type: 'presence_query' });
  }

  close() {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private onMessage(ev: WebSocketMessageEvent) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello': {
        this.helloDone = true;
        this.backoff = 1000; // 成功握手 → 退避归位
        this.handlers.onStatus?.(true);
        this.handlers.onHello?.(Number(msg.seq) || 0, String(msg.client_id || ''));
        this.trySync();
        break;
      }
      case 'change': {
        const changes = Array.isArray(msg.changes) ? (msg.changes as RtChange[]) : [];
        this.handlers.onChange?.(changes, {
          catchup: !!msg.catchup,
          reload: !!msg.reload,
        });
        break;
      }
      case 'presence':
        this.handlers.onPresence?.(msg as unknown as RtPresence);
        break;
      case 'presence_query':
        this.handlers.onPresenceQuery?.(String(msg.client_id || ''));
        break;
      case 'presence_leave':
        this.handlers.onPresenceLeave?.(msg as unknown as RtPresenceLeave);
        break;
      case 'pong':
      default:
        break;
    }
  }

  private trySync() {
    if (this.helloDone && this.ready && !this.synced) {
      this.synced = true;
      this.send({ type: 'sync_since', seq: this.getSeq() });
    }
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        /* noop */
      }
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
