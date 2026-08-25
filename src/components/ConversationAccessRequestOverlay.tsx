/**
 * WP3 档 B 授权解密桥的应用内确认卡片：agent 想读一条它无权解的加密对话，问用户放不放行。
 *
 * 来源只有一条：ConversationContext 的 inbox SSE 收到 conversation_access_request 帧，
 * 经 conversationAccessBus 汇到这里弹根级 Modal。结构与交互照 RemoteMicInviteOverlay
 * （本仓已有的同类「用户级事件 → 根级确认卡」）。
 *
 * 「允许」→ 客户端现场解出目标对话 D 的 K_conv、用 transport.pub 包成 wire 上送。
 * 服务端没有 K_user，只有拿到这个 wire 才读得到 D，且只在内核内存暂存 600s 一次性 ——
 * 所以这是每次都要问的，不做「记住选择」。解不出钥匙时把原因显示在卡里，绝不发一个
 * 没有 wire 的 approve（那样用户以为授权成功了，实际 agent 永远读不到）。
 *
 * 「拒绝」→ 只回一个 reject，不带任何密钥。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { submitConversationAccessDecision } from '../api';
import { useSession } from '../context/SessionContext';
import {
  clearConversationAccessRequest,
  subscribeConversationAccessRequest,
  type ConversationAccessRequestDetail,
} from '../utils/conversationAccessBus';

export function ConversationAccessRequestOverlay(): React.ReactElement | null {
  const { session } = useSession();
  const [detail, setDetail] = useState<ConversationAccessRequestDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // 订阅只建一次；session 经 ref 实时读，避免登录态变化反复重订阅（同 RemoteMicInviteOverlay）
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const unsub = subscribeConversationAccessRequest((d) => {
      if (!sessionRef.current) return;
      setError('');
      setSubmitting(false);
      setDetail(d);
    });
    return unsub;
  }, []);

  if (!session || !detail) return null;

  const submit = (decision: 'approve' | 'reject') => {
    if (submitting) return;
    const s = sessionRef.current;
    if (!s) return;
    setSubmitting(true);
    setError('');
    void (async () => {
      try {
        await submitConversationAccessDecision(s, {
          requestId: detail.requestId,
          decision,
          requesterConversationId: detail.requesterConversationId,
          targetConversationId: detail.targetConversationId,
        });
        setDetail(null);
        clearConversationAccessRequest();
      } catch (e) {
        setError((e as Error)?.message || String(e));
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Agent 请求读取另一个对话</Text>
          <Text style={styles.body}>
            这个对话里的 agent 想读取另一条加密对话的内容。那条对话的密钥只有你手里有，服务端解不开
            —— 你同意后，客户端才会把它的密钥交出去（一次性，10 分钟内有效）。
          </Text>
          <View style={styles.reasonBox}>
            <Text style={styles.reasonText}>
              {detail.reason?.trim() ? `理由：${detail.reason.trim()}` : '（agent 没有说明理由）'}
            </Text>
            <Text style={styles.targetText}>{`目标对话 id：${detail.targetConversationId}`}</Text>
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.buttonsRow}>
            <Pressable
              style={[styles.button, styles.buttonGhost, submitting && styles.buttonDisabled]}
              onPress={() => submit('reject')}
              disabled={submitting}
            >
              <Text style={styles.buttonGhostText}>拒绝</Text>
            </Pressable>
            <Pressable
              style={[styles.button, submitting && styles.buttonDisabled]}
              onPress={() => submit('approve')}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#111" />
              ) : (
                <Text style={styles.buttonText}>允许本次读取</Text>
              )}
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
  card: { width: '100%', maxWidth: 420, gap: 12 },
  title: { color: '#fff', fontSize: 20, fontWeight: '600', textAlign: 'center' },
  body: { color: 'rgba(255,255,255,0.82)', fontSize: 14, lineHeight: 22 },
  reasonBox: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 6,
  },
  reasonText: { color: '#fff', fontSize: 14, lineHeight: 20 },
  targetText: { color: 'rgba(255,255,255,0.55)', fontSize: 11, lineHeight: 16 },
  errorText: { color: '#ff8f8a', fontSize: 13, lineHeight: 19 },
  buttonsRow: { flexDirection: 'row', gap: 10, marginTop: 8, justifyContent: 'center' },
  button: {
    minWidth: 120,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 9999,
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#111', fontSize: 14, fontWeight: '600' },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  buttonGhostText: { color: '#fff', fontSize: 14, fontWeight: '500' },
});
