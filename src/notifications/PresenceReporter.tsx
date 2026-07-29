/**
 * 移动端 AppState → 服务端 presence 上报。
 *
 * 用途：让服务端区分「用户正在前台看 Flops」vs「app 后台/锁屏」，
 * 前台时业务侧的 push_event 会自动跳过，避免明明在用还推。
 *
 * 行为：
 * - 仅 iOS 真机有意义（推送只走 APNs）；其它平台直接 noop。
 * - 仅当有 session 时上报（有账号即上报前台状态，不依赖推送开关——\n *   任一安装在前台都应压制整个账号的推送，避免 dev 版使用中正式版还弹横幅）。
 * - 启动 + 每次回前台：立即 POST {state:"foreground"}，并启动 60s 心跳
 *   （服务端 key TTL 90s，30s 容差）。
 * - 切到后台 / inactive：立即 POST {state:"background"}，停心跳。
 * - app 被杀：心跳过期，服务端 key 自然回落到 background-TTL（24h）后到期。
 *
 * 与 PushTokenLifecycle 各管一摊：lifecycle 负责 device token 同步，本组件
 * 负责 presence。两者都依赖 push_enabled，但语义独立。
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { useSession } from '../context/SessionContext';
import { reportApnsPresence } from '../api/push';

const HEARTBEAT_MS = 60 * 1000;

export function PresenceReporter(): null {
  const { session, serverBaseUrl } = useSession();
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStateRef = useRef<'foreground' | 'background' | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (!session) return;

    let cancelled = false;

    const stopHeartbeat = () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };

    const send = async (next: 'foreground' | 'background', force = false) => {
      if (!force && lastStateRef.current === next) return;
      if (cancelled) return;
      lastStateRef.current = next;
      void reportApnsPresence(serverBaseUrl, session.access_token, next);
    };

    const apply = (status: AppStateStatus) => {
      if (status === 'active') {
        void send('foreground');
        stopHeartbeat();
        // 心跳：让服务端的 90s TTL 不掉到过期
        heartbeatRef.current = setInterval(() => {
          void send('foreground', /* force */ true);
        }, HEARTBEAT_MS);
      } else {
        // background / inactive：苹果对两者的语义略有差别，但对推送抑制而言一致
        void send('background');
        stopHeartbeat();
      }
    };

    apply(AppState.currentState);
    const sub = AppState.addEventListener('change', apply);

    return () => {
      cancelled = true;
      stopHeartbeat();
      sub.remove();
    };
  }, [session, serverBaseUrl]);

  return null;
}
