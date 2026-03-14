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
}

export interface Project {
  id: string;
  name?: string | null;
  description?: string | null;
  users?: string[] | null;
  createddatetime?: string | null;
  lastediteddatetime?: string | null;
}

export interface NewTaskPayload {
  id: string;
  project_id: string;
  title: string;
  type: string;
  description: string;
  note?: string | null;
  childrenId: string[];
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

/** 获取任务列表（onlyMine 时需传 auth） */
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
  return ensureArray<TaskItem>(raw);
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
  const res = await request<{ task: TaskItem; message?: string }>(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return (res as { task: TaskItem }).task;
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
