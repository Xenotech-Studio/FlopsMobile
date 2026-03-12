import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { ConversationListScreen } from './ConversationListScreen';
import { TasksNavigator } from './TasksNavigator';
import type { MainTabParamList } from '../navigation/types';

const Tab = createBottomTabNavigator<MainTabParamList>();

const TAB_BAR_BASE_HEIGHT = 60;

export function MainScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1 }}>
      <Tab.Navigator
      initialRouteName="Chat"
      screenOptions={{
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: {
          fontSize: 18,
          fontWeight: '700',
          color: '#0f172a',
          ...(Platform.OS === 'android' ? { marginLeft: -22 } : {}),
        },
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerTintColor: '#374151',
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopWidth: 1,
          borderTopColor: '#e5e7eb',
          paddingTop: 8,
          paddingBottom: insets.bottom,
          height: TAB_BAR_BASE_HEIGHT + insets.bottom,
        },
        tabBarActiveTintColor: '#0f172a',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        ...(Platform.OS === 'android' && {
          tabBarButton: (props) => (
            <PlatformPressable {...props} android_ripple={{ color: 'transparent' }} />
          ),
        }),
      }}
    >
      <Tab.Screen
        name="Chat"
        component={ConversationListScreen}
        options={{
          title: '对话',
          headerShown: false,
          tabBarLabel: 'Chat',
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
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="checkmark-done" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
    </View>
  );
}
