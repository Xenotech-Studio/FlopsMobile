/**
 * MainPaneNavigator —— 仅 iPad sidebarShell 模式下，主区域内的嵌套 stack。
 *
 * 目的：让"点对话"等导航在**主区域内**像正常 iOS 那样新页右滑入盖住、左滑/返回箭头滑回，
 * 而侧栏（在本 navigator 外面）常驻不动。iPhone / 窄屏不走这里，仍用 RootNavigator 的全屏 push。
 *
 * 架构（单一 NavigationContainer）：
 *  - 本 navigator 渲染在 DrawerShell 的主区 pane 里，是 root stack `Main` 屏内部的嵌套 stack。
 *  - 侧栏在 navigator 外面，无法用 useNavigation 控制它；改用 ref 桥接：每个 wrapper 屏挂载时
 *    通过 useBindMainPaneNav() 把自己的 nested navigation 存进 ref，侧栏经 DrawerShell 拿 ref 驱动。
 *  - 屏复用既有组件，用薄 wrapper 把 route.params 桥接到它们现有 props（几乎不动屏内部）。
 *
 * 返回：Chat/Project 等 push 在本 nested stack 上 → react-navigation 自带右滑入动画 + 左滑返回，
 * 不用手写。Today 永远在栈底。
 */
import React, { useEffect } from 'react';
import {
  createStackNavigator,
  type StackCardInterpolationProps,
  type StackScreenProps,
} from '@react-navigation/stack';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { TodayScreen } from '../screens/TodayScreen';
import { ProjectScreen } from '../screens/ProjectScreen';
import { DocsScreen } from '../screens/DocsScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { useAppTheme } from '../context/ThemeContext';
import type { MainPaneNavRef } from '../screens/shell/MainPaneContext';
import {
  useMainPaneBind,
  useReportMainPaneSecondary,
} from '../screens/shell/MainPaneContext';

/** 主区嵌套栈的路由表 */
export type MainPaneParamList = {
  Today: undefined;
  Project: { projectId: string; projectName?: string };
  Docs: undefined;
  Chat: { conversationId?: string; conversationTitle?: string; createEncrypted?: boolean } | undefined;
};

const MainPaneStack = createStackNavigator<MainPaneParamList>();

export type MainPaneNavigation = NavigationProp<MainPaneParamList>;

/** 右侧滑入（与 root stack 设置页同款体感） */
function rightCardStyleInterpolator({ current, layouts }: StackCardInterpolationProps) {
  return {
    cardStyle: {
      transform: [
        {
          translateX: current.progress.interpolate({
            inputRange: [0, 1],
            outputRange: [layouts.screen.width, 0],
          }),
        },
      ],
    },
  };
}

/** 无动画（瞬切）：legacy Stack 没有 animationEnabled，用空 cardStyle interpolator 实现即时切换。
 *  一级页（Today/Project/Docs）由侧栏 reset 切换时用它 → 不滑入。 */
function noAnimationInterpolator() {
  return { cardStyle: {} };
}
/** 瞬切的 transitionSpec：时长 0，配合 noAnimationInterpolator 彻底无过渡。 */
const instantTransitionSpec = {
  open: { animation: 'timing' as const, config: { duration: 0 } },
  close: { animation: 'timing' as const, config: { duration: 0 } },
};

/** 每个 wrapper 屏挂载时把 nested navigation 绑到共享 ref（供侧栏驱动）+ focus 时声明是否二级页
 *  （二级页 = 对话等 push 出来的页，主区左上角是返回键 → DrawerShell 才显示分界线切换钮）。 */
function useBindNav(isSecondary: boolean) {
  const navigation = useNavigation<MainPaneNavigation>();
  const bind = useMainPaneBind();
  useEffect(() => {
    bind(navigation as unknown as MainPaneNavRef);
  }, [navigation, bind]);
  useReportMainPaneSecondary(isSecondary);
}

function TodayRoute() {
  useBindNav(false);
  return <TodayScreen />;
}

function ProjectRoute({ route }: StackScreenProps<MainPaneParamList, 'Project'>) {
  useBindNav(false);
  return (
    <ProjectScreen
      projectId={route.params.projectId}
      projectName={route.params.projectName}
    />
  );
}

function DocsRoute() {
  useBindNav(false);
  return <DocsScreen />;
}

function ChatRoute({ route }: StackScreenProps<MainPaneParamList, 'Chat'>) {
  useBindNav(true);
  const p = route.params ?? undefined;
  return (
    <ChatScreen
      conversationIdOverride={p?.conversationId}
      conversationTitleOverride={p?.conversationTitle}
      createEncrypted={Boolean(p?.createEncrypted)}
      /* mainPane=true：主区嵌套栈模式。底层 Today 显示汉堡（开/合侧栏）；push 出来的 Chat 显示返回箭头。
       *  跟 inDrawer（compact 覆盖式抽屉顶层页）区分：那个永远汉堡、不可返回。 */
      mainPane
    />
  );
}

export function MainPaneNavigator() {
  const { colors } = useAppTheme();
  return (
    <MainPaneStack.Navigator
      initialRouteName="Today"
      screenOptions={{
        headerShown: false,
        cardStyle: { backgroundColor: colors.chatScreenBackground },
        /* 默认瞬切：一级页（Today/Project/Docs）由侧栏点条目 reset 切换 → 无过渡动画。 */
        cardStyleInterpolator: noAnimationInterpolator,
        transitionSpec: instantTransitionSpec,
      }}
    >
      <MainPaneStack.Screen name="Today" component={TodayRoute} />
      <MainPaneStack.Screen name="Project" component={ProjectRoute} />
      <MainPaneStack.Screen name="Docs" component={DocsRoute} />
      {/* 仅二级页 Chat 用右滑入动画 + 可左滑返回——这是「进对话」要的正常 iOS 导航感。 */}
      <MainPaneStack.Screen
        name="Chat"
        component={ChatRoute}
        options={{
          cardStyleInterpolator: rightCardStyleInterpolator,
          gestureEnabled: true,
          transitionSpec: {
            open: { animation: 'spring', config: { stiffness: 1000, damping: 500, mass: 3, overshootClamping: true, restDisplacementThreshold: 0.01, restSpeedThreshold: 0.01 } },
            close: { animation: 'spring', config: { stiffness: 1000, damping: 500, mass: 3, overshootClamping: true, restDisplacementThreshold: 0.01, restSpeedThreshold: 0.01 } },
          },
        }}
      />
    </MainPaneStack.Navigator>
  );
}
