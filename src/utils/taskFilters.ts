/**
 * 与 FlowTaskIOS 一致的渐进式状态筛选
 */
import type { TaskItem } from '../taskApi';
import type { StatusLevel } from '../components/TaskFilterSheet';

export function filterTasksByStatusLevel(tasks: TaskItem[], level: StatusLevel): TaskItem[] {
  return tasks.filter((task) => {
    switch (level) {
      case 0:
        return !task.done && (task.priority === 'now' || !!task.doing);
      case 1:
        return !task.done;
      case 2:
        return !task.done || (task.done && (task.done_quality === 'reviewing' || !task.done_quality));
      case 3:
      default:
        return true;
    }
  });
}

export function filterTasksByShowOnlyMine(tasks: TaskItem[], showOnlyMine: boolean): TaskItem[] {
  if (!showOnlyMine) return tasks;
  return tasks.filter((t) => !!t.ismine);
}

/** 凌晨 4 点前算前一天，与 FlowTaskIOS adjustEarlyMorning 一致 */
function adjustEarlyMorning(d: Date): Date {
  if (d.getHours() < 4) {
    const next = new Date(d);
    next.setDate(next.getDate() - 1);
    return next;
  }
  return d;
}

/** 任务归属日期：完成时间 > 开始时间 > 结束时间，与 FlowTaskIOS getTaskBelongDate 一致 */
export function getTaskBelongDate(task: TaskItem): Date | null {
  const parse = (s: string | null | undefined): Date | null => {
    if (!s) return null;
    try {
      return new Date(s);
    } catch {
      return null;
    }
  };
  if (task.done && task.completed_time) {
    const d = parse(task.completed_time);
    if (d) return adjustEarlyMorning(d);
  }
  if (task.startdatetime) {
    const d = parse(task.startdatetime);
    if (d) return adjustEarlyMorning(d);
  }
  if (task.enddatetime) {
    const d = parse(task.enddatetime);
    if (d) return adjustEarlyMorning(d);
  }
  return null;
}

/** 判断任务是否属于某一天（按归属日期，凌晨 4 点规则） */
export function isTaskBelongToDay(task: TaskItem, day: Date): boolean {
  const belong = getTaskBelongDate(task);
  if (!belong) return false;
  return (
    belong.getFullYear() === day.getFullYear() &&
    belong.getMonth() === day.getMonth() &&
    belong.getDate() === day.getDate()
  );
}
