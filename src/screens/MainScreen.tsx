import React, { useMemo } from 'react';
import { View, Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { ConversationListScreen } from './ConversationListScreen';
import { TasksNavigator } from './TasksNavigator';
import { DocsPlaceholderScreen } from './DocsPlaceholderScreen';
import type { MainTabParamList } from '../navigation/types';
import { useAppTheme } from '../context/ThemeContext';

const Tab = createBottomTabNavigator<MainTabParamList>();

const TAB_BAR_BASE_HEIGHT = 60;

export function MainScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();

  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: colors.surface },
      headerTitleStyle: {
        fontSize: 18,
        fontWeight: '700' as const,
        color: colors.textHeader,
        ...(Platform.OS === 'android' ? { marginLeft: -22 } : {}),
      },
      headerTitleAlign: 'center' as const,
      headerShadowVisible: false,
      headerTintColor: colors.textSecondary,
      tabBarStyle: {
        backgroundColor: colors.surface,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: 8,
        paddingBottom: insets.bottom,
        height: TAB_BAR_BASE_HEIGHT + insets.bottom,
      },
      tabBarActiveTintColor: colors.textHeader,
      tabBarInactiveTintColor: colors.placeholder,
      tabBarLabelStyle: { fontSize: 12, fontWeight: '600' as const },
      ...(Platform.OS === 'android' && {
        tabBarButton: (props: React.ComponentProps<typeof PlatformPressable>) => (
          <PlatformPressable {...props} android_ripple={{ color: 'transparent' }} />
        ),
      }),
    }),
    [colors, insets.bottom]
  );

  return (
    <View style={{ flex: 1 }}>
      <Tab.Navigator initialRouteName="Chat" screenOptions={screenOptions}>
      <Tab.Screen
        name="Chat"
        component={ConversationListScreen}
        options={{
          title: '对话',
          headerShown: false,
          tabBarLabel: 'Chat',
          unmountOnBlur: true,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Tasks"
        component={TasksNavigator}
        options={{
          headerShown: false,
          title: '任务',
          tabBarLabel: 'Tasks',
          unmountOnBlur: true,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="checkmark-done" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Docs"
        component={DocsPlaceholderScreen}
        options={{
          title: 'Docs',
          tabBarLabel: 'Docs',
          unmountOnBlur: true,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="document-text" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
    </View>
  );
}
