/**
 * 导航参数类型
 *
 * 整体模型：
 *  - RootStack 根栈承载「DrawerShell（抽屉外壳，含 Today / Project / Docs 三个顶层页）」、Chat、子页与各设置页。
 *  - 顶层页之间的切换不是 React Navigation 的路由切换，而是 DrawerShell 内部 active 状态切换（每次切换重新 mount）。
 *  - Profile 不再是 stack screen，改由抽屉底栏唤起的 BottomSheetModal 承担（见 ProfileSheet）。
 */

/** 抽屉 active 顶层页 */
export type DrawerActive =
  | { kind: 'today' }
  | { kind: 'project'; projectId: string; projectName?: string }
  | { kind: 'docs' };

/** 今日页新建：无无序区时传 unorganized；有无序区时在 sheet 里选 */
export type TaskCreatePlacement =
  | 'unorganized'
  | { kind: 'chore_area'; parentTaskId: string };

export type RootStackParamList = {
  /** 主体：抽屉外壳 + 三个顶层页（Today / Project / Docs） */
  Main: undefined;
  /** 对话页：无 conversationId = 新对话 */
  Chat: { conversationId?: string; conversationTitle?: string } | undefined;
  /** 任务详情页（从今日页 / 项目页跳入） */
  TaskDetail:
    | { taskId: string }
    | {
        projectId: string;
        projectName?: string;
        createPlacement?: TaskCreatePlacement;
      };
  /** 跨项目日历（从今日页 task 段头按钮跳入） */
  TasksCalendar: undefined;
  /** 账户操作 / 改密码 / 绑邮箱 / 用量 / 灵魂设置 / 外观 / 通知 / Slate spike */
  AccountActions: undefined;
  ChangePassword: undefined;
  BindEmail: undefined;
  UsageSettings: undefined;
  SoulSettings: undefined;
  AppearanceSettings: undefined;
  NotificationSettings: undefined;
  SlateRNSpike: undefined;
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
