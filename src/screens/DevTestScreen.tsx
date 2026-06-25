/**
 * DevTestScreen —— 录音机开发测试页。
 *
 * 底部栏：左画廊（进 RecordingLibraryScreen）/ 中圆形录音按钮（按住说话）/ 右音频小卡片
 * （录音结束后出现，点击保存到 /api/dev/recordings）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useAppTheme } from '../context/ThemeContext';
import { useSession } from '../context/SessionContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { VoiceDictationSession, createPlaybackSession } from '../utils/voiceDictationMobile';

type RecStatus = 'idle' | 'starting' | 'recording' | 'finalizing';

/** 从录音库「重访」带过来的回放数据 */
export interface RevisitRecording {
  id: string;
  title: string;
  durationMs: number;
  text: string;
  audioBase64: string;
}

/**
 * 录音库「+」回退（navigation.pop）回 DevTest 时，用这个模块级变量传数据——
 * 避免 navigate() 在栈里推一个全新的 DevTest（右滑入动画）。DevTestScreen 在 focus
 * 时读取并清空。ES 模块导入是只读绑定，故对外暴露 setter 而非直接赋值。
 */
export let pendingRevisit: RevisitRecording | null = null;
export function setPendingRevisit(r: RevisitRecording | null): void {
  pendingRevisit = r;
}

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
  const [playback, setPlayback] = useState<RevisitRecording | null>(null);

  const sessionRef = useRef<VoiceDictationSession | null>(null);
  const playbackRef = useRef<ReturnType<typeof createPlaybackSession> | null>(null);
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
      playbackRef.current?.stop();
      playbackRef.current = null;
    };
  }, []);

  // 从录音库「+」回退（pop）回来：focus 时读取模块级 pendingRevisit → 进入回放模式
  useEffect(() => {
    const applyPending = () => {
      if (pendingRevisit) {
        setPlayback(pendingRevisit);
        setText('');
        setError('');
        setLast(null);
        setPendingRevisit(null);
      }
    };
    applyPending(); // 覆盖「pop 后 focus 已先于本 effect 触发」的竞态
    return navigation.addListener('focus', applyPending);
  }, [navigation]);

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

    // 回放模式：用已保存的录音当输入源，不碰麦克风
    if (playback) {
      const p = createPlaybackSession({
        serverBaseUrl: baseUrl,
        token: session.access_token,
        audioBase64: playback.audioBase64,
        onResult: (t) => setText(t),
        onDone: (t) => {
          setText(t);
          setStatus('idle');
          playbackRef.current = null;
        },
        onError: (msg) => {
          setError(msg);
          setStatus('idle');
          playbackRef.current = null;
        },
      });
      playbackRef.current = p;
      await p.start();
      setStatus('recording');
      return;
    }

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
  }, [status, session, baseUrl, captureLast, playback]);

  const doStop = useCallback(() => {
    if (status !== 'recording' && status !== 'starting') return;
    if (playback) {
      const p = playbackRef.current;
      if (!p) return;
      setStatus('finalizing');
      p.stop(); // 立刻停发，即使音频后面还有内容
      return;
    }
    const s = sessionRef.current;
    if (!s) return;
    setStatus('finalizing');
    s.stop();
  }, [status, playback]);

  // 退出回放模式，回到普通麦克风录音
  const exitPlayback = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPlayback(null);
    setStatus('idle');
    setText('');
    setError('');
  }, []);

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
                  ? playback
                    ? '正在回放…'
                    : '正在聆听…'
                  : playback
                    ? '按住下方按钮，用这段录音回放识别'
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

      {/* 回放模式：正在回放的录音片段信息条 */}
      {playback && (
        <View style={styles.revisitBar}>
          <Ionicons name="albums-outline" size={18} color={colors.textSecondary} />
          <View style={styles.revisitInfo}>
            <Text style={[styles.revisitTitle, { color: colors.textPrimary }]} numberOfLines={1}>
              {playback.title || '未命名录音'} · {formatDuration(playback.durationMs)}
            </Text>
            <Text style={[styles.revisitText, { color: colors.textSecondary }]} numberOfLines={1}>
              {playback.text || '(无文本)'}
            </Text>
          </View>
          <Pressable
            onPress={exitPlayback}
            hitSlop={10}
            style={({ pressed: p }) => [styles.revisitClose, p && { opacity: 0.5 }]}
            accessibilityLabel="退出回放模式"
          >
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </Pressable>
        </View>
      )}

      {/* 底部：左画廊 / 中录音 / 右音频卡片 */}
      <View style={styles.bottomArea}>
        {isActive && (
          <Text style={[styles.tip, { color: colors.danger }]}>
            {status === 'starting'
              ? playback
                ? '正在连接…'
                : '正在初始化麦克风…'
              : playback
                ? '松开按钮结束回放'
                : '松开按钮结束录音'}
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
            <Ionicons name="folder-open-outline" size={26} color={colors.textSecondary} />
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
            <Ionicons
              name={status === 'finalizing' ? 'ellipsis-horizontal' : 'mic-outline'}
              size={36}
              color={isActive ? colors.danger : colors.textSecondary}
            />
          </Pressable>

          {/* 右：保存按钮 — 录音结束后高亮可点 */}
          {last && !last.saved ? (
            <Pressable
              onPress={saveLast}
              disabled={last.saving}
              style={({ pressed: p }) => [
                styles.sideButton,
                { borderColor: colors.success, backgroundColor: colors.surface },
                p && { opacity: 0.7 },
                last.saving && { opacity: 0.5 },
              ]}
              accessibilityLabel="保存录音"
            >
              {last.saving ? (
                <ActivityIndicator size="small" color={colors.success} />
              ) : (
                <Ionicons name="save-outline" size={24} color={colors.success} />
              )}
            </Pressable>
          ) : last?.saved ? (
            <View style={[styles.sideButton, { borderColor: colors.success, backgroundColor: colors.success + '12' }]}>
              <Ionicons name="checkmark" size={24} color={colors.success} />
            </View>
          ) : (
            <View style={styles.sideButtonGhost} />
          )}
        </View>
        <Text style={[styles.buttonLabel, { color: isActive ? colors.danger : colors.textSecondary }]}>
          {buttonLabel}
        </Text>
      </View>
    </View>
  );
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

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

    /* ---- 回放信息条 ---- */
    revisitBar: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 20,
      marginTop: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
      gap: 10,
    },
    revisitInfo: { flex: 1 },
    revisitTitle: { fontSize: 13, fontWeight: '600' },
    revisitText: { fontSize: 12, marginTop: 2 },
    revisitClose: { padding: 2 },

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
    sideButton: {
      width: SIDE_SIZE,
      height: SIDE_SIZE,
      borderRadius: SIDE_SIZE / 2,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sideButtonGhost: { width: SIDE_SIZE, height: SIDE_SIZE },
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
    buttonLabel: {
      fontSize: 14,
      fontWeight: '600',
      marginTop: 12,
    },
  });
}

