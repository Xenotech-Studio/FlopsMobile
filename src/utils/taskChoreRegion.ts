/**
 * 与 FlowTask Web `edgeStateUtils.js` 对齐：chore 区域父类型、子边 state、默认几何偏移。
 * 未来若有其它「无序投放」父类型，在 taskTypesNeedingCreateRegionSheet 中扩展即可。
 */
import type { TaskItem } from '../taskApi';

export const TASK_TYPE_CHORE_AREA = 'chore_area';

/** 新建子任务挂到 chore 边时使用的默认 offset（与 Web DEFAULT_CHORE_OFFSET 一致） */
export const DEFAULT_CHORE_OFFSET = { x: 75, y: 108 };

export function taskTypeIsUnorderedDumpParent(type: string | undefined | null): boolean {
  if (!type) return false;
  return type === TASK_TYPE_CHORE_AREA;
}

/**
 * 在二级 sheet 中展示为「创建目标」的无序类父节点（除「未整理」外）。
 * 与 Web 的 chore_area 一致；后续可在此追加类型。
 */
export function taskTypesNeedingCreateRegionSheet(): string[] {
  return [TASK_TYPE_CHORE_AREA];
}

export function listUnorderedDumpParentsForProject(
  tasks: TaskItem[],
  projectId: string
): TaskItem[] {
  const types = new Set(taskTypesNeedingCreateRegionSheet());
  return tasks.filter(
    (t) => t.project_id === projectId && t.type != null && types.has(String(t.type))
  );
}

export function buildChoreEdgeStatePayload(
  order: number,
  offset: { x: number; y: number } = DEFAULT_CHORE_OFFSET
): { type: 'chore'; order: number; offset: { x: number; y: number } } {
  return {
    type: 'chore',
    order,
    offset: { x: offset.x, y: offset.y },
  };
}

export function nextChoreOrderForParent(parent: TaskItem): number {
  const es = (parent.childrenEdgeState || {}) as Record<
    string,
    { type?: string; order?: unknown }
  >;
  let max = -1;
  for (const cid of parent.childrenId || []) {
    const raw = es[String(cid)];
    if (raw && raw.type === 'chore') {
      const o = Number(raw.order);
      if (Number.isFinite(o)) max = Math.max(max, o);
    }
  }
  return max + 1;
}

export function displayTitleForDumpParent(task: TaskItem): string {
  const z = task.choreZone as { title?: string } | undefined;
  const fromZone = typeof z?.title === 'string' ? z.title.trim() : '';
  const fromTask = typeof task.title === 'string' ? task.title.trim() : '';
  return fromZone || fromTask || '杂项区域';
}
