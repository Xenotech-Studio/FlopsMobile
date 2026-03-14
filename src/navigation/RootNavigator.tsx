import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import { MainScreen } from '../screens/MainScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { AccountActionsScreen } from '../screens/AccountActionsScreen';
import { ChangePasswordScreen } from '../screens/ChangePasswordScreen';
import type { RootStackParamList } from './types';

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

export function RootNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Main"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#fff' },
      }}
    >
      <Stack.Screen name="Main" component={MainScreen} />
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
        name="AccountActions"
        component={AccountActionsScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="ChangePassword"
        component={ChangePasswordScreen}
        options={{ headerShown: false }}
      />
    </Stack.Navigator>
  );
}
