/**
 * 通知设置（iOS APNs 推送）。
 *
 * 与 iOS 系统权限（Settings → 通知 → FlopsMobile）正交：
 * - 本页 toggle 只控制「是否向后端登记本机设备令牌」+「是否启用推送通道」
 * - 用户在 iOS 设置里关掉通知权限时，下次回前台会自动把本页 toggle 也关掉
 *
 * 测试按钮直接打到后端 `/api/push/apns/debug`，让服务端给本人所有设备
 * 令牌发一条测试推送（与日程提醒走同一通道）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  PanResponder,
  useWindowDimensions,
  Platform,
  Linking,
  Alert,
  AppState,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { IOSStyleSwitch } from '../components/IOSStyleSwitch';
import {
  isApnsSupported,
  requestApnsPermission,
  getApnsAuthorizationStatus,
  getCachedDeviceToken,
  addApnsTokenListener,
  addApnsErrorListener,
  type ApnsAuthStatus,
} from '../notifications/apnsClient';
import {
  registerApnsToken,
  removeApnsToken,
  requestDebugApnsPush,
} from '../api/push';
import { getPushEnabled, setPushEnabled } from '../notifications/pushSettings';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

export function NotificationSettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { session, serverBaseUrl } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createNotificationSettingsStyles(colors), [colors]);
  const { width: screenWidth } = useWindowDimensions();
  const gestureStartX = useRef(0);

  const [pushEnabled, setPushEnabledState] = useState(false);
  const [iosAuthStatus, setIosAuthStatus] = useState<ApnsAuthStatus>('notDetermined');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [currentToken, setCurrentToken] = useState<string | null>(null);
  const [currentEnv, setCurrentEnv] = useState<'sandbox' | 'production' | null>(null);
  const [supported, setSupported] = useState(false);

  const refreshState = useCallback(async () => {
    if (Platform.OS !== 'ios') {
      setSupported(false);
      return;
    }
    const ok = isApnsSupported();
    setSupported(ok);
    if (!ok) return;
    const [enabled, status, cached] = await Promise.all([
      getPushEnabled(),
      getApnsAuthorizationStatus(),
      getCachedDeviceToken(),
    ]);
    setIosAuthStatus(status);
    setPushEnabledState(enabled);
    if (cached.ok) {
      setCurrentToken(cached.token);
      setCurrentEnv(cached.env);
    } else {
      setCurrentToken(null);
      setCurrentEnv(null);
    }
  }, []);

  useEffect(() => {
    void refreshState();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refreshState();
    });
    return () => sub.remove();
  }, [refreshState]);

  /** 等 native 端 token 事件（已申请权限后），最多 15 秒。 */
  const waitForToken = useCallback(
    () =>
      new Promise<
        | { kind: 'token'; token: string; env: 'sandbox' | 'production' }
        | { kind: 'error'; error: string }
        | { kind: 'timeout' }
      >((resolve) => {
        let settled = false;
        const finish = (v: any) => {
          if (settled) return;
          settled = true;
          unsubToken();
          unsubErr();
          clearTimeout(timer);
          resolve(v);
        };
        const unsubToken = addApnsTokenListener((e) =>
          finish({ kind: 'token', token: e.token, env: e.env }),
        );
        const unsubErr = addApnsErrorListener((e) => finish({ kind: 'error', error: e.error }));
        const timer = setTimeout(() => finish({ kind: 'timeout' }), 15000);
      }),
    [],
  );

  const handleTogglePush = useCallback(
    async (next: boolean) => {
      if (!session) return;
      if (!supported) {
        Alert.alert('暂不支持', '此设备未识别到推送模块（需 iOS 真机或模拟器，且已重新构建）');
        return;
      }
      if (pushBusy) return;
      setPushBusy(true);
      try {
        if (next) {
          if (iosAuthStatus === 'denied') {
            Alert.alert(
              '通知权限已被系统拒绝',
              '请前往「系统设置 → 通知 → FlopsMobile」打开通知权限，再回到本页。',
              [
                { text: '取消', style: 'cancel' },
                { text: '前往设置', onPress: () => Linking.openSettings().catch(() => {}) },
              ],
            );
            return;
          }
          const perm = await requestApnsPermission();
          if (!perm.granted) {
            await refreshState();
            Alert.alert(
              '未授权',
              '推送通道未开启。后续可在「系统设置 → 通知 → FlopsMobile」中重新打开。',
            );
            return;
          }
          let token: string | null = null;
          let env: 'sandbox' | 'production' | null = null;
          const initial = await getCachedDeviceToken();
          if (initial.ok) {
            token = initial.token;
            env = initial.env;
          } else if (initial.kind === 'register_failed') {
            Alert.alert(
              '注册失败',
              `${initial.error}\n\n常见原因：Apple 后台 App ID 未开 Push Notifications，或 provisioning profile 未含 aps-environment。`,
            );
            return;
          } else {
            const r = await waitForToken();
            if (r.kind === 'error') {
              Alert.alert('注册失败', r.error);
              return;
            }
            if (r.kind === 'timeout') {
              Alert.alert('超时', '15 秒内未拿到推送令牌；请检查网络后稍后再试。');
              return;
            }
            token = r.token;
            env = r.env;
          }
          await registerApnsToken(serverBaseUrl, session.access_token, {
            device_token: token!,
            env: env!,
          });
          await setPushEnabled(true);
          setPushEnabledState(true);
          setCurrentToken(token);
          setCurrentEnv(env);
          await refreshState();
        } else {
          if (currentToken) {
            await removeApnsToken(serverBaseUrl, session.access_token, currentToken).catch(() => {});
          }
          await setPushEnabled(false);
          setPushEnabledState(false);
        }
      } catch (e) {
        Alert.alert('操作失败', e instanceof Error ? e.message : String(e));
      } finally {
        setPushBusy(false);
      }
    },
    [iosAuthStatus, pushBusy, currentToken, refreshState, serverBaseUrl, session, supported, waitForToken],
  );

  const handleSendTestPush = useCallback(async () => {
    if (!session) return;
    if (pushTestBusy) return;
    setPushTestBusy(true);
    try {
      const r = await requestDebugApnsPush(serverBaseUrl, session.access_token, {
        title: 'Flops 测试通知',
        body: '若您看到此条，说明提醒通道工作正常 ✅',
      });
      if (!r.results.length) {
        Alert.alert(
          '尚未注册',
          `服务端未持有本机推送令牌（${r.reason || 'NoTokenRegistered'}），请先打开「接收推送通知」。`,
        );
        return;
      }
      const anyOk = r.results.some((row) => row.ok);
      if (anyOk) {
        Alert.alert(
          '已发送',
          '测试通知已发往本机；约 10 秒内未收到，请检查 iOS 系统设置中的通知权限与勿扰模式。',
        );
      } else {
        const reasons = Array.from(
          new Set(r.results.map((row) => row.reason || `HTTP ${row.status}`).filter(Boolean)),
        ).join('、');
        Alert.alert(
          '发送失败',
          `所有令牌均被 APNs 拒绝（${reasons || '未知原因'}）。请尝试关闭再打开「接收推送通知」重新登记。`,
        );
      }
    } catch (e) {
      Alert.alert('请求失败', e instanceof Error ? e.message : String(e));
    } finally {
      setPushTestBusy(false);
    }
  }, [pushTestBusy, serverBaseUrl, session]);

  const statusText = useMemo(() => {
    if (Platform.OS !== 'ios') return '此功能仅 iOS 可用';
    if (!supported) return '推送模块未加载（请重新构建）';
    if (!pushEnabled) return iosAuthStatus === 'denied' ? 'iOS 已禁用通知权限' : '未开启';
    if (iosAuthStatus === 'denied') return 'iOS 已禁用通知权限';
    if (iosAuthStatus === 'notDetermined') return '等待权限...';
    if (!currentToken) return '正在注册推送令牌...';
    return `已开启 · ${currentEnv === 'production' ? 'production' : 'sandbox'}`;
  }, [supported, pushEnabled, iosAuthStatus, currentToken, currentEnv]);

  const statusIsWarn = pushEnabled && iosAuthStatus === 'denied';
  const statusIsOk = pushEnabled && !!currentToken && iosAuthStatus !== 'denied';

  const rightEdgeClose = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10,
      onPanResponderGrant: (evt) => {
        gestureStartX.current = evt.nativeEvent.pageX;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (
          gestureState.dx < -SWIPE_THRESHOLD &&
          gestureStartX.current >= screenWidth - EDGE_WIDTH - 20
        ) {
          navigation.goBack();
        }
      },
    }),
  ).current;

  if (!session) return null;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View
        style={[styles.rightEdgeGesture, { right: 0 }]}
        {...rightEdgeClose.panHandlers}
        pointerEvents="box-only"
      />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={26} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>通知</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>推送通知</Text>
          <Text style={styles.cardDesc}>
            日程提醒等关键通知通过 Apple Push 通道下发。开启后会向 Flops 服务端登记本机的设备令牌；关闭后服务端将不再向本机推送。
          </Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>接收推送通知</Text>
            {pushBusy ? (
              <ActivityIndicator color={colors.textMuted} />
            ) : (
              <IOSStyleSwitch
                value={pushEnabled}
                onValueChange={handleTogglePush}
                /** denied 时 toggle 不允许直接打开（无意义），但保留视觉以便用户看到当前状态。 */
              />
            )}
          </View>
          <View style={styles.statusRow}>
            <Ionicons
              name={statusIsOk ? 'checkmark-circle' : statusIsWarn ? 'warning' : 'ellipse-outline'}
              size={14}
              color={statusIsOk ? colors.success : statusIsWarn ? colors.danger : colors.textMuted}
            />
            <Text
              style={[
                styles.statusText,
                statusIsOk && styles.statusOk,
                statusIsWarn && styles.statusWarn,
              ]}
            >
              {statusText}
            </Text>
          </View>
          {statusIsWarn && (
            <TouchableOpacity
              style={styles.linkBtn}
              onPress={() => Linking.openSettings().catch(() => {})}
              activeOpacity={0.7}
            >
              <Text style={styles.linkBtnText}>前往系统设置</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primary} />
            </TouchableOpacity>
          )}
        </View>

        {pushEnabled && !!currentToken && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>测试通道</Text>
            <Text style={styles.cardDesc}>
              立即让服务端给本机发一条测试推送，验证从 Flops → APNs → 本机的通道是否畅通。日程提醒走同一通道。
            </Text>
            <TouchableOpacity
              style={[styles.primaryBtn, pushTestBusy && styles.primaryBtnDisabled]}
              activeOpacity={0.8}
              disabled={pushTestBusy}
              onPress={handleSendTestPush}
            >
              {pushTestBusy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="paper-plane-outline" size={18} color={colors.onPrimary} />
                  <Text style={styles.primaryBtnText}>发送测试通知</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={styles.note}>
              发送后约 10 秒内若未收到通知，请检查 iOS 系统设置中的通知权限与勿扰模式。
            </Text>
          </View>
        )}

        {Platform.OS !== 'ios' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>仅 iOS 可用</Text>
            <Text style={styles.cardDesc}>
              本页仅适用于 iOS 设备。Android 端的提醒通道将另行接入。
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createNotificationSettingsStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.backgroundSecondary },
    rightEdgeGesture: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: EDGE_WIDTH,
      zIndex: 10,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingHorizontal: 8,
      paddingBottom: 10,
      borderBottomWidth: c.headerBarBottomBorderWidth,
      borderBottomColor: c.headerBarBottomBorderColor,
      backgroundColor: c.headerBarBackground,
    },
    headerTitle: { fontSize: 20, fontWeight: '700', color: c.textHeader, marginLeft: 2 },
    backBtn: { padding: 8, width: 44 },
    scroll: { flex: 1 },
    scrollContent: { padding: 16, paddingBottom: 32 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
    },
    cardTitle: { fontSize: 16, fontWeight: '700', color: c.textHeader, marginBottom: 8 },
    cardDesc: { fontSize: 14, color: c.textMuted, lineHeight: 20, marginBottom: 12 },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    switchLabel: { flex: 1, fontSize: 15, color: c.textPrimary },
    statusRow: {
      marginTop: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    statusText: { fontSize: 13, color: c.textSecondary },
    statusOk: { color: c.success },
    statusWarn: { color: c.danger },
    linkBtn: {
      marginTop: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      alignSelf: 'flex-start',
    },
    linkBtnText: { fontSize: 14, color: c.primary, fontWeight: '600' },
    primaryBtn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    primaryBtnDisabled: { opacity: 0.7 },
    primaryBtnText: { fontSize: 15, fontWeight: '600', color: c.onPrimary },
    note: { marginTop: 10, fontSize: 12, color: c.textMuted, lineHeight: 18 },
  });
}
