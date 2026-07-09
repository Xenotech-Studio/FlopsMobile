/**
 * FlowBase 数据模型（对齐 flowdoc-server `/api/base/*` 契约）。
 *
 * 三层容器：Base（容器）→ Table（带 schema 的数据表）→ Row（稀疏行）。
 * Base 同时挂 Dashboard / App。字段值存在 Row.data 的 JSON blob 里，按 field.id 键控。
 *
 * 注：后端从旧 Flops `/api/flowbase/*` 迁到 flowdoc-server `/api/base/*`（见 base_routes.py），
 * 并新增行级 version（CAS）与 WS 实时（P1+ 用）。此文件只放 P0 需要的类型 + 面向未来的行/视图类型。
 */

/** 12 种字段类型（FIELD_TYPES，schema.py）。 */
export type FieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'datetime'
  | 'url'
  | 'email'
  | 'link'
  | 'formula';

/** 字段定义。id 形如 `field_001`，永不复用；options 随类型不同（select.choices / link.table_id / formula.formula_expression 等）。 */
export type Field = {
  id: string;
  name: string;
  type: FieldType;
  options?: Record<string, unknown>;
};

/** Base：顶层容器。meta 里的 flowdoc_item_id 指回 FlowDoc 树节点。 */
export type Base = {
  id: string;
  name: string;
  description?: string | null;
  owner_user_id?: string;
  flowdoc_item_id?: string | null;
  status?: string;
  config?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
};

/** Table：数据表。schema 仅在 get-schema / 部分列表接口返回。 */
export type Table = {
  id: string;
  base_id: string;
  name: string;
  schema?: Field[];
  row_count?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
};

/** 视图类型（后端字段名为 view_type）。 */
export type ViewType = 'grid' | 'kanban' | 'calendar';

/** View：纯元数据（筛选/排序/分组/字段可见性），不含行数据。 */
export type View = {
  id: string;
  base_id: string;
  table_id: string;
  name: string;
  view_type: ViewType | string;
  config?: Record<string, unknown>;
  is_default?: boolean;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
};

/**
 * 行记录。data 为稀疏 `{field_id: value}`；formula 字段只读已物化。
 * version 是行级 CAS 版本号，更新时作为 base_version 回传（P1 用）。
 */
export type RowRecord = {
  row_id: string;
  data: Record<string, unknown>;
  row_order?: number;
  version?: number;
  created_at?: string;
  updated_at?: string;
};

// ── 仪表盘 ─────────────────────────────────────────────────────────────────────

export type DashboardComponentType = 'metric' | 'chart' | 'pivot' | 'view';
export type ChartType = 'bar' | 'line' | 'pie';

/** 仪表盘组件配置（config.components 里的一项）。 */
export type DashboardComponent = {
  id: string;
  type: DashboardComponentType | string;
  title?: string;
  table_id?: string;
  chart_type?: ChartType | string;
  /** 折线/柱空缺画法：zero(计 0) / skip(连相邻) / break(断开)。 */
  null_connect?: 'zero' | 'skip' | 'break';
  line_smooth?: boolean;
  query?: Record<string, unknown>;
};

export type Dashboard = {
  id: string;
  base_id: string;
  name: string;
  config?: { layout?: unknown; components?: DashboardComponent[] } | null;
  sort_order?: number;
  status?: string;
  created_at?: string;
  updated_at?: string;
};

/** 一个聚合分组：group={fid:值}，aggregates={alias:值}。 */
export type AggGroup = { group: Record<string, unknown>; aggregates: Record<string, number> };

/** /query 返回的单组件结果（聚合 groups 或 view rows；出错时带 error）。 */
export type ComponentResult = {
  id?: string;
  error?: string;
  error_kind?: string;
  cached?: boolean;
  // 聚合类（metric/chart/pivot）
  groups?: AggGroup[];
  group_by?: string[];
  aggregate?: string[];
  transform?: { value?: number; unit?: string; series?: unknown } | null;
  // view 类
  rows?: RowRecord[];
  total?: number;
};

// ── 自定义 App ──────────────────────────────────────────────────────────────────

export type App = {
  id: string;
  base_id: string;
  name: string;
  config?: {
    source?: string;
    runtime?: unknown;
    permissions?: unknown;
    tables_declared?: string[];
  } | null;
  sort_order?: number;
  status?: string;
};
