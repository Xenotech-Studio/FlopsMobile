/**
 * Flops Mobile - Chat + 历史对话列表（主页面带底部 Tab：Chat / Tasks / Calendar）
 */

import React, { useEffect, useMemo } from 'react';
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
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { ThemeProvider, useAppTheme } from './src/context/ThemeContext';
import { SessionProvider, useSession } from './src/context/SessionContext';
import { TaskProvider } from './src/context/TaskContext';
import { ConversationProvider } from './src/context/ConversationContext';
import { VersionWelcomeProvider } from './src/context/VersionWelcomeContext';
import { LoginScreen } from './src/screens/LoginScreen';
import { VersionWelcomeScreen } from './src/screens/VersionWelcomeScreen';
import { RootNavigator } from './src/navigation/RootNavigator';
import { navigationRef } from './src/navigation/navigationRef';
import { PushTokenLifecycle } from './src/notifications/PushTokenLifecycle';
import { PresenceReporter } from './src/notifications/PresenceReporter';
import { BeaconReporter } from './src/notifications/BeaconReporter';
import { TtsRealtimeController } from './src/components/TtsRealtimeController';
import { DeepLinkRouter } from './src/notifications/DeepLinkRouter';
import { AppletLinkRouter } from './src/navigation/AppletLinkRouter';
import { UpgradeRequiredOverlay } from './src/components/UpgradeRequiredOverlay';
import { EncryptionReloginOverlay } from './src/components/EncryptionReloginOverlay';
import { BroadcastModeOverlay, BroadcastInsetProvider } from './src/components/BroadcastModeOverlay';
import { RemoteMicInviteOverlay } from './src/components/RemoteMicInviteOverlay';
import { setPreviewApiImpl } from './src/flowdoc-native-input/previewApi';
import { getVideoPreviewByUrl, triggerVideoPreview } from './src/api';

// 首帧 = DrawerShell（默认 active=today）。Chat 不再预 push 在栈上：
// 由抽屉 + 按钮 / Recents / 今日页对话段 setActive 提升为顶层页，避免「两层导航」。
const initialNavState = {
  index: 0,
  routes: [{ name: 'Main' as const }],
};

function AppContent() {
  const { session, isLoading } = useSession();
  const { isDark, colors } = useAppTheme();

  /* 给 flowdoc 渲染引擎注入视频转码镜像 API（带当前 session 的鉴权）。session 变化（登录/登出）
     时重注入；登出置 null → 引擎退化为直接播原始 URL。让 flowdoc 文档里的视频在原始编码
     （如 VP9/AV1）移动端原生播放器解不了时，能查/触发后端 H.264 镜像后改播镜像。 */
  useEffect(() => {
    setPreviewApiImpl(
      session
        ? {
            readByUrl: (url) => getVideoPreviewByUrl(session, url),
            triggerForUrl: (url, fn, mt) => triggerVideoPreview(session, url, fn, mt),
          }
        : null
    );
  }, [session]);

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
                <AppletLinkRouter />
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
        {/* initialMetrics：用原生模块初始化时同步读出的初始 insets 铺首帧，避免 insets 先 0 后更新
            导致底部避让（composer / 搜索栏）"加载一下才到位"。后续 insets 变化（转屏 / 切导航模式）
            仍由 provider 正常更新。 */}
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <ThemeProvider>
            <SessionProvider>
              <PushTokenLifecycle />
              <PresenceReporter />
              <BeaconReporter />
              <TtsRealtimeController />
              {/* 全局对话列表 + inbox SSE 保活单例：常驻在 SessionProvider 下、NavigationContainer 外，
                  让 Today / Project / Drawer 三处零加载即用，SSE 不随页面卸载断开。 */}
              <ConversationProvider>
                {/* 播报激活时把页面树底部 inset 顶高，让所有页面内容为底部横条让路（不逐页改）。 */}
                <BroadcastInsetProvider>
                  <AppContent />
                </BroadcastInsetProvider>
                <UpgradeRequiredOverlay />
                <EncryptionReloginOverlay />
                {/* 播报模式沉浸式 overlay：跨所有页面套黑边 + 底部「语音播报中」横条，
                    放在 AppContent（含 NavigationContainer）之上覆盖全部导航栈。 */}
                <BroadcastModeOverlay />
                {/* 跨设备语音输入邀请确认卡片（前台经 inbox SSE 到达）：放最后压过播报 overlay。 */}
                <RemoteMicInviteOverlay />
              </ConversationProvider>
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
