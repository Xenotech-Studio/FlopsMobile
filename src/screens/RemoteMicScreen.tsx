/**
 * RemoteMicScreen —— 跨设备语音输入的手机端沉浸录音页。
 *
 * 电脑端 POST /api/remote_mic/invite 触发 APNs（kind=remote_mic_invite），DeepLinkRouter
 * reset 到 Main + RemoteMic 跳入本页。状态机：
 *   checking  进页先 GET /api/remote_mic/invite/{inviteId} 验证邀请仍有效
 *   live      开 VoiceDictationSession（WS 带 invite_id + forward_to），识别结果由服务端
 *             实时转发到电脑；本页显示振幅脉冲 + 实时文本
 *   ending    停止（本机按钮或电脑端 remote_stop）后等最终结果
 *   done      「已发送到 xx」1.5s 后自动退出
 *   invalid   邀请过期/取消、网络失败或录音错误：显示原因 + 手动关闭
 *
 * 沉浸 UI 固定深色调色板（不跟随主题）；录音期间的屏幕常亮由 VoiceDictationSession
 * 内部的 setKeepScreenOn 处理，本页不重复管。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSession } from '../context/SessionContext';
import { VoiceDictationSession } from '../utils/voiceDictationMobile';
import type { RootStackParamList } from '../navigation/types';

type Phase = 'checking' | 'live' | 'ending' | 'done' | 'invalid';

export function RemoteMicScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'RemoteMic'>>();
  const { inviteId, desktopName, desktopDeviceId } = route.params;
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(insets), [insets]);

  const [phase, setPhase] = useState<Phase>('checking');
  const [invalidMsg, setInvalidMsg] = useState('');
  const [liveText, setLiveText] = useState('');

  const dictationRef = useRef<VoiceDictationSession | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leftRef = useRef(false); // goBack 只走一次（自动退出定时器 vs 手势返回竞态）
  const phaseRef = useRef<Phase>('checking');
  phaseRef.current = phase;
  const scrollRef = useRef<ScrollView>(null);

  // amp：麦克风实时振幅（~100ms 一拍，80ms 线性插值成斜坡）；breath：录音中的慢呼吸底动
  const amp = useSharedValue(0);
  const breath = useSharedValue(0);
  const doneScale = useSharedValue(0.4);

  const deviceLabel = desktopName || '电脑';

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Main');
  }, [navigation]);

  /** 停止（本机按钮或电脑端 remote_stop）：停采集发 finish，onDone 里进 done。 */
  const handleStop = useCallback(() => {
    if (phaseRef.current !== 'live') return;
    setPhase('ending');
    dictationRef.current?.stop();
  }, []);

  /** 取消：放弃本段录音直接退出（电脑端不会收到文本）。 */
  const handleCancel = useCallback(() => {
    const s = dictationRef.current;
    dictationRef.current = null;
    if (s) s.cancel();
    leave();
  }, [leave]);

  const startLive = useCallback(() => {
    if (!session || dictationRef.current) return;
    const s = new VoiceDictationSession({
      serverBaseUrl: session.server_base_url,
      token: session.access_token,
      inviteId,
      forwardTo: desktopDeviceId,
      onAmplitude: (rms) => {
        amp.value = withTiming(rms, { duration: 80, easing: Easing.linear });
      },
      onResult: (text) => setLiveText(text),
      onDone: (finalText) => {
        if (dictationRef.current === s) dictationRef.current = null;
        if (finalText) setLiveText(finalText);
        setPhase('done');
      },
      onError: (message) => {
        if (dictationRef.current === s) dictationRef.current = null;
        setInvalidMsg(message);
        setPhase('invalid');
      },
      onRemoteStop: handleStop, // 电脑端点了停止：与本机停止按钮同一路径
    });
    dictationRef.current = s;
    setPhase('live');
    void s.start();
  }, [session, inviteId, desktopDeviceId, amp, handleStop]);

  // 进页验证邀请；cancelled/expired（或任何非 pending/accepted）都算失效
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!session) {
        setInvalidMsg('未登录，无法开始录音');
        setPhase('invalid');
        return;
      }
      try {
        const base = session.server_base_url.replace(/\/+$/, '');
        const res = await fetch(`${base}/api/remote_mic/invite/${encodeURIComponent(inviteId)}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: any = await res.json();
        if (cancelled) return;
        const status = String(data?.status || '');
        if (status === 'pending' || status === 'accepted') {
          startLive();
        } else {
          setInvalidMsg(
            status === 'cancelled' ? '电脑端已取消这次邀请' : '邀请已过期，请在电脑上重新发起',
          );
          setPhase('invalid');
        }
      } catch {
        if (!cancelled) {
          setInvalidMsg('无法验证邀请，请检查网络后重试');
          setPhase('invalid');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在进页跑一次：inviteId 是路由参数，页面生命周期内不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载（含手势返回）：放弃进行中的会话，避免麦克风/WS 泄漏
  useEffect(() => {
    return () => {
      const s = dictationRef.current;
      dictationRef.current = null;
      if (s) s.cancel();
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);

  // done：勾号弹入 + 1.5s 自动退出
  useEffect(() => {
    if (phase !== 'done') return;
    doneScale.value = withSpring(1, { damping: 14, stiffness: 220 });
    exitTimerRef.current = setTimeout(leave, 1500);
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [phase, leave, doneScale]);

  // 录音中的慢呼吸底动：安静时圆环也有生命感，说话时振幅叠加在上面
  useEffect(() => {
    if (phase === 'live') {
      breath.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 1600, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(breath);
    }
  }, [phase, breath]);

  useEffect(() => {
    if (liveText) scrollRef.current?.scrollToEnd({ animated: true });
  }, [liveText]);

  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + amp.value * 0.22 }],
  }));
  const ringInnerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breath.value * 0.05 + amp.value * 0.45 }],
    opacity: 0.8 - amp.value * 0.2,
  }));
  const ringOuterStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + breath.value * 0.08 + amp.value * 0.9 }],
    opacity: 0.6 - amp.value * 0.25,
  }));
  const doneStyle = useAnimatedStyle(() => ({
    transform: [{ scale: doneScale.value }],
  }));

  const showPulse = phase === 'live' || phase === 'ending';

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Ionicons name="laptop-outline" size={18} color="rgba(255,255,255,0.55)" />
        <Text style={styles.headerText}>→ {deviceLabel}</Text>
      </View>

      <View style={styles.center}>
        {phase === 'checking' ? (
          <>
            <ActivityIndicator size="large" color="rgba(255,255,255,0.6)" />
            <Text style={styles.stateCaption}>正在确认邀请…</Text>
          </>
        ) : null}

        {showPulse ? (
          <>
            <View style={styles.pulseArea}>
              <Animated.View style={[styles.ringOuter, ringOuterStyle]} />
              <Animated.View style={[styles.ringInner, ringInnerStyle]} />
              <Animated.View style={[styles.core, coreStyle]}>
                <Ionicons name="mic" size={44} color="#fff" />
              </Animated.View>
            </View>
            <ScrollView
              ref={scrollRef}
              style={styles.textArea}
              contentContainerStyle={styles.textAreaContent}
              showsVerticalScrollIndicator={false}
            >
              <Text style={liveText ? styles.liveText : styles.liveTextPlaceholder}>
                {liveText || '开始说话，文字会实时出现在电脑上'}
              </Text>
            </ScrollView>
            {phase === 'ending' ? <Text style={styles.stateCaption}>正在完成…</Text> : null}
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <Animated.View style={doneStyle}>
              <Ionicons name="checkmark-circle" size={72} color="#30d158" />
            </Animated.View>
            <Text style={styles.doneText}>已发送到 {deviceLabel}</Text>
          </>
        ) : null}

        {phase === 'invalid' ? (
          <>
            <Ionicons name="alert-circle-outline" size={64} color="rgba(255,255,255,0.4)" />
            <Text style={styles.invalidText}>{invalidMsg || '邀请已失效'}</Text>
          </>
        ) : null}
      </View>

      <View style={styles.footer}>
        {showPulse ? (
          <>
            <Pressable
              onPress={handleStop}
              disabled={phase !== 'live'}
              style={({ pressed }) => [
                styles.stopButton,
                (pressed || phase !== 'live') && styles.dimmed,
              ]}
            >
              <View style={styles.stopSquare} />
            </Pressable>
            <Pressable onPress={handleCancel} hitSlop={12} style={styles.cancelButton}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          </>
        ) : null}
        {phase === 'checking' ? (
          <Pressable onPress={handleCancel} hitSlop={12} style={styles.cancelButton}>
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
        ) : null}
        {phase === 'invalid' ? (
          <Pressable
            onPress={leave}
            style={({ pressed }) => [styles.closeButton, pressed && styles.dimmed]}
          >
            <Text style={styles.closeText}>关闭</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function createStyles(insets: EdgeInsets) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: '#1c1c1e',
    },
    header: {
      marginTop: insets.top + 24,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    headerText: {
      color: 'rgba(255,255,255,0.55)',
      fontSize: 15,
      fontWeight: '500',
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    stateCaption: {
      marginTop: 20,
      color: 'rgba(255,255,255,0.45)',
      fontSize: 14,
    },
    pulseArea: {
      width: 220,
      height: 220,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ringOuter: {
      position: 'absolute',
      width: 200,
      height: 200,
      borderRadius: 100,
      backgroundColor: 'rgba(255,255,255,0.05)',
    },
    ringInner: {
      position: 'absolute',
      width: 160,
      height: 160,
      borderRadius: 80,
      backgroundColor: 'rgba(255,255,255,0.07)',
    },
    core: {
      width: 112,
      height: 112,
      borderRadius: 56,
      backgroundColor: '#ff453a',
      alignItems: 'center',
      justifyContent: 'center',
    },
    textArea: {
      maxHeight: 132,
      alignSelf: 'stretch',
      marginTop: 28,
      flexGrow: 0,
    },
    textAreaContent: {
      alignItems: 'center',
      paddingBottom: 4,
    },
    liveText: {
      color: 'rgba(255,255,255,0.9)',
      fontSize: 17,
      lineHeight: 26,
      textAlign: 'center',
    },
    liveTextPlaceholder: {
      color: 'rgba(255,255,255,0.35)',
      fontSize: 15,
      textAlign: 'center',
    },
    doneText: {
      marginTop: 18,
      color: 'rgba(255,255,255,0.9)',
      fontSize: 17,
      fontWeight: '500',
    },
    invalidText: {
      marginTop: 18,
      color: 'rgba(255,255,255,0.6)',
      fontSize: 15,
      textAlign: 'center',
      lineHeight: 22,
    },
    footer: {
      alignItems: 'center',
      paddingBottom: insets.bottom + 28,
    },
    stopButton: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: '#ff453a',
      alignItems: 'center',
      justifyContent: 'center',
    },
    stopSquare: {
      width: 24,
      height: 24,
      borderRadius: 6,
      backgroundColor: '#fff',
    },
    dimmed: {
      opacity: 0.55,
    },
    cancelButton: {
      marginTop: 18,
      paddingVertical: 8,
      paddingHorizontal: 24,
    },
    cancelText: {
      color: 'rgba(255,255,255,0.45)',
      fontSize: 15,
    },
    closeButton: {
      paddingVertical: 12,
      paddingHorizontal: 44,
      borderRadius: 22,
      backgroundColor: 'rgba(255,255,255,0.12)',
    },
    closeText: {
      color: 'rgba(255,255,255,0.9)',
      fontSize: 16,
      fontWeight: '500',
    },
  });
}
