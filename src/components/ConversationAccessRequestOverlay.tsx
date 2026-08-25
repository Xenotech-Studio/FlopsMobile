/**
 * WP3 档 B 授权解密桥的确认卡——真挂起后的**对话流内嵌卡**（非全屏 Modal）。由 ChatScreen 在消息流
 * 尾部渲染，只在发起方对话（currentConversationId === detail.requesterConversationId）出现；点 允许/拒绝
 * → 提交决策 → 服务端续起 run 把目标对话内容注入挂起的 request_conversation_access 调用续跑（reject 则回拒绝）。
 *
 * 「允许」→ 客户端现场解出目标对话 D 的 K_conv、用 transport.pub 包成 wire 上送。服务端没有 K_user，
 * 只有拿到这个 wire 才读得到 D，且只在内核内存暂存 600s 一次性 —— 每次都要问，不做「记住选择」。
 * 「拒绝」→ 只回一个 reject，不带任何密钥。
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { submitConversationAccessDecision } from '../api';
import type { Session } from '../api';
import { clearConversationAccessRequest, type ConversationAccessRequestDetail } from '../utils/conversationAccessBus';

export function ConversationAccessRequestCard({
  detail,
  session,
  currentConversationId,
  onResolved,
}: {
  detail: ConversationAccessRequestDetail | null;
  session: Session | null;
  currentConversationId: string;
  onResolved: () => void;
}): React.ReactElement | null {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  if (!session || !detail) return null;
  if (String(detail.requesterConversationId || '') !== String(currentConversationId || '')) return null;

  const submit = (decision: 'approve' | 'reject') => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    void (async () => {
      try {
        await submitConversationAccessDecision(session, {
          requestId: detail.requestId,
          decision,
          requesterConversationId: detail.requesterConversationId,
          targetConversationId: detail.targetConversationId,
        });
        clearConversationAccessRequest();
        onResolved();
      } catch (e) {
        setError((e as Error)?.message || String(e));
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
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
          {submitting ? <ActivityIndicator size="small" color="#111" /> : <Text style={styles.buttonText}>允许本次读取</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 4,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    gap: 10,
  },
  title: { color: '#fff', fontSize: 15, fontWeight: '600' },
  body: { color: 'rgba(255,255,255,0.78)', fontSize: 13, lineHeight: 20 },
  reasonBox: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 6,
  },
  reasonText: { color: '#fff', fontSize: 13, lineHeight: 19 },
  targetText: { color: 'rgba(255,255,255,0.55)', fontSize: 11, lineHeight: 16 },
  errorText: { color: '#ff8f8a', fontSize: 13, lineHeight: 19 },
  buttonsRow: { flexDirection: 'row', gap: 10, marginTop: 4, justifyContent: 'flex-end' },
  button: {
    minWidth: 108,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 9999,
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#111', fontSize: 14, fontWeight: '600' },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  buttonGhostText: { color: '#fff', fontSize: 14, fontWeight: '500' },
});
