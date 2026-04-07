/**
 * FlowTask 任务服务 API 客户端
 * 与 FlowTaskIOS NetworkService 对齐：baseURL、接口、数据模型。
 */
import { fetchWithDebugLog } from './utils/httpDebugLog';

const TASK_API_BASE = 'https://task.xenotech.studio';

export interface TaskPosition {
  x: number;
  y: number;
}

export interface TaskItem {
  id: string;
  type: string;
  project_id: string;
  title: string;
  description: string;
  note?: string | null;
  childrenId: string[];
  /** 与 Web FlowTask 一致：弱先后 / chore 等边状态，子 id -> state */
  childrenEdgeState?: Record<string, unknown> | null;
  /** 显式主父（多父时布局用） */
  primaryParentId?: string | null;
  /** 视口左上角「未整理」暂存区 */
  unorganized?: boolean | null;
  /** chore_area 等节点的区域设置（与 Web choreZone 对齐） */
  choreZone?: Record<string, unknown> | null;
  done: boolean;
  ismine: boolean;
  relPos: TaskPosition;
  createddatetime: string;
  lastediteddatetime: string;
  startdatetime?: string | null;
  enddatetime?: string | null;
  completed_time?: string | null;
  icon?: string | null;
  creator?: string | null;
  priority?: string | null;
  doing?: boolean | null;
  done_quality?: string | null;
  users?: string[] | null;
  lastediteddatetimeincludingmove?: string | null;
  deleted_datetime?: string | null;
  /** 可折叠里程碑（与 Web FlowTask 一致） */
  collapsible?: boolean | null;
  collapsed?: boolean | null;
}

export interface Project {
  id: string;
  name?: string | null;
  description?: string | null;
  users?: string[] | null;
  createddatetime?: string | null;
  lastediteddatetime?: string | null;
  /** true = 跳过验收环节（完成即 done_quality=done，与 Web / flowtaskserver 一致） */
  skip_acceptance_phase?: boolean | null;
  /** 兼容旧字段；优先使用 skip_acceptance_phase */
  has_acceptance_phase?: boolean | null;
}

export interface NewTaskPayload {
  id: string;
  project_id: string;
  title: string;
  type: string;
  description: string;
  note?: string | null;
  childrenId: string[];
  childrenEdgeState?: Record<string, unknown>;
  primaryParentId?: string | null;
  unorganized?: boolean;
  done: boolean;
  ismine: boolean;
  relPos: TaskPosition;
  startdatetime?: string | null;
  enddatetime?: string | null;
  completed_time?: string | null;
  icon?: string | null;
  creator?: string | null;
  priority?: string | null;
  doing?: boolean | null;
  done_quality?: string | null;
  users?: string[] | null;
}

/**
 * 将接口/缓存中的异构字段规整为与 Web FlowTask 一致的 camelCase 与数值 relPos。
 * 避免 children_id、rel_pos 丢失或 relPos 为字符串导致布局 NaN/全部堆叠。
 */
export function normalizeTaskFromApi(raw: unknown): TaskItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.id == null) return null;

  const childrenId = normalizeChildrenIdField(r.childrenId ?? r.children_id);
  const relPos = normalizeRelPosField(r.relPos ?? r.rel_pos, r);

  const primary =
    r.primaryParentId != null
      ? String(r.primaryParentId)
      : r.primary_parent_id != null
        ? String(r.primary_parent_id)
        : null;

  const edgeState = r.childrenEdgeState ?? r.children_edge_state;
  const base = { ...r } as unknown as TaskItem;
  return {
    ...base,
    id: String(r.id),
    project_id: String(r.project_id ?? ''),
    childrenId,
    relPos,
    primaryParentId: primary,
    ...(edgeState !== undefined
      ? {
          childrenEdgeState:
            edgeState && typeof edgeState === 'object' && !Array.isArray(edgeState)
              ? (edgeState as Record<string, unknown>)
              : null,
        }
      : {}),
  };
}

function normalizeChildrenIdField(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => x != null && x !== '').map(String);
}

function normalizeRelPosField(relRaw: unknown, r: Record<string, unknown>): TaskPosition {
  let x = 0;
  let y = 0;
  if (relRaw && typeof relRaw === 'object') {
    const o = relRaw as Record<string, unknown>;
    x = Number(o.x);
    y = Number(o.y);
  }
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  // 少数历史数据可能只有顶层 x/y
  if (x === 0 && y === 0 && (r.x != null || r.y != null)) {
    const tx = Number(r.x);
    const ty = Number(r.y);
    if (Number.isFinite(tx)) x = tx;
    if (Number.isFinite(ty)) y = ty;
  }
  return { x, y };
}

function buildUrl(path: string, params?: Record<string, string>): string {
  const base = TASK_API_BASE.replace(/\/$/, '');
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== '') url.searchParams.set(k, v);
    });
  }
  return url.toString();
}

/**
 * 与 FlowTask Web `App.jsx` 一致：`wss://{host}/api/ws/project/{id}?user_id&client_instance_id`
 */
export function buildProjectWebSocketUrl(
  projectId: string,
  query: { userId?: string; clientInstanceId: string }
): string {
  const wsOrigin = TASK_API_BASE.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:').replace(/\/$/, '');
  const url = new URL(`/api/ws/project/${encodeURIComponent(projectId)}`, `${wsOrigin}/`);
  if (query.userId) url.searchParams.set('user_id', query.userId);
  url.searchParams.set('client_instance_id', query.clientInstanceId);
  return url.toString();
}

async function request<T>(
  url: string,
  options: RequestInit & { parseJson?: boolean } = {}
): Promise<T> {
  const { parseJson = true, ...init } = options;
  const res = await fetchWithDebugLog(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `请求失败: ${res.status}`;
    try {
      const j = JSON.parse(text) as { detail?: string; message?: string };
      msg = j.detail ?? j.message ?? msg;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new Error(msg);
  }
  if (!parseJson) return undefined as T;
  const raw = await res.json();
  return raw as T;
}

/** 兼容多种响应格式：直接数组 或 包装为 { data/tasks/projects } */
function ensureArray<T>(raw: unknown, keys: string[] = ['data', 'tasks', 'projects']): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export type TaskApiAuth = { userId: string; accessToken: string };

/**
 * 获取任务列表。
 * - `onlyMine !== false`（默认）：带 `user_id` + `access_token`，服务端只返回 `users` 含当前用户的任务（与 FlowTask Web 一致）。
 * - `onlyMine: false`：不传 `user_id`，服务端返回查询范围内**全部**任务。构建流程图、父子链时必须对指定项目使用
 *   `fetchTasks(auth, { projectId, onlyMine: false })`，否则父/子节点缺失会导致树错位。
 */
export async function fetchTasks(
  auth: TaskApiAuth | null,
  options?: { projectId?: string; onlyMine?: boolean }
): Promise<TaskItem[]> {
  const params: Record<string, string> = {};
  if (options?.projectId) params.project_id = options.projectId;
  if (options?.onlyMine !== false && auth) {
    params.user_id = auth.userId;
    params.access_token = auth.accessToken;
  }
  const url = buildUrl('/api/tasks', Object.keys(params).length ? params : undefined);
  const raw = await request<unknown>(url);
  return ensureArray<unknown>(raw)
    .map((row) => normalizeTaskFromApi(row))
    .filter((t): t is TaskItem => t != null);
}

/** 获取项目列表 */
export async function fetchProjects(auth: TaskApiAuth): Promise<Project[]> {
  const url = buildUrl('/api/projects', {
    user_id: auth.userId,
    access_token: auth.accessToken,
  });
  const raw = await request<unknown>(url);
  return ensureArray<Project>(raw);
}

/** 新增任务 */
export async function addTask(auth: TaskApiAuth | null, payload: NewTaskPayload): Promise<TaskItem> {
  const url = buildUrl('/api/add_task');
  const res = await request<{ task: unknown; message?: string }>(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const row = (res as { task: unknown }).task;
  return normalizeTaskFromApi(row) ?? (row as TaskItem);
}

/** 更新任务 */
export async function updateTask(auth: TaskApiAuth | null, task: TaskItem): Promise<void> {
  const url = buildUrl('/api/update_tasks');
  await request(url, {
    method: 'POST',
    body: JSON.stringify(task),
    parseJson: false,
  });
}

/** 删除任务 */
export async function deleteTask(auth: TaskApiAuth | null, taskId: string): Promise<void> {
  const url = buildUrl('/api/delete_task');
  await request(url, {
    method: 'POST',
    body: JSON.stringify({ task_id: taskId }),
    parseJson: false,
  });
}

/** 登录（任务服务独立登录，若与 Flops 共用则可由调用方复用 Flops session） */
export async function taskLogin(
  baseUrl: string,
  userId: string,
  password: string,
  deviceName: string = 'FlopsMobile'
): Promise<{ access_token: string; user?: { id: string; name?: string } }> {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/api/login`;
  const body = { id: userId, password, device_name: deviceName };
  const res = await fetchWithDebugLog(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { log4xxAsInfo: true }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(err.detail || `登录失败: ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string; user?: { id: string; name?: string } };
  if (!data.access_token) throw new Error('服务端未返回 access_token');
  return { access_token: data.access_token, user: data.user };
}
