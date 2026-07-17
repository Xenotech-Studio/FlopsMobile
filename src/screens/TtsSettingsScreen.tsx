/**
 * 语音合成（TTS）设置 —— 二级设置页。
 *
 * 目前仅一项「混音方式」：控制 App 朗读时与其它 App 声音如何共存。
 * 值写到 layout-preferences 的 `tts_mixing_mode`（跨端同步，与 tts_autoplay 同机制），
 * 改动后立即调原生 setAudioMixingMode 让下一次/正在放的 session 生效。
 *
 * 设计上预留后续项（音色选择等）：每项一张 card，照抄本页 radioGroup 结构即可。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  PanResponder,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { getLayoutPreferences, setLayoutPreferences } from '../api';
import {
  TTS_MIXING_MODE_PREF_KEY,
  DEFAULT_TTS_MIXING_MODE,
  normalizeTtsMixingMode,
  applyTtsMixingMode,
  type TtsMixingMode,
} from '../audio/ttsMixingMode';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

const MIXING_OPTIONS: ReadonlyArray<readonly [TtsMixingMode, string, string]> = [
  ['duck', '降低音量', '朗读时压低其它 App 的声音（如音乐、播客），读完自动恢复。最常用。'],
  ['mix', '直接混音', '与其它 App 的声音直接叠加，不改动它们的音量。'],
];

function createTtsSettingsStyles(c: AppColors) {
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
    radioGroup: { gap: 14 },
    radioRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    radioOuter: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: c.borderD4,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    radioOuterOn: { borderColor: c.primary },
    radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.primary },
    radioTextWrap: { flex: 1 },
    radioLabel: { fontSize: 15, color: c.textPrimary },
    radioSub: { fontSize: 13, color: c.textMuted, lineHeight: 18, marginTop: 3 },
  });
}

export function TtsSettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createTtsSettingsStyles(colors), [colors]);
  const { session } = useSession();
  const { width: screenWidth } = useWindowDimensions();
  const gestureStartX = React.useRef(0);

  const [mixingMode, setMixingMode] = useState<TtsMixingMode>(DEFAULT_TTS_MIXING_MODE);

  const loadPrefs = useCallback(async () => {
    if (!session) return;
    try {
      const prefs = await getLayoutPreferences(session);
      setMixingMode(normalizeTtsMixingMode(prefs[TTS_MIXING_MODE_PREF_KEY]));
    } catch {
      /* 保持默认 */
    }
  }, [session]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  const persistMixingMode = async (next: TtsMixingMode) => {
    setMixingMode(next);
    applyTtsMixingMode(next); // 立即下发原生生效
    if (!session) return;
    try {
      await setLayoutPreferences(session, { [TTS_MIXING_MODE_PREF_KEY]: next });
    } catch {
      /* 写回失败：本地已生效，下次拉取以服务端为准 */
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
        <Text style={styles.headerTitle}>语音合成</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>混音方式</Text>
          <Text style={styles.cardDesc}>
            朗读时如何与其它正在播放的 App 声音共存。与 Web / Desktop 共用服务端偏好。
          </Text>
          <View style={styles.radioGroup}>
            {MIXING_OPTIONS.map(([val, label, sub]) => (
              <TouchableOpacity
                key={val}
                style={styles.radioRow}
                onPress={() => persistMixingMode(val)}
                activeOpacity={0.7}
              >
                <View style={[styles.radioOuter, mixingMode === val && styles.radioOuterOn]}>
                  {mixingMode === val ? <View style={styles.radioInner} /> : null}
                </View>
                <View style={styles.radioTextWrap}>
                  <Text style={styles.radioLabel}>{label}</Text>
                  <Text style={styles.radioSub}>{sub}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
