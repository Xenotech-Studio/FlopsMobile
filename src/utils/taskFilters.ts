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
