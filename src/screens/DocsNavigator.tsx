/**
 * DocsNavigator
 *
 * Docs 标签内的栈：列表（DocsList）→ 文档查看（DocViewer）。
 * 隐藏默认 header；每个子屏自己画顶部条，跟 ConversationList / TasksHome 风格一致。
 */
import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import { DocsListScreen } from './DocsListScreen';
import { DocViewerScreen } from './DocViewerScreen';
import type { DocsStackParamList } from '../navigation/types';
import { useAppTheme } from '../context/ThemeContext';

const Stack = createStackNavigator<DocsStackParamList>();

export function DocsNavigator() {
  const { colors } = useAppTheme();
  return (
    <Stack.Navigator
      initialRouteName="DocsList"
      screenOptions={{
        headerShown: false,
        cardStyle: { backgroundColor: colors.chatScreenBackground },
      }}
    >
      <Stack.Screen name="DocsList" component={DocsListScreen} />
      <Stack.Screen name="DocViewer" component={DocViewerScreen} />
    </Stack.Navigator>
  );
}
