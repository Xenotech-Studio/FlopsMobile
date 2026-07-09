/**
 * FlowBase REST 客户端（flowdoc-server `/api/base/*`，经 Flops 反代）。
 *
 * 端点走 `${session.server_base_url}api/base/...`——与 mobile 现有 `api/flowdoc/*` 同一出口
 * （Flops server.py 已把 `/api/base/*` + `/api/base/ws/{table_id}` 反代到 flowdoc-server，见
 *  server.py `app.include_router(_r_flowdoc.router)`）。鉴权沿用普通 Bearer token，无需换证。
 *
 * P0 只覆盖只读入口子集：列 Base / 取 Base+表 / 取表 schema / 列视图。
 * 行查询、CAS 更新、WS 实时在 P1+ 增量补上（契约见 base_routes.py / flowbase_rt/hub.py）。
 */
import type { Session } from '../api';
import type {
  App,
  Base,
  ComponentResult,
  Dashboard,
  DashboardComponent,
  Field,
  RowRecord,
  Table,
  View,
} from './types';

/** 后端统一响应包 `{success, ...}`；出错时 detail/error 给人类可读信息。 */
type Envelope<T> = { success?: boolean; detail?: unknown; error?: unknown } & T;

export class FlowBaseApiError extends Error {
  status: number;
  /** 原始响应体（如 409 version_conflict 时的 {current_version, current_data}），便于上层重放。 */
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'FlowBaseApiError';
    this.status = status;
    this.body = body;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function baseUrl(session: Session): string {
  // server_base_url 末尾带斜杠（normalizeServerUrl 保证），与现有 `${base}api/flowdoc/...` 用法一致。
  return `${session.server_base_url}api/base`;
}

function pickErrorMessage(status: number, body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const d = b.detail ?? b.error;
    if (typeof d === 'string' && d.trim()) return d;
    if (d != null) return JSON.stringify(d);
  }
  return fallback || `HTTP ${status}`;
}

/** 低层请求（导出给自定义 App 桥用于忠实代理任意读端点，返回原始 `{success,...}` 解包体）。 */
export async function flowbaseRequest<T = unknown>(
  session: Session,
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(session, method, path, body);
}

async function request<T>(
  session: Session,
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl(session)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null; // 非 JSON（如网关 HTML 错误页）——保留 text 兜底
    }
  }

  const envelopeFailed =
    json != null &&
    typeof json === 'object' &&
    (json as { success?: unknown }).success === false;

  if (!res.ok || envelopeFailed) {
    throw new FlowBaseApiError(
      pickErrorMessage(res.status, json ?? text, `请求失败（HTTP ${res.status}）`),
      res.status,
      json ?? text,
    );
  }
  return json as T;
}

/** GET /bases —— 当前用户的 Base 列表。 */
export async function listBases(session: Session): Promise<Base[]> {
  const data = await request<Envelope<{ bases?: Base[] }>>(session, 'GET', '/bases');
  return data.bases ?? [];
}

/** GET /bases/{base_id} —— Base 详情 + 表概览。 */
export async function getBase(
  session: Session,
  baseId: string,
): Promise<{ base: Base; tables: Table[] }> {
  const data = await request<Envelope<{ base: Base; tables?: Table[] }>>(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}`,
  );
  return { base: data.base, tables: data.tables ?? [] };
}

/** GET /bases/{base_id}/tables/{table_id}/schema —— 字段定义。 */
export async function getTableSchema(
  session: Session,
  baseId: string,
  tableId: string,
): Promise<{ name: string; schema: Field[] }> {
  const data = await request<Envelope<{ name?: string; schema?: Field[] }>>(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/schema`,
  );
  return { name: data.name ?? '', schema: data.schema ?? [] };
}

/** GET /bases/{base_id}/tables/{table_id}/views —— 视图列表（按 sort_order）。 */
export async function listViews(
  session: Session,
  baseId: string,
  tableId: string,
): Promise<View[]> {
  const data = await request<Envelope<{ views?: View[] }>>(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/views`,
  );
  return data.views ?? [];
}

/** POST /bases/{base_id}/tables/{table_id}/views —— 新建视图（grid/kanban/calendar）。 */
export async function createView(
  session: Session,
  baseId: string,
  tableId: string,
  viewType: string,
  name?: string,
): Promise<View> {
  const data = await request<Envelope<{ view: View }>>(
    session,
    'POST',
    `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/views`,
    { view_type: viewType, ...(name ? { name } : {}) },
  );
  return data.view;
}

// ── rows ─────────────────────────────────────────────────────────────────────

export type RowFilter = { field: string; op: string; value?: unknown };

export type QueryRowsOptions = {
  filter?: RowFilter[];
  sort?: string; // field_id
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  fields?: string[]; // 字段投影
};

export type QueryRowsResult = {
  rows: RowRecord[];
  total: number;
  limit: number;
  offset: number;
  /** change feed 高水位；WS `sync_since` 用它追帧（P1 WS 客户端）。 */
  seq: number;
};

/** GET /bases/{base_id}/tables/{table_id}/rows —— 查行（P1：筛选/排序/分页/投影）。 */
export async function queryRows(
  session: Session,
  baseId: string,
  tableId: string,
  opts: QueryRowsOptions = {},
): Promise<QueryRowsResult> {
  const qs = new URLSearchParams();
  if (opts.filter && opts.filter.length) qs.set('filter', JSON.stringify(opts.filter));
  if (opts.sort) qs.set('sort', opts.sort);
  if (opts.order) qs.set('order', opts.order);
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.offset != null) qs.set('offset', String(opts.offset));
  if (opts.fields && opts.fields.length) qs.set('fields', opts.fields.join(','));
  const q = qs.toString();
  const data = await request<
    Envelope<{ rows?: RowRecord[]; total?: number; limit?: number; offset?: number; seq?: number }>
  >(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/rows${q ? `?${q}` : ''}`,
  );
  return {
    rows: data.rows ?? [],
    total: data.total ?? (data.rows?.length ?? 0),
    limit: data.limit ?? opts.limit ?? 100,
    offset: data.offset ?? opts.offset ?? 0,
    seq: data.seq ?? 0,
  };
}

/** POST /bases/{base_id}/tables/{table_id}/rows —— 批量插入（返回新 row_id）。 */
export async function insertRows(
  session: Session,
  baseId: string,
  tableId: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ rowIds: string[]; count: number }> {
  const data = await request<Envelope<{ row_ids?: string[]; count?: number }>>(
    session,
    'POST',
    `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/rows`,
    { rows },
  );
  return { rowIds: data.row_ids ?? [], count: data.count ?? (data.row_ids?.length ?? 0) };
}

/** 409 version_conflict 响应体（乐观并发冲突，供上层 rebase）。 */
export type VersionConflict = {
  error: 'version_conflict';
  row_id: string;
  current_version: number;
  current_data: Record<string, unknown>;
};

export function isVersionConflict(err: unknown): err is FlowBaseApiError & { body: VersionConflict } {
  return (
    err instanceof FlowBaseApiError &&
    err.status === 409 &&
    !!err.body &&
    typeof err.body === 'object' &&
    (err.body as { error?: unknown }).error === 'version_conflict'
  );
}

/**
 * PATCH /bases/{base_id}/tables/{table_id}/rows/{row_id} —— 更新行（CAS）。
 * 传 base_version 时若版本被他人抢先则抛 409（用 isVersionConflict 判定并 rebase）。
 * formula 字段只读，不要放进 values。
 */
export async function updateRow(
  session: Session,
  baseId: string,
  tableId: string,
  rowId: string,
  values: Record<string, unknown>,
  baseVersion?: number,
): Promise<{ rowId: string; data: Record<string, unknown>; version: number; seq: number; warnings?: string[] }> {
  const body: Record<string, unknown> = { values };
  if (baseVersion != null) body.base_version = baseVersion;
  const data = await request<
    Envelope<{ row_id: string; data: Record<string, unknown>; version?: number; seq?: number; warnings?: string[] }>
  >(
    session,
    'PATCH',
    `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`,
    body,
  );
  return {
    rowId: data.row_id,
    data: data.data ?? {},
    version: data.version ?? 0,
    seq: data.seq ?? 0,
    warnings: data.warnings,
  };
}

/** DELETE /bases/{base_id}/tables/{table_id}/rows —— 批量软删。 */
export async function deleteRows(
  session: Session,
  baseId: string,
  tableId: string,
  rowIds: string[],
): Promise<number> {
  const data = await request<Envelope<{ deleted?: number }>>(
    session,
    'DELETE',
    `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/rows`,
    { row_ids: rowIds },
  );
  return data.deleted ?? 0;
}

// ── dashboards ─────────────────────────────────────────────────────────────────

/** GET /bases/{base_id}/dashboards —— 仪表盘列表。 */
export async function listDashboards(session: Session, baseId: string): Promise<Dashboard[]> {
  const data = await request<Envelope<{ dashboards?: Dashboard[] }>>(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}/dashboards`,
  );
  return data.dashboards ?? [];
}

/** GET /bases/{base_id}/dashboards/{dash_id} —— 详情（config: layout + components）。 */
export async function getDashboard(
  session: Session,
  baseId: string,
  dashId: string,
): Promise<Dashboard> {
  const data = await request<Envelope<{ dashboard: Dashboard }>>(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}/dashboards/${encodeURIComponent(dashId)}`,
  );
  return data.dashboard;
}

/**
 * POST /bases/{base_id}/dashboards/{dash_id}/query —— 并行解析各组件（10s TTL 缓存）。
 * 传 components 用于编辑态预览；缺省则读已存 config。返回 {component_id: result}。
 */
export async function queryDashboard(
  session: Session,
  baseId: string,
  dashId: string,
  components?: DashboardComponent[],
): Promise<Record<string, ComponentResult>> {
  const data = await request<Envelope<{ results?: Record<string, ComponentResult> }>>(
    session,
    'POST',
    `/bases/${encodeURIComponent(baseId)}/dashboards/${encodeURIComponent(dashId)}/query`,
    components ? { components } : {},
  );
  return data.results ?? {};
}

// ── apps ───────────────────────────────────────────────────────────────────────

/** GET /bases/{base_id}/apps —— app 列表。 */
export async function listApps(session: Session, baseId: string): Promise<App[]> {
  const data = await request<Envelope<{ apps?: App[] }>>(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}/apps`,
  );
  return data.apps ?? [];
}

/** GET /bases/{base_id}/apps/{app_id} —— app 详情（含 config.source）。 */
export async function getApp(session: Session, baseId: string, appId: string): Promise<App> {
  const data = await request<Envelope<{ app: App }>>(
    session,
    'GET',
    `/bases/${encodeURIComponent(baseId)}/apps/${encodeURIComponent(appId)}`,
  );
  return data.app;
}
