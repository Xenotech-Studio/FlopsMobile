/**
 * 邮箱补绑 / 改绑页：登录后从「账户操作」进入。
 * 流程：填邮箱 → 发码 → 填验证码 → 提交绑定。
 * 服务端启用 captcha 时移动端暂不支持，给出提示让用户去 Web 端操作。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { bindEmail, getAuthConfig, sendEmailCode, verifyEmailCode } from '../api';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import loginErrorMessage from '../utils/loginErrorMessage';

function createStyles(c: AppColors) {
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
    hint: { fontSize: 14, color: c.textMuted, lineHeight: 20, marginBottom: 20 },
    label: { fontSize: 14, color: c.textSecondary, marginBottom: 8 },
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
    codeRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    codeInput: { flex: 1 },
    codeBtn: {
      paddingHorizontal: 14,
      paddingVertical: 13,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.inputBg,
      minWidth: 96,
      alignItems: 'center',
    },
    codeBtnText: { fontSize: 14, color: c.textPrimary, fontWeight: '500' },
    warnBanner: {
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderMuted,
      marginBottom: 16,
    },
    warnText: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
    errorText: { fontSize: 14, color: c.danger, marginBottom: 12 },
    submitBtn: {
      backgroundColor: c.primary,
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: 'center',
      marginTop: 8,
    },
    submitBtnDisabled: { opacity: 0.5 },
    submitBtnText: { fontSize: 16, fontWeight: '600', color: c.onPrimary },
  });
}

export function BindEmailScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session, serverBaseUrl } = useSession();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [cooldown, setCooldown] = useState(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [captchaEnabled, setCaptchaEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getAuthConfig(serverBaseUrl);
        if (!cancelled) setCaptchaEnabled(Boolean(cfg.captcha_enabled));
      } catch {
        if (!cancelled) setCaptchaEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl]);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const startCooldown = (sec: number) => {
    setCooldown(sec);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
          cooldownTimerRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  const handleSendCode = async () => {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes('@')) {
      setError('请填写正确的邮箱');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { cooldown: cd } = await sendEmailCode(serverBaseUrl, e, session?.access_token);
      startCooldown(cd || 60);
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = useCallback(async () => {
    if (!session) {
      setError('未登录');
      return;
    }
    const e = email.trim().toLowerCase();
    const c = code.trim();
    if (!e || !c) {
      setError('请填写邮箱与验证码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      let token = verifyToken;
      if (!token) {
        const v = await verifyEmailCode(serverBaseUrl, e, c);
        token = v.verify_token;
        setVerifyToken(token);
      }
      await bindEmail(session, e, token);
      Alert.alert('已绑定', `邮箱已绑定为 ${e}`, [
        { text: '好', onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      setError(loginErrorMessage(err));
      setVerifyToken('');
    } finally {
      setLoading(false);
    }
  }, [session, serverBaseUrl, email, code, verifyToken, navigation]);

  const captchaBlocking = captchaEnabled === true;

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
        <Text style={styles.headerTitle}>绑定邮箱</Text>
        <View style={styles.headerRight} />
      </View>

      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
      >
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.hint}>
            填入邮箱并完成验证后，将作为账户的找回邮箱。改绑会替换原邮箱。
          </Text>

          {captchaBlocking ? (
            <View style={styles.warnBanner}>
              <Text style={styles.warnText}>
                服务端启用了人机验证，移动端暂不支持。请先在 Web 端完成绑定。
              </Text>
            </View>
          ) : null}

          <Text style={styles.label}>邮箱</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!loading && !captchaBlocking}
            textContentType="emailAddress"
          />

          <Text style={styles.label}>验证码</Text>
          <View style={styles.codeRow}>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={setCode}
              placeholder="邮箱里收到的 6 位验证码"
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
              editable={!loading && !captchaBlocking}
            />
            <TouchableOpacity
              style={[
                styles.codeBtn,
                (cooldown > 0 || loading || captchaBlocking) && styles.submitBtnDisabled,
              ]}
              disabled={cooldown > 0 || loading || captchaBlocking}
              onPress={handleSendCode}
            >
              <Text style={styles.codeBtnText}>
                {cooldown > 0 ? `${cooldown}s` : '获取验证码'}
              </Text>
            </TouchableOpacity>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[
              styles.submitBtn,
              (loading || captchaBlocking || !email.trim() || !code.trim()) &&
                styles.submitBtnDisabled,
            ]}
            disabled={loading || captchaBlocking || !email.trim() || !code.trim()}
            onPress={handleSubmit}
          >
            {loading ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.submitBtnText}>绑定邮箱</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
