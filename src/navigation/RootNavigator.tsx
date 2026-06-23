/**
 * RootNavigator —— 单一 Stack，承载 DrawerShell 顶层、Chat / TaskDetail / TasksCalendar 子页与各设置子页。
 *
 * Profile 不再是 stack screen：由 [[ProfileSheet]] 通过 BottomSheetModalRef 唤起（DrawerShell host）。
 * 顶层页 Today / Project / Docs 不是 React Navigation 的路由，而是 DrawerShell 内部 active 状态。
 */
import React from 'react';
import { Platform } from 'react-native';
import {
  createStackNavigator,
  type StackCardInterpolationProps,
  type StackScreenProps,
} from '@react-navigation/stack';
import { DrawerShell } from '../screens/shell/DrawerShell';
import { ChatScreen } from '../screens/ChatScreen';
import { TaskDetailScreen } from '../screens/TaskDetailScreen';
import { TasksCalendarScreen } from '../screens/TasksCalendarScreen';
import { UsageSettingsScreen } from '../screens/UsageSettingsScreen';
import { AccountActionsScreen } from '../screens/AccountActionsScreen';
import { ChangePasswordScreen } from '../screens/ChangePasswordScreen';
import { BindEmailScreen } from '../screens/BindEmailScreen';
import { SoulSettingsScreen } from '../screens/SoulSettingsScreen';
import { AppearanceSettingsScreen } from '../screens/AppearanceSettingsScreen';
import { NotificationSettingsScreen } from '../screens/NotificationSettingsScreen';
import { ModelProviderSettingsScreen } from '../screens/ModelProviderSettingsScreen';
import { SlateRNSpikeScreen } from '../screens/SlateRNSpikeScreen';
import { DevTestScreen } from '../screens/DevTestScreen';
import { DocPreviewScreen } from '../screens/docs/DocPreviewScreen';
import type { RootStackParamList } from './types';
import { useAppTheme } from '../context/ThemeContext';

const Stack = createStackNavigator<RootStackParamList>();

/** 右侧滑入（与账户操作页体验一致） */
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

/** 薄 wrapper：把 RootStack 的 route.params.id 桥接给 DocPreviewScreen（屏内部用 useNavigation）。 */
function DocPreviewRoute({ route }: StackScreenProps<RootStackParamList, 'DocPreview'>) {
  return <DocPreviewScreen id={route.params.id} />;
}

export function RootNavigator() {
  const { colors } = useAppTheme();
  return (
    <Stack.Navigator
      initialRouteName="Main"
      detachInactiveScreens
      screenOptions={{
        headerShown: false,
        cardStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen
        name="Main"
        component={DrawerShell}
        options={{
          /** Android：让 DrawerShell 自己接管左缘手势，不走 RN Navigation 的边缘返回 */
          gestureEnabled: Platform.OS === 'ios',
        }}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="TaskDetail"
        component={TaskDetailScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="TasksCalendar"
        component={TasksCalendarScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="UsageSettings"
        component={UsageSettingsScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
      <Stack.Screen
        name="AccountActions"
        component={AccountActionsScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="ChangePassword"
        component={ChangePasswordScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="BindEmail"
        component={BindEmailScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="SoulSettings"
        component={SoulSettingsScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
      <Stack.Screen
        name="AppearanceSettings"
        component={AppearanceSettingsScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
      <Stack.Screen
        name="NotificationSettings"
        component={NotificationSettingsScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
      <Stack.Screen
        name="ModelProviderSettings"
        component={ModelProviderSettingsScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
      <Stack.Screen
        name="SlateRNSpike"
        component={SlateRNSpikeScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
      <Stack.Screen
        name="DevTest"
        component={DevTestScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
      {/* 文档下钻预览：compact（iPhone）走这条，整页右滑入 + 左缘滑回。 */}
      <Stack.Screen
        name="DocPreview"
        component={DocPreviewRoute}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: rightCardStyleInterpolator,
        }}
      />
    </Stack.Navigator>
  );
}
