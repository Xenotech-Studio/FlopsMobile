import React from 'react';
import { Platform } from 'react-native';
import { createStackNavigator } from '@react-navigation/stack';
import { MainScreen } from '../screens/MainScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { UsageSettingsScreen } from '../screens/UsageSettingsScreen';
import { AccountActionsScreen } from '../screens/AccountActionsScreen';
import { ChangePasswordScreen } from '../screens/ChangePasswordScreen';
import { BindEmailScreen } from '../screens/BindEmailScreen';
import { SoulSettingsScreen } from '../screens/SoulSettingsScreen';
import { AppearanceSettingsScreen } from '../screens/AppearanceSettingsScreen';
import { NotificationSettingsScreen } from '../screens/NotificationSettingsScreen';
import type { RootStackParamList } from './types';
import { useAppTheme } from '../context/ThemeContext';

const Stack = createStackNavigator<RootStackParamList>();

/** Profile 从左侧滑入 */
function profileCardStyleInterpolator({ current, layouts }: { current: { progress: number }; layouts: { screen: { width: number } } }) {
  return {
    cardStyle: {
      transform: [
        {
          translateX: current.progress.interpolate({
            inputRange: [0, 1],
            outputRange: [-layouts.screen.width, 0],
          }),
        },
      ],
    },
  };
}

/** 右侧滑入（与账户操作页体验一致） */
function rightCardStyleInterpolator({ current, layouts }: { current: { progress: number }; layouts: { screen: { width: number } } }) {
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
        component={MainScreen}
        options={{
          /** Android：避免与对话列表左缘「右滑开 Profile」争系统返回手势 */
          gestureEnabled: Platform.OS === 'ios',
        }}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: profileCardStyleInterpolator,
        }}
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
    </Stack.Navigator>
  );
}
