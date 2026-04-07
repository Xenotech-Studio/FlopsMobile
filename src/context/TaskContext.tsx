/**
 * 任务数据与今日逻辑：与 FlowTaskIOS TaskStore 对齐
 * - 使用 Flops Session 的 user_id + access_token 调用任务 API
 * - todayDate 含 4 点规则与「结束今天」
 * - todayTasks 筛选 + 排序
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TaskItem, Project, NewTaskPayload } from '../taskApi';
import * as taskApi from '../taskApi';
import { useSession } from './SessionContext';
import { getDoneQualityWhenToggling, projectHasAcceptancePhase } from '../utils/taskAcceptance';

const ENDED_TODAY_KEY = '@FlopsMobile/endedTodayDate';
const CACHED_TASKS_KEY = '@FlopsMobile/cachedTasks';
const CACHED_PROJECTS_KEY = '@FlopsMobile/cachedProjects';
const DEDUPE_MS = 2000;

function parseISO(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 凌晨 4 点前算前一天 */
function getBaseToday(): Date {
  const now = new Date();
  const h = now.getHours();
  if (h < 4) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }
  return now;
}

function formatYYYYMMDD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 任务归属日期（与 iOS getTaskBelongDate 一致） */
function getTaskBelongDate(task: TaskItem): Date | null {
  const formatter = (s: string) => parseISO(s);
  if (task.done && task.completed_time) {
    const completed = formatter(task.completed_time);
    if (completed) {
      if (completed.getHours() < 4) {
        const d = new Date(completed);
        d.setDate(d.getDate() - 1);
        return d;
      }
      return completed;
    }
  }
  if (task.startdatetime) {
    const start = formatter(task.startdatetime);
    if (start) {
      if (start.getHours() < 4) {
        const d = new Date(start);
        d.setDate(d.getDate() - 1);
        return d;
      }
      return start;
    }
  }
  if (task.enddatetime) {
    const end = formatter(task.enddatetime);
    if (end) {
      if (end.getHours() < 4) {
        const d = new Date(end);
        d.setDate(d.getDate() - 1);
        return d;
      }
      return end;
    }
  }
  return null;
}

const DEFAULT_END = '2025-02-28T23:59:59Z';
const DEFAULT_START = '2025-02-28T00:00:00Z';

function isDefaultDatetime(s: string | null | undefined): boolean {
  return s === DEFAULT_END || s === DEFAULT_START;
}

function isTaskInTodayByDate(task: TaskItem, today: Date): boolean {
  const belong = getTaskBelongDate(task);
  if (!belong) return false;
  return (
    belong.getFullYear() === today.getFullYear() &&
    belong.getMonth() === today.getMonth() &&
    belong.getDate() === today.getDate()
  );
}

/** 今日任务过滤（与 iOS todayTasks 一致） */
function filterTodayTasks(tasks: TaskItem[], today: Date): TaskItem[] {
  const list = tasks.filter((task) => {
    if (task.done && task.completed_time) return true;
    if (!task.startdatetime && !task.enddatetime) return false;
    if (task.enddatetime && isDefaultDatetime(task.enddatetime) && !task.startdatetime) return false;
    return true;
  }).filter((task) => isTaskInTodayByDate(task, today));

  const doingIds = new Set(
    tasks.filter((t) => !t.done && t.doing).map((t) => t.id)
  );
  const existingIds = new Set(list.map((t) => t.id));
  const extra = tasks.filter((t) => doingIds.has(t.id) && !existingIds.has(t.id));
  const combined = [...list];
  extra.forEach((t) => combined.push(t));

  return sortTasks(combined);
}

function sortTasks(tasks: TaskItem[]): TaskItem[] {
  const priorityOrder: Record<string, number> = { now: 0, default: 1, later: 2 };
  const qualityOrder: Record<string, number> = { reviewing: 0, done: 1, wasted: 2 };
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) {
      const qa = qualityOrder[a.done_quality ?? 'reviewing'] ?? 0;
      const qb = qualityOrder[b.done_quality ?? 'reviewing'] ?? 0;
      return qa - qb;
    }
    const pa = priorityOrder[a.priority ?? 'default'] ?? 1;
    const pb = priorityOrder[b.priority ?? 'default'] ?? 1;
    if (pa !== pb) return pa - pb;
    if ((a.doing ?? false) !== (b.doing ?? false)) return (a.doing ?? false) ? -1 : 1;
    return 0;
  });
}

type TaskContextValue = {
  tasks: TaskItem[];
  projects: Project[];
  todayTasks: TaskItem[];
  todayDate: Date;
  isAheadOfToday: boolean;
  isLoadingTasks: boolean;
  isLoadingProjects: boolean;
  errorMessage: string | null;
  loadTasks: (forceRefresh?: boolean) => Promise<void>;
  loadProjects: (forceRefresh?: boolean) => Promise<void>;
  toggleTaskCompletion: (task: TaskItem) => Promise<void>;
  updateTaskPriority: (task: TaskItem, priority: string) => Promise<void>;
  updateTaskDoneQuality: (task: TaskItem, quality: string) => Promise<void>;
  toggleTaskDoing: (task: TaskItem) => Promise<void>;
  deleteTask: (task: TaskItem) => Promise<void>;
  addTask: (payload: NewTaskPayload) => Promise<TaskItem>;
  updateTask: (task: TaskItem) => Promise<void>;
  endToday: () => void;
  cancelAheadOfToday: () => void;
  shouldShowEndTodayButton: () => boolean;
  clearError: () => void;
  getAuth: () => taskApi.TaskApiAuth | null;
  /** 用某项目的全量任务快照替换本地该项目的任务（用于 WS project_changed 等与 Web 对齐） */
  mergeProjectTasksSnapshot: (projectId: string, projectTasks: TaskItem[]) => void;
};

const TaskContext = createContext<TaskContextValue | null>(null);

export function TaskProvider({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [endedTodayDate, setEndedTodayDate] = useState<string | null>(null);
  const [lastTasksLoad, setLastTasksLoad] = useState<number>(0);
  const [lastProjectsLoad, setLastProjectsLoad] = useState<number>(0);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const auth = useMemo((): taskApi.TaskApiAuth | null => {
    if (!session?.user_id || !session?.access_token) return null;
    return { userId: session.user_id, accessToken: session.access_token };
  }, [session?.user_id, session?.access_token]);

  const loadEndedToday = useCallback(async () => {
    try {
      const s = await AsyncStorage.getItem(ENDED_TODAY_KEY);
      setEndedTodayDate(s);
    } catch {
      setEndedTodayDate(null);
    }
  }, []);

  const todayDate = useMemo(() => {
    const base = getBaseToday();
    let adjusted = new Date(base);
    if (endedTodayDate) {
      const ended = new Date(endedTodayDate + 'T12:00:00');
      if (
        ended.getFullYear() === base.getFullYear() &&
        ended.getMonth() === base.getMonth() &&
        ended.getDate() === base.getDate()
      ) {
        adjusted.setDate(adjusted.getDate() + 1);
      }
    }
    return adjusted;
  }, [endedTodayDate]);

  const todayTasks = useMemo(
    () => filterTodayTasks(tasks, todayDate),
    [tasks, todayDate]
  );

  const isAheadOfToday = useMemo(() => {
    const base = getBaseToday();
    if (!endedTodayDate) return false;
    const ended = new Date(endedTodayDate + 'T12:00:00');
    if (
      ended.getFullYear() === base.getFullYear() &&
      ended.getMonth() === base.getMonth() &&
      ended.getDate() === base.getDate()
    )
      return true;
    return false;
  }, [endedTodayDate]);

  const loadTasks = useCallback(
    async (forceRefresh = false) => {
      if (!auth) return;
      const now = Date.now();
      if (!forceRefresh && lastTasksLoad && now - lastTasksLoad < DEDUPE_MS) return;
      setIsLoadingTasks(true);
      setErrorMessage(null);
      try {
        const list = await taskApi.fetchTasks(auth, { onlyMine: true });
        const safeList = Array.isArray(list) ? list.filter((t) => t && typeof t === 'object' && t.id != null) : [];
        setTasks(safeList);
        setLastTasksLoad(now);
        try {
          await AsyncStorage.setItem(CACHED_TASKS_KEY, JSON.stringify(safeList));
        } catch {
          /* ignore */
        }
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '加载任务失败');
      } finally {
        setIsLoadingTasks(false);
      }
    },
    [auth, lastTasksLoad]
  );

  const loadProjects = useCallback(
    async (forceRefresh = false) => {
      if (!auth) return;
      const now = Date.now();
      if (!forceRefresh && lastProjectsLoad && now - lastProjectsLoad < DEDUPE_MS) return;
      setIsLoadingProjects(true);
      setErrorMessage(null);
      try {
        const list = await taskApi.fetchProjects(auth);
        const safeList = Array.isArray(list) ? list.filter((p) => p && typeof p === 'object' && p.id != null) : [];
        setProjects(safeList);
        setLastProjectsLoad(now);
        try {
          await AsyncStorage.setItem(CACHED_PROJECTS_KEY, JSON.stringify(safeList));
        } catch {
          /* ignore */
        }
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '加载项目失败');
      } finally {
        setIsLoadingProjects(false);
      }
    },
    [auth, lastProjectsLoad]
  );

  const toggleTaskCompletion = useCallback(
    async (task: TaskItem) => {
      if (!auth) return;
      const proj = projects.find((p) => p.id === task.project_id) ?? null;
      const hasAcceptancePhase = projectHasAcceptancePhase(proj);
      const nextDone = !task.done;
      const done_quality = getDoneQualityWhenToggling({
        hasAcceptancePhase,
        checked: nextDone,
        ctrlPressed: false,
        currentDoneQuality: task.done_quality ?? 'reviewing',
        taskType: task.type ?? 'task',
      });
      const next: TaskItem = {
        ...task,
        done: nextDone,
        done_quality,
        doing: nextDone ? false : (task.doing ?? false),
        completed_time: nextDone
          ? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
          : undefined,
      };
      try {
        await taskApi.updateTask(auth, next);
        setTasks((prev) => {
          const out = prev.map((t) => (t.id === task.id ? next : t));
          return sortTasks(out);
        });
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '更新失败');
      }
    },
    [auth, projects]
  );

  const updateTaskPriority = useCallback(
    async (task: TaskItem, priority: string) => {
      if (!auth) return;
      const next = { ...task, priority };
      try {
        await taskApi.updateTask(auth, next);
        setTasks((prev) => sortTasks(prev.map((t) => (t.id === task.id ? next : t))));
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '更新失败');
      }
    },
    [auth]
  );

  const updateTaskDoneQuality = useCallback(
    async (task: TaskItem, quality: string) => {
      if (!auth) return;
      const next = { ...task, done_quality: quality };
      try {
        await taskApi.updateTask(auth, next);
        setTasks((prev) => sortTasks(prev.map((t) => (t.id === task.id ? next : t))));
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '更新失败');
      }
    },
    [auth]
  );

  const toggleTaskDoing = useCallback(
    async (task: TaskItem) => {
      if (!auth) return;
      const next = { ...task, doing: !(task.doing ?? false) };
      try {
        await taskApi.updateTask(auth, next);
        setTasks((prev) => prev.map((t) => (t.id === task.id ? next : t)));
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '更新失败');
      }
    },
    [auth]
  );

  const deleteTask = useCallback(
    async (task: TaskItem) => {
      if (!auth) return;
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      try {
        await taskApi.deleteTask(auth, task.id);
        await loadTasks(true);
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '删除失败');
        await loadTasks(true);
      }
    },
    [auth, loadTasks]
  );

  const addTask = useCallback(
    async (payload: NewTaskPayload): Promise<TaskItem> => {
      if (!auth) throw new Error('未登录');
      const created = await taskApi.addTask(auth, payload);
      setTasks((prev) => sortTasks([...prev, created]));
      return created;
    },
    [auth]
  );

  const updateTask = useCallback(
    async (task: TaskItem) => {
      if (!auth) return;
      try {
        await taskApi.updateTask(auth, task);
        setTasks((prev) => sortTasks(prev.map((t) => (t.id === task.id ? task : t))));
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : '更新失败');
      }
    },
    [auth]
  );

  const endToday = useCallback(() => {
    const base = getBaseToday();
    const str = formatYYYYMMDD(base);
    AsyncStorage.setItem(ENDED_TODAY_KEY, str);
    setEndedTodayDate(str);
  }, []);

  const cancelAheadOfToday = useCallback(() => {
    AsyncStorage.removeItem(ENDED_TODAY_KEY);
    setEndedTodayDate(null);
  }, []);

  const shouldShowEndTodayButton = useCallback(() => {
    const now = new Date();
    const h = now.getHours();
    if (h >= 22 || h < 4) {
      const base = getBaseToday();
      const todayStr = formatYYYYMMDD(base);
      if (endedTodayDate === todayStr) return false;
      const list = filterTodayTasks(tasks, base);
      const doing = tasks.filter((t) => !t.done && t.doing);
      const ids = new Set(list.map((t) => t.id));
      doing.forEach((t) => { if (!ids.has(t.id)) list.push(t); });
      return list.every((t) => t.done);
    }
    return false;
  }, [endedTodayDate, tasks]);

  const clearError = useCallback(() => setErrorMessage(null), []);

  const getAuth = useCallback(() => auth, [auth]);

  const mergeProjectTasksSnapshot = useCallback((projectId: string, projectTasks: TaskItem[]) => {
    setTasks((prev) => {
      const others = prev.filter((t) => t.project_id !== projectId);
      const next = sortTasks([...others, ...projectTasks]);
      AsyncStorage.setItem(CACHED_TASKS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
    setLastTasksLoad(Date.now());
  }, []);

  React.useEffect(() => {
    loadEndedToday();
  }, [loadEndedToday]);

  const value: TaskContextValue = {
    tasks,
    projects,
    todayTasks,
    todayDate,
    isAheadOfToday,
    isLoadingTasks,
    isLoadingProjects,
    errorMessage,
    loadTasks,
    loadProjects,
    toggleTaskCompletion,
    updateTaskPriority,
    updateTaskDoneQuality,
    toggleTaskDoing,
    deleteTask,
    addTask,
    updateTask,
    endToday,
    cancelAheadOfToday,
    shouldShowEndTodayButton,
    clearError,
    getAuth,
    mergeProjectTasksSnapshot,
  };

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export function useTask(): TaskContextValue {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error('useTask must be used within TaskProvider');
  return ctx;
}
