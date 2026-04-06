/**
 * 修改密码页：当前密码、新密码、确认新密码，校验后调用服务端 API。
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { changePassword } from '../api';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

const MIN_PASSWORD_LENGTH = 6;

function createChangePasswordStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.backgroundSecondary },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: c.headerBarBottomBorderWidth,
      borderBottomColor: c.headerBarBottomBorderColor,
      backgroundColor: c.headerBarBackground,
    },
    backBtn: { padding: 4 },
    headerTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader },
    headerRight: { width: 32 },
    keyboard: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 40 },
    hint: {
      fontSize: 14,
      color: c.textMuted,
      lineHeight: 20,
      marginBottom: 20,
    },
    label: {
      fontSize: 14,
      color: c.textSecondary,
      marginBottom: 8,
    },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      color: c.textPrimary,
      backgroundColor: c.inputBg,
      marginBottom: 16,
    },
    errorText: {
      fontSize: 14,
      color: c.danger,
      marginBottom: 12,
    },
    submitBtn: {
      backgroundColor: c.primary,
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      marginTop: 8,
    },
    submitBtnDisabled: { opacity: 0.7 },
    submitBtnText: { fontSize: 16, fontWeight: '600', color: c.onPrimary },
  });
}

export function ChangePasswordScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createChangePasswordStyles(colors), [colors]);
  const { session, serverBaseUrl } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async () => {
    const cur = currentPassword.trim();
    const newPwd = newPassword.trim();
    const conf = confirmPassword.trim();

    setError('');
    if (!cur) {
      setError('请输入当前密码');
      return;
    }
    if (!newPwd) {
      setError('请输入新密码');
      return;
    }
    if (newPwd.length < MIN_PASSWORD_LENGTH) {
      setError(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }
    if (newPwd !== conf) {
      setError('两次输入的新密码不一致');
      return;
    }
    if (cur === newPwd) {
      setError('新密码不能与当前密码相同');
      return;
    }

    if (!session) {
      setError('未登录');
      return;
    }

    setLoading(true);
    try {
      await changePassword(serverBaseUrl, session.user_id, cur, newPwd);
      Alert.alert('修改成功', '密码已更新，下次登录请使用新密码。', [
        { text: '确定', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    } finally {
      setLoading(false);
    }
  }, [currentPassword, newPassword, confirmPassword, session, serverBaseUrl, navigation]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="arrow-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>修改密码</Text>
        <View style={styles.headerRight} />
      </View>

      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.select({ ios: 'padding', android: undefined })}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>为保障账户安全，请先输入当前密码再设置新密码。</Text>

          <Text style={styles.label}>当前密码</Text>
          <TextInput
            style={styles.input}
            value={currentPassword}
            onChangeText={(t) => {
              setCurrentPassword(t);
              setError('');
            }}
            placeholder="请输入当前密码"
            placeholderTextColor={colors.placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!loading}
          />

          <Text style={styles.label}>新密码</Text>
          <TextInput
            style={styles.input}
            value={newPassword}
            onChangeText={(t) => {
              setNewPassword(t);
              setError('');
            }}
            placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位字符`}
            placeholderTextColor={colors.placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!loading}
          />

          <Text style={styles.label}>确认新密码</Text>
          <TextInput
            style={styles.input}
            value={confirmPassword}
            onChangeText={(t) => {
              setConfirmPassword(t);
              setError('');
            }}
            placeholder="请再次输入新密码"
            placeholderTextColor={colors.placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!loading}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={styles.submitBtnText}>确认修改</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
