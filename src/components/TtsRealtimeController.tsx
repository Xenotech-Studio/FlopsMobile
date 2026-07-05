/**
 * app 级实时 TTS 控制器（不渲染 UI）。
 *
 * 挂在 SessionProvider 内、与 PushTokenLifecycle 同级 —— 只要登录态在就常驻，
 * 不随 ChatScreen 生死。职责：session 变化时从服务端拉 `tts_autoplay` 偏好并同步给
 * ttsRealtime 单例（登出 → 断流）。真正的连/断由单例的 reconcile 决定。
 */
import { useEffect } from 'react';
import { useSession } from '../context/SessionContext';
import { refreshRealtimeFromPrefs } from '../audio/ttsRealtime';

export function TtsRealtimeController(): null {
  const { session } = useSession();
  useEffect(() => {
    void refreshRealtimeFromPrefs(session);
  }, [session]);
  return null;
}
