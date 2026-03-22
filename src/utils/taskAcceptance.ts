/**
 * 项目验收环节与完成质量：与 FlowTask Web `src/apis/taskUtils.jsx` 对齐。
 */
import type { Project } from '../taskApi';

/**
 * 项目是否存在「待验收」环节（与 Web projectHasAcceptancePhase 一致）。
 */
export function projectHasAcceptancePhase(project: Project | null | undefined): boolean {
  if (!project) return true;
  if (project.skip_acceptance_phase !== undefined) return !project.skip_acceptance_phase;
  if (project.id && String(project.id).endsWith('_personal')) return false;
  return project.has_acceptance_phase !== false;
}

export type DoneQualityWhenTogglingOpts = {
  hasAcceptancePhase: boolean;
  checked: boolean;
  /** Web：Ctrl/Cmd+勾选为完全完成；移动端列表/开关默认 false */
  ctrlPressed: boolean;
  currentDoneQuality?: string | null;
  taskType?: string;
};

/**
 * 勾选/取消「完成」时应写入的 done_quality（与 Web getDoneQualityWhenToggling 一致）。
 */
export function getDoneQualityWhenToggling(opts: DoneQualityWhenTogglingOpts): string {
  const {
    hasAcceptancePhase,
    checked,
    ctrlPressed,
    currentDoneQuality,
    taskType = 'task',
  } = opts;
  if (!checked) return currentDoneQuality ?? 'reviewing';
  if (taskType === 'delegation') return 'done';
  if (!hasAcceptancePhase) return 'done';
  return ctrlPressed ? 'done' : (currentDoneQuality ?? 'reviewing');
}

/**
 * 是否显示「完成程度」选择（与 Web shouldShowDoneQualitySelect 一致）。
 */
export function shouldShowDoneQualitySelect(
  hasAcceptancePhase: boolean,
  taskType: string | undefined,
  done: boolean
): boolean {
  return hasAcceptancePhase === true && (taskType ?? 'task') === 'task' && done === true;
}
