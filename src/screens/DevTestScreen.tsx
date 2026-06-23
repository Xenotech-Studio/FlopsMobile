import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../context/ThemeContext';
import { useSession } from '../context/SessionContext';
import type { AppColors } from '../theme/appColors';
import { VoiceDictationSession } from '../utils/voiceDictationMobile';

type RecStatus = 'idle' | 'starting' | 'recording' | 'finalizing';

const MIC_SIZE = 88;

export function DevTestScreen() {
  const { colors } = useAppTheme();
  const { session, serverBaseUrl } = useSession();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const [status, setStatus] = useState<RecStatus>('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const sessionRef = useRef<VoiceDictationSession | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    return () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    };
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

    const s = new VoiceDictationSession({
      serverBaseUrl: session.server_base_url || serverBaseUrl,
      token: session.access_token,
      onResult: (t) => setText(t),
      onDone: (t) => {
        setText(t);
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
  }, [status, session, serverBaseUrl]);

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

      {/* 底部按钮区 */}
      <View style={styles.bottomArea}>
        {(status === 'recording' || status === 'starting') && (
          <Text style={[styles.tip, { color: colors.danger }]}>
            {status === 'starting' ? '正在初始化麦克风…' : '松开按钮结束录音'}
          </Text>
        )}
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
          <Text style={[styles.micIcon]}>{status === 'finalizing' ? '…' : '🎤'}</Text>
        </Pressable>
        <Text style={[styles.buttonLabel, { color: isActive ? colors.danger : colors.textSecondary }]}>
          {buttonLabel}
        </Text>
      </View>
    </View>
  );
}

function createStyles(c: AppColors, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },

    /* ---- 结果区 ---- */
    resultArea: {
      flex: 1,
      paddingTop: insets.top + 16,
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
    },
    tip: {
      fontSize: 14,
      fontWeight: '500',
      marginBottom: 16,
    },
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
