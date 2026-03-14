/**
 * Flops Mobile - Chat + 历史对话列表（主页面带底部 Tab：Chat / Tasks / Calendar）
 */

import React from 'react';
import { StatusBar, useColorScheme, View, ActivityIndicator, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './src/context/SessionContext';
import { TaskProvider } from './src/context/TaskContext';
import { VersionWelcomeProvider } from './src/context/VersionWelcomeContext';
import { LoginScreen } from './src/screens/LoginScreen';
import { VersionWelcomeScreen } from './src/screens/VersionWelcomeScreen';
import { RootNavigator } from './src/navigation/RootNavigator';
import type { RootStackParamList } from './src/navigation/types';

const navigationRef = createNavigationContainerRef<RootStackParamList>();

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
  const isDark = useColorScheme() === 'dark';

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={isDark ? '#fff' : '#0f172a'} />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {session ? (
        <VersionWelcomeProvider>
          <NavigationContainer ref={navigationRef} initialState={initialNavState}>
            <BottomSheetModalProvider>
              <TaskProvider>
                <RootNavigator />
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
        <SessionProvider>
          <AppContent />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
});
