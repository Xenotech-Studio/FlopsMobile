/**
 * Flops Mobile - Chat + 历史对话列表（主页面带底部 Tab：Chat / Tasks / Calendar）
 */

import React, { useMemo } from 'react';
import { StatusBar, View, ActivityIndicator, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import {
  NavigationContainer,
  DarkTheme,
  DefaultTheme,
} from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useAppTheme } from './src/context/ThemeContext';
import { SessionProvider, useSession } from './src/context/SessionContext';
import { TaskProvider } from './src/context/TaskContext';
import { VersionWelcomeProvider } from './src/context/VersionWelcomeContext';
import { LoginScreen } from './src/screens/LoginScreen';
import { VersionWelcomeScreen } from './src/screens/VersionWelcomeScreen';
import { RootNavigator } from './src/navigation/RootNavigator';
import { navigationRef } from './src/navigation/navigationRef';
import { PushTokenLifecycle } from './src/notifications/PushTokenLifecycle';
import { PresenceReporter } from './src/notifications/PresenceReporter';
import { DeepLinkRouter } from './src/notifications/DeepLinkRouter';

// 参考 FlopsIOS：首帧就是聊天页，无跳转动画；返回手势可回到主页面
const initialNavState = {
  index: 1,
  routes: [
    { name: 'Main' as const },
    { name: 'Chat' as const, params: { conversationTitle: '新对话' } },
  ],
};

function AppContent() {
  const { session, isLoading } = useSession();
  const { isDark, colors } = useAppTheme();

  const navigationTheme = useMemo(
    () => ({
      ...(isDark ? DarkTheme : DefaultTheme),
      colors: {
        ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
        primary: colors.primary,
        background: colors.background,
        card: colors.surface,
        text: colors.textPrimary,
        border: colors.border,
        notification: colors.danger,
      },
    }),
    [isDark, colors]
  );

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {session ? (
        <VersionWelcomeProvider>
          <NavigationContainer ref={navigationRef} initialState={initialNavState} theme={navigationTheme}>
            <BottomSheetModalProvider>
              <TaskProvider>
                <RootNavigator />
                <DeepLinkRouter />
              </TaskProvider>
            </BottomSheetModalProvider>
          </NavigationContainer>
          <VersionWelcomeScreen />
        </VersionWelcomeProvider>
      ) : (
        <LoginScreen />
      )}
    </>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SessionProvider>
            <PushTokenLifecycle />
            <PresenceReporter />
            <AppContent />
          </SessionProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
