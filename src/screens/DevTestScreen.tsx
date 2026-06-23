/**
 * DevTestScreen —— 录音机开发测试页。
 *
 * 底部栏：左画廊（进 RecordingLibraryScreen）/ 中圆形录音按钮（按住说话）/ 右音频小卡片
 * （录音结束后出现，点击保存到 /api/dev/recordings）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useAppTheme } from '../context/ThemeContext';
import { useSession } from '../context/SessionContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { VoiceDictationSession } from '../utils/voiceDictationMobile';

type RecStatus = 'idle' | 'starting' | 'recording' | 'finalizing';

interface LastRecording {
  audio: ArrayBuffer;
  text: string;
  durationMs: number;
  saving: boolean;
  saved: boolean;
  saveError: string;
}

const MIC_SIZE = 88;
const SIDE_SIZE = 56;

export function DevTestScreen() {
  const { colors } = useAppTheme();
  const { session, serverBaseUrl } = useSession();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const [status, setStatus] = useState<RecStatus>('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [pressed, setPressed] = useState(false);
  const [last, setLast] = useState<LastRecording | null>(null);

  const sessionRef = useRef<VoiceDictationSession | null>(null);
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
    };
  }, []);

  const baseUrl = session?.server_base_url || serverBaseUrl;

  const captureLast = useCallback((finalText: string) => {
    const s = sessionRef.current;
    if (!s) return;
    const audio = s.getRecordedAudio();
    const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    if (audio.byteLength <= 44) return; // 只有 WAV 头说明没采到音
    setLast({ audio, text: finalText, durationMs, saving: false, saved: false, saveError: '' });
  }, []);

  const doStart = useCallback(async () => {
    if (status !== 'idle') return;
    if (!session?.access_token) {
      setError('请先登录再使用语音听写');
      return;
    }
    setError('');
    setText('');
    setStatus('starting');
    startedAtRef.current = Date.now();

    const s = new VoiceDictationSession({
      serverBaseUrl: baseUrl,
      token: session.access_token,
      onResult: (t) => setText(t),
      onDone: (t) => {
        setText(t);
        captureLast(t);
        setStatus('idle');
        sessionRef.current = null;
      },
      onError: (msg) => {
        setError(msg);
        setStatus('idle');
        sessionRef.current = null;
      },
    });
    sessionRef.current = s;
    await s.start();
    setStatus('recording');
  }, [status, session, baseUrl, captureLast]);

  const doStop = useCallback(() => {
    const s = sessionRef.current;
    if (!s || (status !== 'recording' && status !== 'starting')) return;
    setStatus('finalizing');
    s.stop();
  }, [status]);

  const handlePressIn = useCallback(() => {
    setPressed(true);
    doStart();
  }, [doStart]);

  const handlePressOut = useCallback(() => {
    setPressed(false);
    doStop();
  }, [doStop]);

  const saveLast = useCallback(async () => {
    if (!last || last.saving || last.saved) return;
    setLast({ ...last, saving: true, saveError: '' });
    try {
      const form = new FormData();
      // RN 不允许直接塞 ArrayBuffer/Blob 进 FormData,只能给 { uri, type, name }。
      // 这里把 WAV 字节先写进一个 data URL,RN 0.7x 起原生支持 base64 data uri 上传。
      const base64 = arrayBufferToBase64(last.audio);
      form.append('audio', {
        uri: `data:audio/wav;base64,${base64}`,
        type: 'audio/wav',
        name: `recording-${Date.now()}.wav`,
      } as any);
      form.append('transcribed_text', last.text || '');
      form.append('duration_ms', String(last.durationMs));
      form.append('title', '');
      const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      const res = await fetch(`${base}api/dev/recordings`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLast((prev) => (prev ? { ...prev, saving: false, saved: true } : prev));
    } catch (e: any) {
      setLast((prev) =>
        prev ? { ...prev, saving: false, saveError: e?.message || '保存失败' } : prev,
      );
    }
  }, [last, baseUrl]);

  const buttonLabel =
    status === 'finalizing'
      ? '识别中…'
      : status === 'starting'
        ? '正在连接…'
        : status === 'recording'
          ? '松开结束'
          : '按住说话';

  const isActive = status === 'recording' || status === 'starting';

  return (
    <View style={styles.root}>
      {/* 顶部返回 */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
          style={({ pressed: p }) => [styles.topButton, p && { opacity: 0.5 }]}
        >
          <Text style={[styles.topButtonText, { color: colors.textPrimary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.textPrimary }]}>录音机</Text>
        <View style={styles.topButton} />
      </View>

      {/* 结果区 */}
      <View style={styles.resultArea}>
        <View style={styles.resultCard}>
          {isActive && (
            <View style={styles.waveBar}>
              <View style={[styles.waveDot, { backgroundColor: colors.danger }]} />
              <View style={[styles.waveDot, styles.waveDotS, { backgroundColor: colors.danger }]} />
              <View style={[styles.waveDot, { backgroundColor: colors.danger }]} />
              <View style={[styles.waveDot, styles.waveDotS, { backgroundColor: colors.danger }]} />
              <View style={[styles.waveDot, { backgroundColor: colors.danger }]} />
            </View>
          )}
          {text ? (
            <Text style={styles.resultText} selectable>
              {text}
            </Text>
          ) : (
            <Text style={styles.placeholder}>
              {status === 'finalizing'
                ? '正在识别…'
                : isActive
                  ? '正在聆听…'
                  : '按住下方按钮开始说话，松开后自动识别'}
            </Text>
          )}
        </View>
        {error ? (
          <View style={[styles.errorBanner, { backgroundColor: colors.danger + '10' }]}>
            <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : null}
      </View>

      {/* 底部：左画廊 / 中录音 / 右音频卡片 */}
      <View style={styles.bottomArea}>
        {isActive && (
          <Text style={[styles.tip, { color: colors.danger }]}>
            {status === 'starting' ? '正在初始化麦克风…' : '松开按钮结束录音'}
          </Text>
        )}
        <View style={styles.bottomRow}>
          {/* 左：画廊入口 */}
          <Pressable
            onPress={() => navigation.navigate('RecordingLibrary')}
            disabled={isActive || status === 'finalizing'}
            style={({ pressed: p }) => [
              styles.sideButton,
              { borderColor: colors.border, backgroundColor: colors.surface },
              p && { opacity: 0.7 },
              (isActive || status === 'finalizing') && { opacity: 0.4 },
            ]}
            accessibilityLabel="打开录音库"
          >
            <Text style={styles.sideIcon}>🗂</Text>
          </Pressable>

          {/* 中：圆形录音按钮 */}
          <Pressable
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            disabled={status === 'finalizing'}
            style={[
              styles.micButton,
              isActive && styles.micButtonActive,
              pressed && styles.micButtonPressed,
              status === 'finalizing' && styles.micButtonDisabled,
              { borderColor: isActive ? colors.danger : colors.border },
            ]}
            accessibilityLabel={buttonLabel}
            accessibilityRole="button"
          >
            <Text style={styles.micIcon}>{status === 'finalizing' ? '…' : '🎤'}</Text>
          </Pressable>

          {/* 右：录音结束的音频小卡片 */}
          <View style={styles.sideSlot}>
            {last ? (
              <AudioPreviewCard
                last={last}
                colors={colors}
                onSave={saveLast}
                onDismiss={() => setLast(null)}
              />
            ) : (
              <View style={styles.sideButtonGhost} />
            )}
          </View>
        </View>
        <Text style={[styles.buttonLabel, { color: isActive ? colors.danger : colors.textSecondary }]}>
          {buttonLabel}
        </Text>
      </View>
    </View>
  );
}

interface AudioPreviewCardProps {
  last: LastRecording;
  colors: AppColors;
  onSave: () => void;
  onDismiss: () => void;
}

function AudioPreviewCard({ last, colors, onSave, onDismiss }: AudioPreviewCardProps) {
  const seconds = Math.max(0, Math.round(last.durationMs / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const duration = `${mm}:${ss.toString().padStart(2, '0')}`;
  const preview = (last.text || '').slice(0, 20);
  const badge = last.saving ? '…' : last.saved ? '✓' : '💾';
  const badgeColor = last.saved ? colors.success : colors.textSecondary;

  return (
    <Pressable
      onPress={onSave}
      onLongPress={onDismiss}
      disabled={last.saving}
      style={({ pressed }) => [
        styles_card.card,
        {
          backgroundColor: colors.surface,
          borderColor: last.saveError ? colors.danger : colors.border,
        },
        pressed && { opacity: 0.7 },
      ]}
      accessibilityLabel={last.saved ? '已保存到录音库' : '点击保存到录音库'}
    >
      <View style={styles_card.row}>
        <Text style={[styles_card.duration, { color: colors.textPrimary }]}>{duration}</Text>
        <Text style={[styles_card.badge, { color: badgeColor }]}>{badge}</Text>
      </View>
      <Text style={[styles_card.preview, { color: colors.textSecondary }]} numberOfLines={1}>
        {preview || '无文本'}
      </Text>
      {last.saveError ? (
        <Text style={[styles_card.err, { color: colors.danger }]} numberOfLines={1}>
          {last.saveError}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles_card = StyleSheet.create({
  card: {
    width: 110,
    minHeight: SIDE_SIZE,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  duration: { fontSize: 15, fontWeight: '600' },
  badge: { fontSize: 14, marginLeft: 4 },
  preview: { fontSize: 12, marginTop: 2 },
  err: { fontSize: 11, marginTop: 2 },
});

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // RN 默认 atob/btoa 不可靠；手写一个稳的
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Array.from(bytes.subarray(i, i + CHUNK)) as any,
    );
  }
  // global.btoa 在 Hermes 上可用
  return global.btoa(binary);
}

function createStyles(c: AppColors, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },

    topBar: {
      paddingTop: insets.top + 8,
      paddingHorizontal: 16,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    topButton: { minWidth: 60 },
    topButtonText: { fontSize: 16, fontWeight: '500' },
    topTitle: { fontSize: 16, fontWeight: '600' },

    /* ---- 结果区 ---- */
    resultArea: {
      flex: 1,
      paddingTop: 8,
      paddingHorizontal: 20,
    },
    resultCard: {
      flex: 1,
      borderRadius: 16,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      padding: 20,
    },
    waveBar: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'flex-end',
      gap: 6,
      marginBottom: 20,
      height: 32,
    },
    waveDot: {
      width: 6,
      height: 20,
      borderRadius: 3,
      opacity: 0.5,
    },
    waveDotS: { height: 12, opacity: 0.35 },
    resultText: {
      fontSize: 20,
      lineHeight: 30,
      color: c.textPrimary,
      letterSpacing: 0.3,
    },
    placeholder: {
      fontSize: 16,
      lineHeight: 26,
      color: c.textMuted,
      textAlign: 'center',
      marginTop: 40,
    },
    errorBanner: {
      marginTop: 12,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    errorText: { fontSize: 14, lineHeight: 20 },

    /* ---- 底部 ---- */
    bottomArea: {
      alignItems: 'center',
      paddingBottom: insets.bottom + 32,
      paddingTop: 20,
      paddingHorizontal: 16,
    },
    tip: {
      fontSize: 14,
      fontWeight: '500',
      marginBottom: 16,
    },
    bottomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
    },
    sideSlot: {
      width: 110,
      minHeight: SIDE_SIZE,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    sideButton: {
      width: SIDE_SIZE,
      height: SIDE_SIZE,
      borderRadius: SIDE_SIZE / 2,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sideButtonGhost: { width: SIDE_SIZE, height: SIDE_SIZE },
    sideIcon: { fontSize: 24 },
    micButton: {
      width: MIC_SIZE,
      height: MIC_SIZE,
      borderRadius: MIC_SIZE / 2,
      borderWidth: 2.5,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
    },
    micButtonActive: {
      borderWidth: 3,
      transform: [{ scale: 1.12 }],
    },
    micButtonPressed: { opacity: 0.85 },
    micButtonDisabled: { opacity: 0.4 },
    micIcon: { fontSize: 36 },
    buttonLabel: {
      fontSize: 14,
      fontWeight: '600',
      marginTop: 12,
    },
  });
}

