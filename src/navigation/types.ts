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

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
    interface MainParamList extends MainTabParamList {}
  }
}
