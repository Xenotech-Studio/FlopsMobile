/**
 * 腾讯云人机验证（Captcha）的 WebView 承载 + Promise 化调用。
 *
 * 为什么要 WebView：腾讯云 Captcha 只有 Web SDK，且要求 JS 从
 * turing.captcha.qcloud.com 动态加载、页面有真实 https 源。RN 侧没有原生 SDK，
 * 内联 HTML（about:blank 源）会被风控判为异常设备。
 * 所以由后端提供承载页 GET /api/auth/captcha.html，这里用 URL 方式加载它。
 *
 * 用法（两行接入）：
 *     const { requestCaptcha, captchaModal } = useCaptcha(serverBaseUrl, captchaEnabled);
 *     // 发码前：
 *     const creds = await requestCaptcha();   // 用户取消会 throw，用 isCaptchaCanceled 判
 *     await sendSmsCode(session, phone, creds);
 *     // render 里挂上： {captchaModal}
 *
 * 语义与 Web 端 FlopsWeb/src/utils/captcha.js 的 obtainCaptcha 对齐：
 *   - captcha 未启用 → resolve { ticket: '', randstr: '' }（服务端也不会校验）
 *   - 用户关闭       → reject(CAPTCHA_USER_CANCELED)，调用方应静默返回，不报红
 *   - 加载/SDK 失败  → reject(Error(可读文案))
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { captchaPageUrl, type CaptchaCreds } from '../api';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

export const CAPTCHA_USER_CANCELED = 'CAPTCHA_USER_CANCELED';

export function isCaptchaCanceled(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: string; message?: string };
  return anyErr.code === CAPTCHA_USER_CANCELED || anyErr.message === CAPTCHA_USER_CANCELED;
}

function canceledError(): Error {
  const e = new Error(CAPTCHA_USER_CANCELED);
  (e as Error & { code?: string }).code = CAPTCHA_USER_CANCELED;
  return e;
}

/** 承载页 postMessage 回来的消息，协议见 backend/auth_verify/captcha_page.py */
type CaptchaMessage =
  | { type: 'ready' }
  | { type: 'success'; ticket: string; randstr: string }
  | { type: 'cancel' }
  | { type: 'error'; code?: number; message?: string };

function createStyles(c: AppColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    // 验证码弹窗自身由腾讯云 SDK 绘制，这里只提供一块透明画布
    webviewWrap: { width: '100%', height: '100%' },
    webview: { backgroundColor: 'transparent' },
    loading: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: '50%',
      alignItems: 'center',
    },
    loadingText: { marginTop: 10, fontSize: 14, color: '#fff' },
    closeBtn: {
      position: 'absolute',
      top: 48,
      right: 20,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    // c 目前只用于保持与主题系统的接线；配色由腾讯云弹窗自身决定
    _unused: { color: c.textPrimary },
  });
}

type Resolver = {
  resolve: (creds: CaptchaCreds) => void;
  reject: (err: Error) => void;
};

/**
 * @param serverBaseUrl  后端地址，用于拼 captcha.html
 * @param enabled        服务端是否启用 captcha（来自 /api/auth/config）。
 *                       false 时 requestCaptcha 直接返回空凭据，不弹窗。
 */
export function useCaptcha(serverBaseUrl: string, enabled: boolean) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const resolverRef = useRef<Resolver | null>(null);
  // WebView 每次拉起都换 key，强制 remount —— 否则第二次打开还是上一次那张已用过的验证码
  const [nonce, setNonce] = useState(0);

  const settle = useCallback((fn: (r: Resolver) => void) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setVisible(false);
    setReady(false);
    if (r) fn(r);
  }, []);

  const requestCaptcha = useCallback((): Promise<CaptchaCreds> => {
    if (!enabled) return Promise.resolve({ ticket: '', randstr: '' });
    return new Promise<CaptchaCreds>((resolve, reject) => {
      // 上一次没结束就又拉起：先把旧的按取消结束掉，避免 promise 永远悬着
      if (resolverRef.current) resolverRef.current.reject(canceledError());
      resolverRef.current = { resolve, reject };
      setReady(false);
      setNonce((n) => n + 1);
      setVisible(true);
    });
  }, [enabled]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: CaptchaMessage;
      try {
        msg = JSON.parse(event.nativeEvent.data) as CaptchaMessage;
      } catch {
        return; // 非本协议的消息一律忽略
      }
      switch (msg.type) {
        case 'ready':
          setReady(true);
          return;
        case 'success':
          settle((r) => r.resolve({ ticket: msg.ticket, randstr: msg.randstr }));
          return;
        case 'cancel':
          settle((r) => r.reject(canceledError()));
          return;
        case 'error':
          settle((r) => r.reject(new Error(msg.message || '人机验证加载失败')));
          return;
        default:
          return;
      }
    },
    [settle]
  );

  const handleClose = useCallback(() => {
    settle((r) => r.reject(canceledError()));
  }, [settle]);

  const captchaModal = (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.webviewWrap}>
          <WebView
            key={`captcha-${nonce}`}
            source={{ uri: captchaPageUrl(serverBaseUrl) }}
            onMessage={handleMessage}
            onError={() => settle((r) => r.reject(new Error('人机验证页面加载失败，请检查网络')))}
            onHttpError={({ nativeEvent }) =>
              settle((r) =>
                r.reject(new Error(`人机验证页面不可用（HTTP ${nativeEvent.statusCode}）`))
              )
            }
            style={styles.webview}
            // 验证码弹窗自身带遮罩，这里让 WebView 透明地盖在我们的半透明背景上
            backgroundColor="transparent"
            javaScriptEnabled
            domStorageEnabled
            // iOS 上验证码是页内弹层，不需要滚动
            scrollEnabled={false}
            bounces={false}
            // 腾讯云 SDK 会跳第三方域拉资源，不要拦
            originWhitelist={['*']}
          />
        </View>

        {!ready ? (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator color="#fff" />
            <Text style={styles.loadingText}>正在加载安全验证…</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={styles.closeBtn}
          onPress={handleClose}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
    </Modal>
  );

  return { requestCaptcha, captchaModal };
}
