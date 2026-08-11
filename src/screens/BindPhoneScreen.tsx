/**
 * 手机号补绑 / 改绑页：登录后从「账户操作」进入。
 * 流程：填手机号 → 发码 → 填验证码 → 提交绑定。
 *
 * 与 BindEmailScreen 同构，三处差异源于短信是付费通道：
 *   1. 三个端点**都要登录态**（邮箱侧 verify 不需要）
 *   2. 服务端对短信**强制 captcha**，移动端暂不支持 → 与邮箱侧一样给出去 Web 端的提示
 *   3. 号码提交前收敛成 E.164，与服务端 phone_index 的键保持一致
 *
 * 频控：本地不做任何限制，一律由服务端返回的文案兜底（429 + 中文 detail）。
 * 倒计时 30s 只是按钮的展示，与服务端返回的 cooldown 对齐。
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
  Platform,
  Alert,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { ApiHttpError, bindPhone, getAuthConfig, sendSmsCode, verifySmsCode } from '../api';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

// 与后端 code_store.normalize_phone / Web 端 BindPhoneModal 三处同规则。
// 不一致的话，提交值与服务端索引键会错位。
const PHONE_JUNK_RE = /[\s\-()（）]/g;
const PHONE_CN_RE = /^1[3-9]\d{9}$/;

/** 返回 '+8613800138000'；非中国大陆手机号返回 ''（调用方据此判非法）。 */
function normalizePhone(raw: string): string {
  if (!raw) return '';
  let s = raw.replace(PHONE_JUNK_RE, '');
  if (s.startsWith('+86')) s = s.slice(3);
  else if (s.startsWith('0086')) s = s.slice(4);
  else if (s.length === 13 && s.startsWith('86')) s = s.slice(2);
  return PHONE_CN_RE.test(s) ? `+86${s}` : '';
}

/** E.164 → '+86 138 0013 8000'，仅展示用。 */
function displayPhone(e164: string): string {
  const m = /^\+86(\d{3})(\d{4})(\d{4})$/.exec(e164);
  return m ? `+86 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/**
 * 错误 → 可读中文。服务端的 detail 已经是能直接展示的中文（含频控文案与业务错误码），
 * 有就直接用；没有才按状态码兜底。不复用 loginErrorMessage：那份的兜底文案是
 * 「登录失败…」，出现在绑定页会很怪。
 */
function bindPhoneErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiHttpError) {
    if (err.detail) return err.detail;
    switch (err.status) {
      case 400:
        return '请求参数有误，请检查后重试';
      case 401:
      case 403:
        return '登录状态已失效，请重新登录后再试';
      case 429:
        return '操作过于频繁，请稍后再试';
      case 502:
        return '短信发送失败，请稍后重试';
      case 503:
        return '短信服务暂未开启，请联系管理员';
      default:
        return fallback;
    }
  }
  const raw = err instanceof Error ? err.message.trim() : String(err ?? '').trim();
  if (!raw) return fallback;
  const lowered = raw.toLowerCase();
  if (
    lowered.includes('network') ||
    lowered.includes('failed to fetch') ||
    lowered.includes('econnrefused') ||
    lowered.includes('connection refused')
  ) {
    return '无法连接服务器，请检查网络后重试';
  }
  if (lowered.includes('timeout')) return '请求超时，请稍后再试';
  return raw.length > 160 ? fallback : raw;
}

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
    current: { fontSize: 13, color: c.textMuted, marginBottom: 16 },
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
    inputNoGap: { marginBottom: 6 },
    formatHint: { fontSize: 12, color: c.textMuted, marginBottom: 12 },
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

export function BindPhoneScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session, serverBaseUrl } = useSession();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [cooldown, setCooldown] = useState(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [captchaEnabled, setCaptchaEnabled] = useState<boolean | null>(null);

  const target = normalizePhone(phone);
  const targetValid = !!target;

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

  // 换号码后已验过的 token 立即作废
  useEffect(() => {
    setVerifyToken('');
  }, [target]);

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
    if (!session) {
      setError('未登录');
      return;
    }
    if (!targetValid) {
      setError('请填写正确的手机号（中国大陆 11 位）');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { cooldown: cd } = await sendSmsCode(session, target);
      startCooldown(cd || 30);
    } catch (err) {
      setError(bindPhoneErrorMessage(err, '验证码发送失败'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = useCallback(async () => {
    if (!session) {
      setError('未登录');
      return;
    }
    const p = normalizePhone(phone);
    const c = code.trim();
    if (!p) {
      setError('请填写正确的手机号（中国大陆 11 位）');
      return;
    }
    if (!c) {
      setError('请填写短信验证码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      let token = verifyToken;
      if (!token) {
        const v = await verifySmsCode(session, p, c);
        token = v.verify_token;
        setVerifyToken(token);
      }
      await bindPhone(session, p, token);
      Alert.alert('已绑定', `手机号已绑定为 ${displayPhone(p)}`, [
        { text: '好', onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      setError(bindPhoneErrorMessage(err, '绑定失败'));
      setVerifyToken('');
    } finally {
      setLoading(false);
    }
  }, [session, phone, code, verifyToken, navigation]);

  // 服务端对短信强制人机验证，移动端暂无 captcha 能力 → 与邮箱页同样的降级提示
  const captchaBlocking = captchaEnabled === true;
  const showFormatHint = phone.trim().length > 0 && !targetValid;

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
        <Text style={styles.headerTitle}>绑定手机号</Text>
        <View style={styles.headerRight} />
      </View>

      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>
            填入手机号并完成验证后，将作为账户的绑定手机号。改绑会替换原手机号。
          </Text>

          {captchaBlocking ? (
            <View style={styles.warnBanner}>
              <Text style={styles.warnText}>
                短信验证需要人机验证，移动端暂不支持。请先在 Web 端完成绑定。
              </Text>
            </View>
          ) : null}

          <Text style={styles.label}>手机号</Text>
          <TextInput
            style={[styles.input, showFormatHint && styles.inputNoGap]}
            value={phone}
            onChangeText={(t) => setPhone(t.replace(/[^\d+\s-]/g, ''))}
            placeholder="13800138000"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="phone-pad"
            maxLength={20}
            editable={!loading && !captchaBlocking}
            textContentType="telephoneNumber"
          />
          {showFormatHint ? (
            <Text style={styles.formatHint}>目前仅支持中国大陆 11 位手机号</Text>
          ) : null}

          <Text style={styles.label}>验证码</Text>
          <View style={styles.codeRow}>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, ''))}
              placeholder="短信里收到的 6 位验证码"
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
              maxLength={6}
              editable={!loading && !captchaBlocking}
              textContentType="oneTimeCode"
            />
            <TouchableOpacity
              style={[
                styles.codeBtn,
                (cooldown > 0 || loading || captchaBlocking || !targetValid) &&
                  styles.submitBtnDisabled,
              ]}
              disabled={cooldown > 0 || loading || captchaBlocking || !targetValid}
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
              (loading || captchaBlocking || !targetValid || !code.trim()) &&
                styles.submitBtnDisabled,
            ]}
            disabled={loading || captchaBlocking || !targetValid || !code.trim()}
            onPress={handleSubmit}
          >
            {loading ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.submitBtnText}>绑定手机号</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
