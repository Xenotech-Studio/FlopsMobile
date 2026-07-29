/**
 * 跨设备语音输入邀请的应用内确认卡片。
 *
 * 两条来源都经 remoteMicInviteBus 汇到这里弹全局 Modal：
 *  - 前台：服务端按 presence 压掉 APNs，邀请经 inbox SSE（ConversationContext）；
 *  - 后台：APNs 通知点击唤醒 App，DeepLinkRouter 发总线（不直接导航）。
 * 无论哪条路径，都是用户点「接受」才进录音页。
 *
 * 弹出前先 GET /api/remote_mic/invite/{id} 验证仍是 pending —— 送达与
 * 桌面取消/过期存在竞态，非 pending（或验证失败）直接静默丢弃不打扰。
 * 「接受」→ reset 到 Main + RemoteMic（录音页进页
 * 会再验证 + 建 ASR WS，WS 建连即标 accepted）。
 * 「拒绝」→ POST /invite/{id}/cancel，桌面端轮询看到 cancelled 结束等待。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { navigationRef } from '../navigation/navigationRef';
import { useSession } from '../context/SessionContext';
import {
  clearRemoteMicInvite,
  subscribeRemoteMicInvite,
  type RemoteMicInviteDetail,
} from '../utils/remoteMicInviteBus';

export function RemoteMicInviteOverlay(): React.ReactElement | null {
  const { session } = useSession();
  const [detail, setDetail] = useState<RemoteMicInviteDetail | null>(null);
  // 订阅只建一次；session 经 ref 实时读，避免登录态变化反复重订阅
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let disposed = false;
    const unsub = subscribeRemoteMicInvite((d) => {
      const s = sessionRef.current;
      if (!s) return;
      void (async () => {
        try {
          const base = s.server_base_url.replace(/\/+$/, '');
          const res = await fetch(
            `${base}/api/remote_mic/invite/${encodeURIComponent(d.inviteId)}`,
            { headers: { Authorization: `Bearer ${s.access_token}` } },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data: { status?: string } = await res.json();
          if (disposed) return;
          if (String(data?.status || '') === 'pending') setDetail(d);
          else clearRemoteMicInvite();
        } catch {
          if (!disposed) clearRemoteMicInvite();
        }
      })();
    });
    return () => {
      disposed = true;
      unsub();
    };
  }, []);

  if (!session || !detail) return null;

  const handleAccept = () => {
    const d = detail;
    setDetail(null);
    clearRemoteMicInvite();
    if (!navigationRef.isReady()) return;
    // 与 DeepLinkRouter 的 remote_mic_invite 分支同构：reset 成 Main + RemoteMic 两层，返回可回主页
    navigationRef.dispatch(
      CommonActions.reset({
        index: 1,
        routes: [
          { name: 'Main' },
          {
            name: 'RemoteMic',
            params: {
              inviteId: d.inviteId,
              desktopName: d.desktopName,
              desktopDeviceId: d.desktopDeviceId,
            },
          },
        ],
      }),
    );
  };

  const handleDecline = () => {
    const d = detail;
    setDetail(null);
    clearRemoteMicInvite();
    const s = sessionRef.current;
    if (!s) return;
    const base = s.server_base_url.replace(/\/+$/, '');
    fetch(`${base}/api/remote_mic/invite/${encodeURIComponent(d.inviteId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.access_token}` },
    }).catch(() => {});
  };

  const deviceLabel = detail.desktopName || '电脑';

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={handleDecline}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.micBadge}>
            <Ionicons name="mic" size={30} color="#fff" />
          </View>
          <Text style={styles.title}>{deviceLabel} 邀请使用你的麦克风</Text>
          <Text style={styles.body}>接受后进入录音页，说的话会实时出现在电脑上。</Text>
          <View style={styles.buttonsRow}>
            <Pressable style={[styles.button, styles.buttonGhost]} onPress={handleDecline}>
              <Text style={styles.buttonGhostText}>拒绝</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={handleAccept}>
              <Text style={styles.buttonText}>接受</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,15,18,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: { width: '100%', maxWidth: 420, gap: 12, alignItems: 'center' },
  micBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ff453a',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  title: { color: '#fff', fontSize: 20, fontWeight: '600', textAlign: 'center' },
  body: { color: 'rgba(255,255,255,0.82)', fontSize: 14, lineHeight: 22, textAlign: 'center' },
  buttonsRow: { flexDirection: 'row', gap: 10, marginTop: 12, justifyContent: 'center' },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 9999,
    backgroundColor: '#fff',
  },
  buttonText: { color: '#111', fontSize: 14, fontWeight: '600' },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  buttonGhostText: { color: '#fff', fontSize: 14, fontWeight: '500' },
});
