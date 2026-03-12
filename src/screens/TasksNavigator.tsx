import React from 'react';
import {
  createStackNavigator,
  type StackCardInterpolationProps,
} from '@react-navigation/stack';
import { TasksHomeScreen } from './TasksHomeScreen';
import { ProjectListScreen } from './ProjectListScreen';
import { ProjectDetailScreen } from './ProjectDetailScreen';
import { TaskDetailScreen } from './TaskDetailScreen';
import { TasksCalendarScreen } from './TasksCalendarScreen';
import type { TasksStackParamList } from '../navigation/types';

const Stack = createStackNavigator<TasksStackParamList>();

/** 今日页始终不位移，关闭时只让上层（项目列表）向左滑走 */
function tasksHomeCardInterpolator() {
  return { cardStyle: { transform: [{ translateX: 0 }] } };
}

/** 项目列表从左侧滑入；关闭时本页向左滑出（与 Profile 一致） */
function leftSlideInterpolator({ current, layouts }: StackCardInterpolationProps) {
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

export function TasksNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="TasksHome"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen
        name="TasksHome"
        component={TasksHomeScreen}
        options={{
          headerShown: false,
          cardStyleInterpolator: tasksHomeCardInterpolator,
        }}
      />
      <Stack.Screen
        name="ProjectList"
        component={ProjectListScreen}
        options={{
          headerShown: false,
          gestureEnabled: true,
          cardStyleInterpolator: leftSlideInterpolator,
        }}
      />
      <Stack.Screen
        name="ProjectDetail"
        component={ProjectDetailScreen}
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
    </Stack.Navigator>
  );
}
