/**
 * Flops Mobile - Chat + 历史对话列表（主页面带底部 Tab：Chat / Tasks / Calendar）
 */

import React, { useMemo } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SystemBars } from 'react-native-edge-to-edge';
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
import { UpgradeRequiredOverlay } from './src/components/UpgradeRequiredOverlay';
import { EncryptionReloginOverlay } from './src/components/EncryptionReloginOverlay';

// 首帧 = DrawerShell（默认 active=today）。Chat 不再预 push 在栈上：
// 由抽屉 + 按钮 / Recents / 今日页对话段 setActive 提升为顶层页，避免「两层导航」。
const initialNavState = {
  index: 0,
  routes: [{ name: 'Main' as const }],
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
      {/* SystemBars 替代 RN 自带 StatusBar —— edge-to-edge 模式下 RN StatusBar 走的是
          deprecated API（FLAG_FULLSCREEN 等），SystemBars 用现代 WindowInsets 路径同时管
          status bar + nav bar 的内容色（icon / text）。
          style='auto': 跟随当前色彩主题（dark theme → 浅色 icon；light → 深色 icon）。 */}
      <SystemBars style={isDark ? 'light' : 'dark'} />
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
      <KeyboardProvider>
        <SafeAreaProvider>
          <ThemeProvider>
            <SessionProvider>
              <PushTokenLifecycle />
              <PresenceReporter />
              <AppContent />
              <UpgradeRequiredOverlay />
              <EncryptionReloginOverlay />
            </SessionProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
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
