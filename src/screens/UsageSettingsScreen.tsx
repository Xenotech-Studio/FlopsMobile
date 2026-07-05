/**
 * 用量显示偏好 + 账户用量统计（与 Web 设置 / Desktop 用量分区对齐）
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  PanResponder,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import {
  getLayoutPreferences,
  setLayoutPreferences,
  getUsageSummary,
  type UsageSummaryResponse,
} from '../api';
import {
  USAGE_CURRENCY_USD,
  USAGE_CURRENCY_CNY,
  USAGE_CURRENCY_BOTH,
  USD_TO_CNY_FIXED,
  USD_CNY_REFERENCE_NOTE,
  normalizeUsageCurrencyMode,
  type UsageCurrencyMode,
} from '../constants/pricingDisplay';
import { formatUsdCnyEstimate } from '../utils/usageDisplay';
import { IOSStyleSwitch } from '../components/IOSStyleSwitch';
import { setRealtimeEnabled, setBroadcastMode } from '../audio/ttsRealtime';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

function createUsageSettingsStyles(c: AppColors) {
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
    radioGroup: { gap: 10 },
    radioRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    radioOuter: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: c.borderD4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOuterOn: { borderColor: c.primary },
    radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.primary },
    radioLabel: { fontSize: 15, color: c.textPrimary },
    rateLine: { fontSize: 14, color: c.textSecondary },
    rateStrong: { fontWeight: '700' },
    usageHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    refreshBtn: { paddingVertical: 4, paddingHorizontal: 8 },
    refreshBtnText: { fontSize: 14, color: c.link, fontWeight: '600' },
    note: { fontSize: 12, color: c.placeholder, marginBottom: 12 },
    sectionLabel: { fontSize: 13, fontWeight: '600', color: c.textSecondary, marginBottom: 8 },
    sectionSpacer: { marginTop: 16 },
    listRow: { marginBottom: 10 },
    monthText: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
    dateText: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
    numsText: { fontSize: 13, color: c.textMutedSlate, marginTop: 2 },
    muted: { fontSize: 14, color: c.placeholder },
    errText: { fontSize: 14, color: c.danger, marginBottom: 8 },
    loader: { marginVertical: 16 },
  });
}

export function UsageSettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createUsageSettingsStyles(colors), [colors]);
  const { session } = useSession();
  const { width: screenWidth } = useWindowDimensions();
  const gestureStartX = React.useRef(0);

  const [showTokenUsageInChat, setShowTokenUsageInChat] = useState(true);
  const [ttsAutoplay, setTtsAutoplay] = useState(false);
  const [ttsBroadcast, setTtsBroadcast] = useState(false);
  const [usageCurrencyDisplay, setUsageCurrencyDisplay] = useState<UsageCurrencyMode>(() =>
    normalizeUsageCurrencyMode(undefined)
  );
  const [usageSummary, setUsageSummary] = useState<UsageSummaryResponse | null>(null);
  const [usageErr, setUsageErr] = useState('');
  const [usageLoading, setUsageLoading] = useState(false);

  const loadPrefs = useCallback(async () => {
    if (!session) return;
    try {
      const prefs = await getLayoutPreferences(session);
      if (typeof prefs.show_token_usage_in_chat === 'boolean') {
        setShowTokenUsageInChat(prefs.show_token_usage_in_chat);
      }
      if (typeof prefs.tts_autoplay === 'boolean') {
        setTtsAutoplay(prefs.tts_autoplay);
      }
      if (typeof prefs.tts_broadcast_mode === 'boolean') {
        setTtsBroadcast(prefs.tts_broadcast_mode);
      }
      if (prefs.usage_currency_display != null) {
        setUsageCurrencyDisplay(normalizeUsageCurrencyMode(prefs.usage_currency_display));
      }
    } catch {
      /* 保持默认 */
    }
  }, [session]);

  const loadUsage = useCallback(async () => {
    if (!session) return;
    setUsageLoading(true);
    setUsageErr('');
    try {
      const data = await getUsageSummary(session, 90);
      setUsageSummary(data);
    } catch (e) {
      setUsageErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUsageLoading(false);
    }
  }, [session]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const persistShowUsage = async (next: boolean) => {
    setShowTokenUsageInChat(next);
    if (!session) return;
    try {
      await setLayoutPreferences(session, { show_token_usage_in_chat: next });
    } catch {
      /* ignore */
    }
  };

  const persistTtsAutoplay = async (next: boolean) => {
    setTtsAutoplay(next);
    setRealtimeEnabled(next); // 立即驱动单例连/断（与服务端写回并行）
    if (!session) return;
    try {
      await setLayoutPreferences(session, { tts_autoplay: next });
    } catch {
      /* ignore */
    }
  };

  const persistTtsBroadcast = async (next: boolean) => {
    setTtsBroadcast(next);
    setBroadcastMode(next); // 立即驱动单例连全局流/断
    if (!session) return;
    try {
      await setLayoutPreferences(session, { tts_broadcast_mode: next });
    } catch {
      /* ignore */
    }
  };

  const persistCurrency = async (next: UsageCurrencyMode) => {
    setUsageCurrencyDisplay(next);
    if (!session) return;
    try {
      await setLayoutPreferences(session, { usage_currency_display: next });
    } catch {
      /* ignore */
    }
  };

  const rightEdgeClose = React.useRef(
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
    })
  ).current;

  if (!session) return null;

  const monthly = usageSummary?.monthly_totals ?? [];
  const dailyWithData = (usageSummary?.daily ?? []).filter((d) => d.has_data);

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
        <Text style={styles.headerTitle}>用量与显示</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>对话中的用量显示</Text>
          <Text style={styles.cardDesc}>
            与 Web / Desktop 共用服务端偏好。关闭后聊天内不再显示用量行；本页仍可查看汇总。
          </Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>在对话中显示 token 用量</Text>
            <IOSStyleSwitch value={showTokenUsageInChat} onValueChange={persistShowUsage} />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>语音朗读</Text>
          <Text style={styles.cardDesc}>
            打开后进入对话即连实时语音，助手回复时边生成边朗读；离开对话页或锁屏也会继续。与 Web / Desktop 共用同一开关。
          </Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>助手回复自动朗读</Text>
            <IOSStyleSwitch value={ttsAutoplay} onValueChange={persistTtsAutoplay} />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>播报模式（全局监听所有对话）</Text>
            <IOSStyleSwitch value={ttsBroadcast} onValueChange={persistTtsBroadcast} />
          </View>
          <Text style={styles.cardDesc}>
            播报模式像导航软件：开启后监听你所有对话的语音，离开对话页、锁屏、切到其它 App 都持续朗读；此时优先于桌面端/网页端。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>用量金额显示</Text>
          <Text style={styles.cardDesc}>参考价以何种货币展示（人民币由美元按固定汇率换算）。</Text>
          <View style={styles.radioGroup}>
            {(
              [
                [USAGE_CURRENCY_USD, '仅美元'],
                [USAGE_CURRENCY_CNY, '仅人民币'],
                [USAGE_CURRENCY_BOTH, '美元 + 人民币'],
              ] as const
            ).map(([val, label]) => (
              <TouchableOpacity
                key={val}
                style={styles.radioRow}
                onPress={() => persistCurrency(val)}
                activeOpacity={0.7}
              >
                <View style={[styles.radioOuter, usageCurrencyDisplay === val && styles.radioOuterOn]}>
                  {usageCurrencyDisplay === val ? <View style={styles.radioInner} /> : null}
                </View>
                <Text style={styles.radioLabel}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>汇率说明（展示用）</Text>
          <Text style={styles.cardDesc}>{USD_CNY_REFERENCE_NOTE}</Text>
          <Text style={styles.rateLine}>
            当前固定汇率：<Text style={styles.rateStrong}>1 USD = {USD_TO_CNY_FIXED} CNY</Text>
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.usageHeaderRow}>
            <Text style={styles.cardTitle}>用量统计（参考）</Text>
            <TouchableOpacity
              style={styles.refreshBtn}
              onPress={loadUsage}
              disabled={usageLoading}
              hitSlop={8}
            >
              <Text style={styles.refreshBtnText}>{usageLoading ? '刷新中…' : '刷新'}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.note}>UTC 按日累计；金额为本地价目表预估，非真实账单。</Text>
          {usageLoading && !usageSummary ? (
            <ActivityIndicator style={styles.loader} color={colors.textMuted} />
          ) : null}
          {usageErr ? <Text style={styles.errText}>{usageErr}</Text> : null}
          {!usageLoading || usageSummary ? (
            <>
              <Text style={styles.sectionLabel}>按月汇总（窗口内）</Text>
              {monthly.length === 0 ? (
                <Text style={styles.muted}>暂无数据</Text>
              ) : (
                monthly.map((m) => (
                  <View key={m.month ?? '?'} style={styles.listRow}>
                    <Text style={styles.monthText}>{m.month}</Text>
                    <Text style={styles.numsText} selectable>
                      {m.prompt_tokens ?? 0} in / {m.completion_tokens ?? 0} out ·{' '}
                      {formatUsdCnyEstimate(m.estimated_cost_usd, usageCurrencyDisplay)}
                    </Text>
                  </View>
                ))
              )}
              <Text style={[styles.sectionLabel, styles.sectionSpacer]}>有数据的日期（最近 90 天）</Text>
              {dailyWithData.length === 0 ? (
                <Text style={styles.muted}>暂无</Text>
              ) : (
                dailyWithData.map((d) => (
                  <View key={d.date ?? '?'} style={styles.listRow}>
                    <Text style={styles.dateText}>{d.date}</Text>
                    <Text style={styles.numsText} selectable>
                      {d.prompt_tokens ?? 0} in / {d.completion_tokens ?? 0} out ·{' '}
                      {formatUsdCnyEstimate(d.estimated_cost_usd, usageCurrencyDisplay)}
                    </Text>
                  </View>
                ))
              )}
            </>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
