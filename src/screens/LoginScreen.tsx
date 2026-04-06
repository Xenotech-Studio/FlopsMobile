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
  Modal,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import { login } from '../api';
import { normalizeServerUrl } from '../config';
import { getHttpDebugLogLines, clearHttpDebugLog } from '../utils/httpDebugLog';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

export function LoginScreen() {
  const { serverBaseUrl, setServerBaseUrl, loginSuccess } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createLoginStyles(colors), [colors]);
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [serverInput, setServerInput] = useState(serverBaseUrl);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);

  const handleLogin = async () => {
    const uid = userId.trim();
    const pwd = password.trim();
    const base = normalizeServerUrl(serverInput.trim());
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
      setError(e instanceof Error ? e.message : '登录失败');
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
        <Text style={styles.title}>登录</Text>
        <Text style={styles.serverLabel}>服务地址</Text>
        <TextInput
          style={styles.input}
          value={serverInput}
          onChangeText={(t) => {
            setServerInput(t);
            setServerBaseUrl(t);
          }}
          placeholder="https://your-flops-server/"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!loading}
        />
        <Text style={styles.label}>用户 ID</Text>
        <TextInput
          style={styles.input}
          value={userId}
          onChangeText={setUserId}
          placeholder="User ID"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          editable={!loading}
        />
        <Text style={styles.label}>密码</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={colors.placeholder}
          secureTextEntry
          editable={!loading}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.btn, styles.btnPrimary, loading && styles.btnDisabled]}
          onPress={handleLogin}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.btnPrimaryText}>登录</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.logLink}
          onPress={() => {
            setLogLines(getHttpDebugLogLines());
            setLogModalVisible(true);
          }}
        >
          <Text style={styles.logLinkText}>查看 HTTP 日志</Text>
        </TouchableOpacity>
      </View>
      <Modal visible={logModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>HTTP 调试日志</Text>
              <View style={styles.modalHeaderButtons}>
                <TouchableOpacity
                  onPress={() => {
                    clearHttpDebugLog();
                    setLogLines([]);
                  }}
                  style={styles.modalClearBtn}
                >
                  <Text style={styles.modalClearText}>清空</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setLogModalVisible(false)} style={styles.modalCloseBtn}>
                  <Text style={styles.modalCloseText}>关闭</Text>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView style={styles.logScroll} contentContainerStyle={styles.logScrollContent}>
              {logLines.length === 0 ? (
                <Text style={styles.logPlaceholder}>暂无日志，先点登录触发请求后再看</Text>
              ) : (
                logLines.map((line, i) => (
                  <Text key={i} style={styles.logLine} selectable>
                    {line}
                  </Text>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
      padding: 20,
      backgroundColor: c.background,
    },
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 16,
      backgroundColor: c.surface,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textHeader,
      marginBottom: 16,
    },
    serverLabel: {
      fontSize: 13,
      color: c.textSecondary,
      marginBottom: 6,
    },
    label: {
      fontSize: 13,
      color: c.textSecondary,
      marginTop: 12,
      marginBottom: 6,
    },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: c.textPrimary,
      backgroundColor: c.inputBg,
    },
    error: {
      color: c.danger,
      fontSize: 14,
      marginTop: 12,
    },
    btn: {
      marginTop: 20,
      paddingVertical: 12,
      borderRadius: 8,
      alignItems: 'center',
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
    logLink: {
      marginTop: 16,
      alignSelf: 'center',
    },
    logLinkText: {
      fontSize: 13,
      color: c.textMuted,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: c.modalBackdrop,
      justifyContent: 'flex-end',
    },
    modalBox: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      maxHeight: '80%',
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 12,
      borderBottomWidth: c.headerBarBottomBorderWidth,
      borderBottomColor: c.border,
    },
    modalTitle: { fontSize: 16, fontWeight: '600', color: c.textHeader },
    modalHeaderButtons: { flexDirection: 'row', gap: 8 },
    modalCloseBtn: { padding: 8 },
    modalCloseText: { fontSize: 15, color: c.textHeader },
    modalClearBtn: { padding: 8, marginLeft: 8 },
    modalClearText: { fontSize: 15, color: c.textMuted },
    logScroll: { maxHeight: 400 },
    logScrollContent: { padding: 12, paddingBottom: 24 },
    logPlaceholder: { fontSize: 14, color: c.placeholder },
    logLine: {
      fontSize: 11,
      color: c.textSecondary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      marginBottom: 2,
    },
  });
}
