/**
 * RemoteMicScreen —— 跨设备语音输入的手机端沉浸录音页（per-press PTT）。
 *
 * 电脑端 POST /api/remote_mic/invite 触发 APNs（kind=remote_mic_invite），DeepLinkRouter
 * reset 到 Main + RemoteMic 跳入本页。「连接」由控制面 invite 记录承载（remote_mic.py），
 * 录音本身按次：每次按住 new 一个普通 VoiceDictationSession（只传 forwardTo 不传 inviteId
 * ——免邀请直转模式），松手 stop()；服务端把这一次的 begin/result/done SSE 流到电脑，
 * done 后电脑 commit 灰字、chip 回已连接态。
 *
 *   checking    进页 POST /api/remote_mic/invite/{id}/accept：标记已连接，电脑 chip 亮起
 *   idle        就绪：按住大圆钮说话；每次按住时并发 GET /invite/{id} 查电脑是否已断开。
 *               说过话之后右侧发送键点亮（见下）
 *   recording   按住中：振幅脉冲 + 实时灰字
 *   finalizing  松手后等本次识别定稿（onDone），期间按钮禁用；定稿淡化留在屏上到下一次
 *               按住（只显示当前这句，不累计历史 —— 电脑 composer 才是唯一真实内容源）
 *   ending      结束中（左上角关闭 / 电脑端 remote_stop）：等在途的一次收尾后 bye
 *   done        「已发送到 xx」1.5s 后自动退出
 *   bye         电脑端主动断开（非异常）：显示已断开 + 1.5s 自动退出
 *   invalid     邀请失效 / 意外出错：显示原因 + 手动关闭
 *
 * 发送键（PTT 右侧）：POST /invite/{id}/send → SSE(event=send) → 电脑把 composer 里已落的
 * 听写文字真正发出去（等同用户在电脑上点发送按钮）。**不结束会话** —— 发完停在 idle，可以接着
 * 说下一条；结束连接仍走左上角关闭。
 *
 * idle / recording / finalizing 三个相位都可发，**在录时点了即打断**：不等火山最后一帧，此刻
 * 已识别的文字立即在电脑上转正并发出（与手机聊天页本机听写、电脑端发送键同一取舍，代价是丢掉
 * 最后一帧的标点/同音字修正，换即时性）。可用判据见 canSend —— 手机看不见电脑 composer，只能
 * 用「本次连接说过话 / 这一段已识别出字」近似「有内容可发」；电脑侧真正的空内容/附件/排队门槛
 * 在 handleSendMessage 里，手机不重复判断，故提示语只说「已发送」而非「已发出消息」。
 * 打断路径的顺序要点（先 POST 再 cancel）与迟到帧处理见 handleSend 注释。
 *
 * 结束方式：本页左上角关闭（POST bye 清电脑 chip）、电脑断开（服务端广播 SSE bye 经
 * remoteMicInviteBus 即时结束本页；在录时另有 remote_stop 打断在录的一次；按住前的
 * GET 轮询兜底 SSE 断线）。手势返回/卸载：取消在录的一次 + 补发 bye（幂等，只发一次）。
 * app 切后台（AppState→background，进任务中心/按 home）：立即结束 + 补 bye，别让离开后
 * 电脑 mic 还亮着。进程被从任务中心强杀时卸载 effect 来不及跑，靠录音页每 5s 的 /ping 心跳
 * ——心跳一停，服务端 death sweeper ~20s 内判掉线、SSE bye 清电脑 chip（兜底 background 的
 * bye 没送达就被杀 / 直接从前台强杀）。
 *
 * 沉浸 UI 固定深色调色板（不跟随主题）；录音中的屏幕常亮由 VoiceDictationSession 按次持有。
 *
 * 音频侧走 captureOnly（纯采集）档：本页只收音、不放音，故不申请任何输出路由，输入锁死内置麦。
 * 普通听写那套 playAndRecord + allowBluetoothA2DP 会把 AirPods 从电脑抢过来（电脑输出设备消失
 * → 系统按「耳机被拔」暂停正在播的视频），详见 voiceDictationMobile 的 captureOnly 说明。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import { AudioManager } from 'react-native-audio-api';
import { useSession } from '../context/SessionContext';
import { subscribeRemoteMicBye } from '../utils/remoteMicInviteBus';
import {
  VoiceDictationSession,
  acquireKeepScreenOn,
  releaseKeepScreenOn,
} from '../utils/voiceDictationMobile';
import type { RootStackParamList } from '../navigation/types';

type Phase = 'checking' | 'idle' | 'recording' | 'finalizing' | 'ending' | 'bye' | 'done' | 'invalid';

export function RemoteMicScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'RemoteMic'>>();
  const { inviteId, desktopName, desktopDeviceId } = route.params;
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(insets), [insets]);

  const [phase, setPhase] = useState<Phase>('checking');
  const [invalidMsg, setInvalidMsg] = useState('');
  // 只显示当前这句：按住时实时识别，松手后定稿淡化留存，下一次按住即清。
  // 不累计历史 —— 电脑 composer 才是唯一真实内容源（那边可自由编辑，这边不做镜像）
  const [lastText, setLastText] = useState(''); // 上一句定稿（淡化显示）
  const [segmentText, setSegmentText] = useState('');
  const [notice, setNotice] = useState(''); // 单次按住出错等非致命提示，短暂显示
  const [noticeTone, setNoticeTone] = useState<'warn' | 'ok'>('warn');
  // 本次连接内是否已经说出过内容 —— 即电脑 composer 里大概率有我们落下的字，发送键据此启用。
  // 跨多次按住累计（每次按住的文字都追加进同一个 composer），发送成功后归零。
  const [dictatedAny, setDictatedAny] = useState(false);
  const [sending, setSending] = useState(false);

  const dictationRef = useRef<VoiceDictationSession | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leftRef = useRef(false); // goBack 只走一次（自动退出定时器 vs 手势返回竞态）
  const acceptedRef = useRef(false); // accept 成功过才需要 bye
  const byeSentRef = useRef(false); // bye 只发一次（关闭按钮与卸载清理竞态）
  const sendingRef = useRef(false); // 发送请求在途（防连点：state 更新是异步的，按钮 disabled 慢半拍）
  const phaseRef = useRef<Phase>('checking');
  phaseRef.current = phase;
  const scrollRef = useRef<ScrollView>(null);

  // amp：麦克风实时振幅（~100ms 一拍，80ms 线性插值成斜坡）；breath：录音中的慢呼吸底动
  const amp = useSharedValue(0);
  const breath = useSharedValue(0);
  const doneScale = useSharedValue(0.4);
  // bye/invalid 终止态的淡入：从录音态瞬切会像 crash，短 fade 让结束看起来是收尾
  const endFade = useSharedValue(0);

  const deviceLabel = desktopName || '电脑';
  const displayText = segmentText || lastText;

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Main');
  }, [navigation]);

  /** 通知电脑清 chip（accepted→closed）。幂等：只在 accept 成功过且未发过时发。 */
  const sendBye = useCallback(() => {
    if (!acceptedRef.current || byeSentRef.current || !session) return;
    byeSentRef.current = true;
    const base = session.server_base_url.replace(/\/+$/, '');
    void fetch(`${base}/api/remote_mic/invite/${encodeURIComponent(inviteId)}/bye`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch(() => {});
  }, [session, inviteId]);
  const sendByeRef = useRef(sendBye);
  sendByeRef.current = sendBye;

  const flashNotice = useCallback((msg: string, tone: 'warn' | 'ok' = 'warn') => {
    setNotice(msg);
    setNoticeTone(tone);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 4000);
  }, []);

  /** 会话失效收尾（邀请过期/网络错误）：取消在录的一次，进 invalid。 */
  const endAsInvalid = useCallback(
    (msg: string) => {
      const s = dictationRef.current;
      dictationRef.current = null;
      if (s) s.cancel();
      amp.value = withTiming(0, { duration: 200 });
      setSegmentText('');
      setInvalidMsg(msg);
      setPhase('invalid');
    },
    [amp],
  );

  /** 电脑端主动断开（非异常）：友好提示 + 1.5s 自动退出。不用 invalid 的警告图标。 */
  const endDisconnected = useCallback(
    (reason: string) => {
      const s = dictationRef.current;
      dictationRef.current = null;
      if (s) s.cancel();
      sendByeRef.current(); // 立刻通知电脑清 mic（幂等），不等 1.5s 后卸载兜底
      amp.value = withTiming(0, { duration: 200 });
      setSegmentText('');
      setInvalidMsg(reason);
      setPhase('bye');
      exitTimerRef.current = setTimeout(leave, 1500);
    },
    [amp, leave],
  );

  /** 按住时并发查电脑是否已断开（GET /invite/{id}）。网络抖动放过，这一次照常识别。 */
  const checkDesktopAlive = useCallback(async () => {
    if (!session) return;
    try {
      const base = session.server_base_url.replace(/\/+$/, '');
      const res = await fetch(`${base}/api/remote_mic/invite/${encodeURIComponent(inviteId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;
      const data: any = await res.json();
      const status = String(data?.status || '');
      if (status === 'accepted') return;
      const p = phaseRef.current;
      if (p !== 'idle' && p !== 'recording' && p !== 'finalizing') return;
      if (status === 'disconnected') {
          endDisconnected('电脑端已断开连接');
        } else {
          endAsInvalid('连接已失效，请在电脑上重新发起');
        };
    } catch {
      /* 网络抖动：放过 */
    }
  }, [session, inviteId, endAsInvalid, endDisconnected]);

  /** 「发送」：让电脑把 composer 里已落的听写文字真正发出去（等同在电脑上点发送按钮）。
   *
   *  不结束会话 —— 发完停在 idle，可以接着说下一条。这与左上角关闭（结束连接）是两回事。
   *
   *  **在录/定稿中也放行，点了即打断**：与手机聊天页本机听写、以及电脑端发送键同一取舍
   *  （见 localDictationStore 的 stopLocalDictation(false)）—— 不等火山最后一帧，此刻已识别
   *  的文字立即在电脑上转正并发出。代价是丢掉最后一帧的标点/同音字修正，换即时性。
   *
   *  **顺序关键：先 POST，成功后才 cancel 本次会话，两步不能反。**
   *  反过来的话服务端会先发出 cancelled 帧，而电脑端收到 cancelled 会把在途灰字丢弃
   *  （remoteMicStore 的 cancelled 分支），等 send 到达时 composer 已空、什么都发不出去。
   *  先 POST 就能保证同一条 SSE 流上 send 一定排在 cancelled 前面，顺序确定。
   *  被打断那次的迟到 result / 终态帧由电脑端 abortedSessionRef 按 sessionId 丢弃。
   *
   *  失败天然无损：只在成功后才动会话，网络失败时录音照常继续，用户可正常松手或重试。
   *
   *  电脑真正的发送门槛（composer 是否为空、附件是否传完、agent 在跑时入待发队列）全在电脑侧，
   *  手机看不见 composer 内容 —— 所以 ok=true 只代表指令已送达电脑，提示语也只说「已发送」。
   *  非 accepted 的返回顺带当一次探活，走与 checkDesktopAlive 相同的失效路径。 */
  const handleSend = useCallback(async () => {
    if (!session || sendingRef.current) return;
    const p0 = phaseRef.current;
    if (p0 !== 'idle' && p0 !== 'recording' && p0 !== 'finalizing') return;
    sendingRef.current = true;
    setSending(true); // 只驱动按钮转圈 / caption，phase 不动 —— 失败时无需回滚
    try {
      const base = session.server_base_url.replace(/\/+$/, '');
      const res = await fetch(
        `${base}/api/remote_mic/invite/${encodeURIComponent(inviteId)}/send`,
        { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      if (data?.ok === true) {
        // 电脑已收下并已提交。此刻才杀在录的这一次（若有）：cancel() 不回调 onDone/onError
        // （内部先 _teardown 摘掉 handler），不会有野回调把状态机带回 idle 之外。
        const s = dictationRef.current;
        dictationRef.current = null;
        if (s) s.cancel();
        amp.value = withTiming(0, { duration: 200 });
        setSegmentText('');
        setLastText('');
        setDictatedAny(false);
        setPhase('idle');
        flashNotice(`已发送到 ${deviceLabel}`, 'ok');
        return;
      }
      const status = String(data?.status || '');
      const p = phaseRef.current;
      if (p !== 'idle' && p !== 'recording' && p !== 'finalizing') return;
      if (status === 'disconnected') endDisconnected('电脑端已断开连接');
      else endAsInvalid('连接已失效，请在电脑上重新发起');
    } catch {
      flashNotice('发送失败，请重试'); // 会话未动，继续录/继续等定稿
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    // 内容门槛（说过话 / 这一段已识别出字）在 canSend 里，不在此重复；这里只守相位与并发
  }, [session, inviteId, deviceLabel, amp, flashNotice, endDisconnected, endAsInvalid]);

  /** 结束整个会话（左上角关闭或电脑端 remote_stop）：等在途的一次收尾后 bye + done。 */
  const handleStop = useCallback(() => {
    const p = phaseRef.current;
    if (p === 'idle') {
      sendBye();
      setPhase('done');
    } else if (p === 'recording') {
      setPhase('ending');
      amp.value = withTiming(0, { duration: 200 });
      dictationRef.current?.stop();
    } else if (p === 'finalizing') {
      setPhase('ending'); // stop() 已发，onDone 里接力 bye + done
    }
  }, [sendBye, amp]);

  /** 放弃并退出：取消在录的一次 + 补发 bye。 */
  const abandonAndLeave = useCallback(() => {
    const s = dictationRef.current;
    dictationRef.current = null;
    if (s) s.cancel();
    sendBye();
    leave();
  }, [sendBye, leave]);

  /** 左上角关闭：跟电脑断开一样的 bye 态 —— 用户感觉在「发送断开信号」，系统正在可靠
   *  处理结束流程（实际上确实调了 sendBye，但 1.5s 延迟退出本身已经给了这种心理暗示）。 */
  const handleClose = useCallback(() => {
    endDisconnected('已断开连接');
  }, [endDisconnected]);

  /** PTT 按下：new 一个一次性听写会话开录（每次按住 = 一条 WS = 电脑上一段灰字）。 */
  const handlePressIn = useCallback(() => {
    if (phaseRef.current !== 'idle' || !session || dictationRef.current) return;
    setPhase('recording');
    setLastText(''); // 新一句：清掉上一句的淡化定稿
    void checkDesktopAlive(); // 并发查电脑是否已断开，不阻塞开录
    const s = new VoiceDictationSession({
      serverBaseUrl: session.server_base_url,
      token: session.access_token,
      forwardTo: desktopDeviceId, // 不带 inviteId：免邀请直转，识别结果实时转发到电脑
      // 本页只采集不放音：不申请任何输出路由（否则 iPhone 会把 AirPods 从电脑抢过来，
      // 电脑那边输出设备消失、正在播的视频被系统按「耳机被拔」暂停），输入锁死内置麦。
      captureOnly: true,
      onAmplitude: (rms) => {
        amp.value = withTiming(rms, { duration: 80, easing: Easing.linear });
      },
      onResult: (text) => setSegmentText(text),
      onDone: (finalText) => {
        if (dictationRef.current === s) dictationRef.current = null;
        setLastText(finalText);
        setSegmentText('');
        // 这一句已经落到电脑 composer 了 → 发送键可用（跨多次按住累计，发送成功后才归零）
        if (finalText.trim()) setDictatedAny(true);
        const p = phaseRef.current;
        if (p === 'ending') {
          sendBye();
          setPhase('done');
        } else if (p === 'recording' || p === 'finalizing') {
          setPhase('idle');
        }
      },
      onError: (message) => {
        if (dictationRef.current === s) dictationRef.current = null;
        setSegmentText('');
        amp.value = withTiming(0, { duration: 200 });
        const p = phaseRef.current;
        if (p === 'ending') {
          // 收尾路径不因这一次报错卡死，照样 bye + 退出
          sendBye();
          setPhase('done');
        } else if (p === 'recording' || p === 'finalizing') {
          setPhase('idle');
          flashNotice(message);
        }
      },
      onNotice: flashNotice,
      onRemoteStop: handleStop, // 电脑在录中点了断开：与本机关闭按钮同一路径
    });
    dictationRef.current = s;
    void s.start();
  }, [session, desktopDeviceId, amp, checkDesktopAlive, sendBye, flashNotice, handleStop]);

  /** PTT 松手：结束这一次，等定稿（onDone）期间按钮禁用。 */
  const handlePressOut = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    setPhase('finalizing');
    amp.value = withTiming(0, { duration: 200 });
    dictationRef.current?.stop();
  }, [amp]);

  // 整个 RemoteMicScreen 生命周期内屏幕不熄灭（空闲等待时也可能暗屏导致看不到按钮）。
  // 走引用计数：听写会话结束时只释放它自己的持有，不会关掉本页的常亮
  useEffect(() => {
    acquireKeepScreenOn('remote-mic-screen');
    return () => releaseKeepScreenOn('remote-mic-screen');
  }, []);

  // 进页 accept：标记已连接（电脑 chip 亮起、清 60s 定时器）；非 accepted 状态进失效页
  useEffect(() => {
    let stale = false;
    (async () => {
      if (!session) {
        setInvalidMsg('未登录，无法开始录音');
        setPhase('invalid');
        return;
      }
      try {
        const base = session.server_base_url.replace(/\/+$/, '');
        const res = await fetch(
          `${base}/api/remote_mic/invite/${encodeURIComponent(inviteId)}/accept`,
          { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: any = await res.json();
        if (stale) return;
        const status = String(data?.status || '');
        if (status === 'accepted') {
          acceptedRef.current = true;
          setPhase('idle');
          // 预热麦克风权限：别让首次按住时才弹系统弹窗
          AudioManager.requestRecordingPermissions().catch(() => {});
        } else {
          setInvalidMsg(
            status === 'cancelled'
              ? '电脑端已取消这次邀请'
              : status === 'disconnected' || status === 'closed'
                ? '会话已结束，请在电脑上重新发起'
                : '邀请已过期，请在电脑上重新发起',
          );
          setPhase('invalid');
        }
      } catch {
        if (!stale) {
          setInvalidMsg('无法连接服务器，请检查网络后重试');
          setPhase('invalid');
        }
      }
    })();
    return () => {
      stale = true;
    };
    // 只在进页跑一次：inviteId 是路由参数，页面生命周期内不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 电脑端主动断开（POST /disconnect → SSE bye 经 remoteMicInviteBus）：就地结束、
  // 短暂显示原因后自动退出。ending/done/bye/invalid 不动 —— 自己 sendBye 的广播回显也走
  // 这条 SSE，别把 bye 态顶成 invalid
  useEffect(() => {
    return subscribeRemoteMicBye((byeInviteId) => {
      if (byeInviteId !== inviteId) return;
      const p = phaseRef.current;
      if (p === 'ending' || p === 'done' || p === 'bye' || p === 'invalid') return;
      endDisconnected('电脑端已断开连接');
    });
  }, [inviteId, endDisconnected]);

  // app 切后台（进任务中心准备划掉 / 按 home 离开）：远程 mic 是前台沉浸交互，离开即结束
  // —— 立刻取消在录的一次 + sendBye 清电脑 chip。只认 'background'：'inactive' 会被下拉
  // 通知/控制中心、首次录音的麦克风权限弹窗触发，认它会误杀在用的会话。强杀场景下这次 bye
  // 可能来不及送达（进程即死），由录音页 /ping 心跳 + 服务端 death sweeper 兜底。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      if (status !== 'background' || !acceptedRef.current) return;
      const p = phaseRef.current;
      if (p === 'ending' || p === 'done' || p === 'bye' || p === 'invalid') return;
      endDisconnected('已在后台，远程语音已结束');
    });
    return () => sub.remove();
  }, [endDisconnected]);

  // 存活心跳：accepted 后每 5s POST /ping 刷新服务端 hb_ts。进程被强杀时卸载 effect 来不及
  // 跑、bye 发不出去 —— 心跳一停，服务端 ~20s 内判掉线并 SSE bye 清电脑 chip（唯一能覆盖
  // 「从前台直接强杀」的信号）。仅活跃相位跑；'inactive'（权限弹窗/控制中心）不停 JS 定时器，
  // 会话照常保活，不会误判掉线。fire-and-forget，空闲期电脑断开仍由 SSE bye 即时接管。
  useEffect(() => {
    const live =
      phase === 'idle' || phase === 'recording' || phase === 'finalizing' || phase === 'ending';
    if (!live || !session) return;
    const base = session.server_base_url.replace(/\/+$/, '');
    const ping = () => {
      void fetch(`${base}/api/remote_mic/invite/${encodeURIComponent(inviteId)}/ping`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 5000);
    return () => clearInterval(timer);
  }, [phase, session, inviteId]);

  // 卸载（含手势返回）：取消在录的一次 + 补发 bye，避免麦克风泄漏 / 电脑 chip 挂死
  useEffect(() => {
    return () => {
      const s = dictationRef.current;
      dictationRef.current = null;
      if (s) s.cancel();
      sendByeRef.current();
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
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

  // bye/invalid：终止态淡入（0→1, 200ms），配合 bye 的 1.5s 自动退出。keyed on phase
  // 覆盖所有进入 invalid 的路径（含 checking→invalid 的 accept 失败），从当前 0 自然淡入
  useEffect(() => {
    if (phase !== 'bye' && phase !== 'invalid') return;
    endFade.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.ease) });
  }, [phase, endFade]);

  // 按住中的慢呼吸底动：安静时圆环也有生命感，说话时振幅叠加在上面
  useEffect(() => {
    if (phase === 'recording') {
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
      breath.value = withTiming(0, { duration: 300 });
    }
  }, [phase, breath]);

  useEffect(() => {
    if (displayText) scrollRef.current?.scrollToEnd({ animated: true });
  }, [displayText]);

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
  const endStyle = useAnimatedStyle(() => ({
    opacity: endFade.value,
  }));

  const showMain =
    phase === 'idle' || phase === 'recording' || phase === 'finalizing' || phase === 'ending';
  const showPtt = phase === 'idle' || phase === 'recording' || phase === 'finalizing';
  const recording = phase === 'recording';
  // 发送键可用：没有在途请求，且「有东西可发」——
  //   idle：本次连接说过话（电脑 composer 里有我们落下的字）
  //   recording / finalizing：这一段已经识别出字（点了即打断并发出），或之前几段已落过字
  // 手机看不到电脑 composer，这两个信号是这边能拿到的最接近「有内容可发」的判据。
  const canSend =
    !sending &&
    (phase === 'idle'
      ? dictatedAny
      : (phase === 'recording' || phase === 'finalizing') &&
        (Boolean(segmentText.trim()) || dictatedAny));

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Pressable onPress={handleClose} hitSlop={12} style={styles.headerClose}>
          <Ionicons name="close" size={26} color="rgba(255,255,255,0.7)" />
        </Pressable>
        <Ionicons name="laptop-outline" size={18} color="rgba(255,255,255,0.55)" />
        <Text style={styles.headerText}>→ {deviceLabel}</Text>
      </View>

      <View style={styles.center}>
        {phase === 'checking' ? (
          <>
            <ActivityIndicator size="large" color="rgba(255,255,255,0.6)" />
            <Text style={styles.stateCaption}>正在连接…</Text>
          </>
        ) : null}

        {showMain ? (
          <>
            <View style={styles.pulseArea}>
              <Animated.View style={[styles.ringOuter, ringOuterStyle]} />
              <Animated.View style={[styles.ringInner, ringInnerStyle]} />
              <Animated.View style={[styles.core, !recording && styles.coreIdle, coreStyle]}>
                <Ionicons
                  name="mic"
                  size={44}
                  color={recording ? '#fff' : 'rgba(255,255,255,0.5)'}
                />
              </Animated.View>
            </View>
            <ScrollView
              ref={scrollRef}
              style={styles.textArea}
              contentContainerStyle={styles.textAreaContent}
              showsVerticalScrollIndicator={false}
            >
              <Text
                style={
                  segmentText
                    ? styles.liveText
                    : displayText
                      ? styles.liveTextDim
                      : styles.liveTextPlaceholder
                }
              >
                {displayText || '按住下方按钮说话，文字会实时出现在电脑上'}
              </Text>
            </ScrollView>
            {notice ? (
              <Text style={noticeTone === 'ok' ? styles.noticeTextOk : styles.noticeText}>
                {notice}
              </Text>
            ) : null}
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

        {phase === 'bye' ? (
          <Animated.View style={[styles.endBlock, endStyle]}>
            <Ionicons name="log-out-outline" size={48} color="rgba(255,255,255,0.3)" />
            <Text style={styles.byeText}>正在结束远程语音输入</Text>
          </Animated.View>
        ) : null}

        {phase === 'invalid' ? (
          <Animated.View style={[styles.endBlock, endStyle]}>
            <Ionicons name="alert-circle-outline" size={64} color="rgba(255,255,255,0.4)" />
            <Text style={styles.invalidText}>{invalidMsg || '邀请已失效'}</Text>
          </Animated.View>
        ) : null}
      </View>

      <View style={styles.footer}>
        {showPtt ? (
          <>
            <View style={styles.pttRow}>
              {/* 左侧等宽占位：右边挂了发送键，靠它让 PTT 在整行里仍然视觉居中 */}
              <View style={styles.pttSideSlot} />
              <Pressable
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                disabled={phase === 'finalizing'}
                style={[
                  styles.pttButton,
                  recording && styles.pttButtonActive,
                  phase === 'finalizing' && styles.dimmed,
                ]}
              >
                <Ionicons
                  name="mic"
                  size={34}
                  color={recording ? '#fff' : 'rgba(255,255,255,0.85)'}
                />
              </Pressable>
              <View style={styles.pttSideSlot}>
                {/* 常驻渲染（不可用时置灰）：藏起来会让按钮忽隐忽现、也少了「还能发送」的提示 */}
                <Pressable
                  onPress={handleSend}
                  disabled={!canSend}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`发送到 ${deviceLabel}`}
                  style={({ pressed }) => [
                    styles.sendButton,
                    canSend && styles.sendButtonActive,
                    (!canSend || pressed) && styles.dimmed,
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons
                      name="arrow-up"
                      size={24}
                      color={canSend ? '#fff' : 'rgba(255,255,255,0.4)'}
                    />
                  )}
                </Pressable>
              </View>
            </View>
            <Text style={styles.pttCaption}>
              {sending
                ? '正在发送…'
                : recording
                  ? '松开结束'
                  : phase === 'finalizing'
                    ? // 定稿等待期也能发（点了即打断），这里明说，别让用户以为还得等
                      canSend
                      ? '正在识别 · 可直接发送'
                      : '正在识别…'
                    : canSend
                      ? '按住继续说 · 或点右侧发送'
                      : '按住说话'}
            </Text>
          </>
        ) : null}
        {phase === 'invalid' || phase === 'bye' ? (
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
      marginTop: insets.top + 16,
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    headerClose: {
      position: 'absolute',
      left: 16,
      height: 44,
      width: 44,
      alignItems: 'center',
      justifyContent: 'center',
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
    coreIdle: {
      backgroundColor: 'rgba(255,255,255,0.1)',
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
    liveTextDim: {
      color: 'rgba(255,255,255,0.45)',
      fontSize: 17,
      lineHeight: 26,
      textAlign: 'center',
    },
    liveTextPlaceholder: {
      color: 'rgba(255,255,255,0.35)',
      fontSize: 15,
      textAlign: 'center',
    },
    noticeText: {
      marginTop: 10,
      color: 'rgba(255,159,10,0.85)',
      fontSize: 13,
      textAlign: 'center',
    },
    // 成功提示（已发送）：与 done 态勾号同一支绿，跟橙色的告警区分开
    noticeTextOk: {
      marginTop: 10,
      color: 'rgba(48,209,88,0.9)',
      fontSize: 13,
      textAlign: 'center',
    },
    doneText: {
      marginTop: 18,
      color: 'rgba(255,255,255,0.9)',
      fontSize: 17,
      fontWeight: '500',
    },
    endBlock: {
      alignItems: 'center',
    },
    invalidText: {
      marginTop: 18,
      color: 'rgba(255,255,255,0.6)',
      fontSize: 15,
      textAlign: 'center',
      lineHeight: 22,
    },
    byeText: {
      marginTop: 16,
      color: 'rgba(255,255,255,0.45)',
      fontSize: 13,
      textAlign: 'center',
      lineHeight: 20,
    },
    footer: {
      alignItems: 'center',
      paddingBottom: insets.bottom + 28,
    },
    pttRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    // 两侧等宽槽位（右侧放发送键、左侧空着配平），PTT 因此仍落在屏幕水平中线上
    pttSideSlot: {
      width: 88,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButton: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: 'rgba(255,255,255,0.08)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    // 可发送时点亮成系统蓝：与录音红分出主次，一眼能分清「说」和「发」
    sendButtonActive: {
      backgroundColor: '#0a84ff',
      borderColor: '#0a84ff',
    },
    pttButton: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: 'rgba(255,255,255,0.08)',
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.25)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    pttButtonActive: {
      backgroundColor: '#ff453a',
      borderColor: '#ff453a',
    },
    pttCaption: {
      marginTop: 14,
      color: 'rgba(255,255,255,0.45)',
      fontSize: 14,
    },
    dimmed: {
      opacity: 0.55,
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
