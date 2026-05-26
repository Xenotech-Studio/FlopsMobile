import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  ScrollView,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import {
  getAuthConfig,
  login,
  registerUser,
  sendEmailCode,
  verifyEmailCode,
} from '../api';
import { normalizeServerUrl } from '../config';
import loginErrorMessage from '../utils/loginErrorMessage';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

type Mode = 'login' | 'register';

export function LoginScreen() {
  const { serverBaseUrl, loginSuccess } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createLoginStyles(colors), [colors]);
  const [mode, setMode] = useState<Mode>('login');

  // 登录 / 注册共用的账号字段
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');

  // 仅注册：邮箱 + 验证码
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [verifyToken, setVerifyToken] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // 验证码冷却（秒）
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // captcha 是否启用：启用则移动端暂不支持注册（提示走 Web 端）
  const [captchaEnabled, setCaptchaEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getAuthConfig(normalizeServerUrl(serverBaseUrl));
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

  const handleSendCode = async () => {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes('@')) {
      setError('请填写正确的邮箱');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { cooldown: cd } = await sendEmailCode(normalizeServerUrl(serverBaseUrl), e);
      startCooldown(cd || 60);
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    const uid = userId.trim();
    const pwd = password;
    const e = email.trim().toLowerCase();
    const c = code.trim();
    const base = normalizeServerUrl(serverBaseUrl);
    if (!uid || !pwd || !e || !c) {
      setError('请填写所有字段');
      return;
    }
    if (pwd.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    setError('');
    setLoading(true);
    try {
      let token = verifyToken;
      if (!token) {
        // 注册按钮一键走「验证码 → 注册」，避免用户忘记先点验证按钮
        const v = await verifyEmailCode(base, e, c);
        token = v.verify_token;
        setVerifyToken(token);
      }
      await registerUser(base, {
        user_id: uid,
        password: pwd,
        email: e,
        verify_token: token,
      });
      // 注册成功 → 自动登录
      const { session } = await login(base, uid, pwd);
      await loginSuccess(session);
    } catch (err) {
      setError(loginErrorMessage(err));
      // token 可能因失败而过期，下次让验证码再走一遍
      setVerifyToken('');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setVerifyToken('');
  };

  const captchaBlocking = mode === 'register' && captchaEnabled === true;

  return (
    <SafeAreaView style={styles.safeContainer} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.title}>{mode === 'login' ? '登录 Flops' : '注册 Flops'}</Text>

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
              placeholder={mode === 'login' ? '密码' : '密码（至少 6 位）'}
              placeholderTextColor={colors.placeholder}
              secureTextEntry
              editable={!loading}
              textContentType="password"
            />

            {mode === 'register' && (
              <>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="邮箱"
                  placeholderTextColor={colors.placeholder}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!loading && !captchaBlocking}
                  textContentType="emailAddress"
                />
                <View style={styles.codeRow}>
                  <TextInput
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={setCode}
                    placeholder="邮箱验证码"
                    placeholderTextColor={colors.placeholder}
                    keyboardType="number-pad"
                    editable={!loading && !captchaBlocking}
                  />
                  <TouchableOpacity
                    style={[
                      styles.codeBtn,
                      (cooldown > 0 || loading || captchaBlocking) && styles.btnDisabled,
                    ]}
                    disabled={cooldown > 0 || loading || captchaBlocking}
                    onPress={handleSendCode}
                  >
                    <Text style={styles.codeBtnText}>
                      {cooldown > 0 ? `${cooldown}s` : '获取验证码'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {captchaBlocking ? (
                  <View style={styles.warnBanner}>
                    <Text style={styles.warnText}>
                      服务端启用了人机验证，移动端暂不支持。请先在 Web 端注册账号后回到这里登录。
                    </Text>
                  </View>
                ) : null}
              </>
            )}

            {error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.error}>{error}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[
                styles.btn,
                styles.btnPrimary,
                (loading || captchaBlocking) && styles.btnDisabled,
              ]}
              onPress={mode === 'login' ? handleLogin : handleRegister}
              disabled={
                loading ||
                captchaBlocking ||
                (mode === 'login'
                  ? !userId.trim() || !password
                  : !userId.trim() || !password || !email.trim() || !code.trim())
              }
            >
              {loading ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.btnPrimaryText}>{mode === 'login' ? '登录' : '注册并登录'}</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.switchLink}
              onPress={() => switchMode(mode === 'login' ? 'register' : 'login')}
              disabled={loading}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.switchLinkText}>
                {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createLoginStyles(c: AppColors) {
  return StyleSheet.create({
    safeContainer: { flex: 1, backgroundColor: c.background },
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    scrollContent: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingVertical: 32,
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
    codeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    codeInput: {
      flex: 1,
    },
    codeBtn: {
      marginTop: 12,
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.inputBg,
      minWidth: 96,
      alignItems: 'center',
    },
    codeBtnText: {
      fontSize: 14,
      color: c.textPrimary,
      fontWeight: '500',
    },
    warnBanner: {
      marginTop: 14,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderMuted,
    },
    warnText: {
      color: c.textMuted,
      fontSize: 13,
      lineHeight: 19,
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
      opacity: 0.5,
    },
    switchLink: {
      marginTop: 18,
      alignItems: 'center',
    },
    switchLinkText: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '500',
    },
  });
}
