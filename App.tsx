/**
 * Flops Mobile - 仅 Chat 功能，界面参考 FlopsDesktop
 */

import React from 'react';
import { StatusBar, useColorScheme, View, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './src/context/SessionContext';
import { LoginScreen } from './src/screens/LoginScreen';
import { ChatScreen } from './src/screens/ChatScreen';

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
      {session ? <ChatScreen /> : <LoginScreen />}
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <AppContent />
      </SessionProvider>
    </SafeAreaProvider>
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
