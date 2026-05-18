/**
 * 导航参数类型
 */

export type RootStackParamList = {
  Main: undefined;
  Chat: { conversationId?: string; conversationTitle?: string } | undefined;
  Profile: undefined;
  UsageSettings: undefined;
  AccountActions: undefined;
  ChangePassword: undefined;
  BindEmail: undefined;
  SoulSettings: undefined;
  AppearanceSettings: undefined;
  NotificationSettings: undefined;
  SlateRNSpike: undefined;
};

export type MainTabParamList = {
  Chat: undefined;
  Tasks: undefined;
  Docs: undefined;
};

/** Docs 标签页内栈：列表 → 单文档查看 */
export type DocsStackParamList = {
  DocsList: undefined;
  DocViewer: { docId: string; docName?: string };
};

/** Tasks 标签页内栈：今日 -> 项目列表(左滑入) -> 项目详情 -> 任务详情；今日左下角可进日历 */
/** 今日首页新建：无无序区时传 unorganized；有无序区时在 sheet 里选 */
export type TaskCreatePlacement =
  | 'unorganized'
  | { kind: 'chore_area'; parentTaskId: string };

export type TasksStackParamList = {
  TasksHome: undefined;
  ProjectList: undefined;
  ProjectDetail: { projectId: string; projectName?: string };
  TaskDetail:
    | { taskId: string }
    | {
        projectId: string;
        projectName?: string;
        createPlacement?: TaskCreatePlacement;
      };
  TasksCalendar: undefined;
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
    interface MainParamList extends MainTabParamList {}
  }
}
