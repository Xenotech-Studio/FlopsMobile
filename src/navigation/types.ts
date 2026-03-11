/**
 * 导航参数类型
 */

export type RootStackParamList = {
  Main: undefined;
  Chat: { conversationId?: string; conversationTitle?: string } | undefined;
  Profile: undefined;
};

export type MainTabParamList = {
  Chat: undefined;
  Tasks: undefined;
  Calendar: undefined;
};

/** Tasks 标签页内栈：今日 -> 项目列表(左滑入) -> 项目详情 -> 任务详情 */
export type TasksStackParamList = {
  TasksHome: undefined;
  ProjectList: undefined;
  ProjectDetail: { projectId: string; projectName?: string };
  TaskDetail: { taskId: string } | { projectId: string; projectName?: string };
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
    interface MainParamList extends MainTabParamList {}
  }
}
