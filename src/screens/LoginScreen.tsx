import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import { login } from '../api';
import { normalizeServerUrl } from '../config';
import loginErrorMessage from '../utils/loginErrorMessage';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

export function LoginScreen() {
  const { serverBaseUrl, loginSuccess } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createLoginStyles(colors), [colors]);
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    const uid = userId.trim();
    const pwd = password;
    const base = normalizeServerUrl(serverBaseUrl);
    if (!uid || !pwd) {
      setError('请填写用户 ID 和密码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { session } = await login(base, uid, pwd);
      await loginSuccess(session);
    } catch (e) {
      setError(loginErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeContainer} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
      >
        <View style={styles.card}>
        <Text style={styles.title}>登录 Flops</Text>
        <TextInput
          style={[styles.input, styles.inputFirst]}
          value={userId}
          onChangeText={setUserId}
          placeholder="用户 ID"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!loading}
          textContentType="username"
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="密码"
          placeholderTextColor={colors.placeholder}
          secureTextEntry
          editable={!loading}
          textContentType="password"
        />
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}
        <TouchableOpacity
          style={[styles.btn, styles.btnPrimary, loading && styles.btnDisabled]}
          onPress={handleLogin}
          disabled={loading || !userId.trim() || !password}
        >
          {loading ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.btnPrimaryText}>登录</Text>
          )}
        </TouchableOpacity>
      </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createLoginStyles(c: AppColors) {
  return StyleSheet.create({
    safeContainer: { flex: 1, backgroundColor: c.background },
    container: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingVertical: 32,
      backgroundColor: c.background,
    },
    card: {
      paddingVertical: 8,
      backgroundColor: 'transparent',
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textHeader,
      marginBottom: 20,
      textAlign: 'center',
    },
    inputFirst: {
      marginTop: 0,
    },
    input: {
      marginTop: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: c.textPrimary,
      backgroundColor: c.inputBg,
    },
    errorBanner: {
      marginTop: 14,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.errorBg,
      borderWidth: 1,
      borderColor: c.roseBorder,
    },
    error: {
      color: c.danger,
      fontSize: 14,
      lineHeight: 20,
    },
    btn: {
      marginTop: 22,
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      alignSelf: 'stretch',
    },
    btnPrimary: {
      backgroundColor: c.primary,
    },
    btnPrimaryText: {
      color: c.onPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    btnDisabled: {
      opacity: 0.7,
    },
  });
}
