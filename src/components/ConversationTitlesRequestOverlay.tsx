/**
 * 批量标题解密授权（list_conversations 触发）——真挂起后的**对话流内嵌确认卡**（非全屏 Modal）。
 * 由 ChatScreen 在消息流尾部渲染，只在发起方对话（currentConversationId === detail.requesterConversationId）
 * 出现；点 允许/拒绝 → 提交决策 → 服务端续起 run 把重建的列表注入挂起的 list_conversations 调用续跑。
 *
 * 「允许」→ 客户端用 K_user 逐个解出这些对话的标题明文打包上送（submitConversationTitlesDecision）。
 * 服务端没有 K_user、不解标题，只把客户端解好的明文短驻留缓存。「拒绝」→ 只回 reject。
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { submitConversationTitlesDecision } from '../api';
import type { Session } from '../api';
import { clearConversationTitlesRequest, type ConversationTitlesRequestDetail } from '../utils/conversationAccessBus';

export function ConversationTitlesRequestCard({
  detail,
  session,
  currentConversationId,
  onResolved,
}: {
  detail: ConversationTitlesRequestDetail | null;
  session: Session | null;
  currentConversationId: string;
  onResolved: () => void;
}): React.ReactElement | null {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  if (!session || !detail) return null;
  // 内嵌在发起方对话流里：非发起方对话不渲染。
  if (String(detail.requesterConversationId || '') !== String(currentConversationId || '')) return null;

  const count = detail.count || (detail.targetIds || []).length;

  const submit = (decision: 'approve' | 'reject') => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    void (async () => {
      try {
        await submitConversationTitlesDecision(session, {
          requestId: detail.requestId,
          decision,
          requesterConversationId: detail.requesterConversationId,
          targetIds: detail.targetIds,
        });
        clearConversationTitlesRequest();
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
      <Text style={styles.title}>Agent 请求查看加密对话的标题</Text>
      <Text style={styles.body}>
        这个对话里的 agent 想列出你的对话来定位，其中有 {count} 个是加密对话、标题服务端看不到。
        你同意后，客户端才会用你的密钥把这些标题解出来交给它（只给标题、不含内容）。
      </Text>
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
          {submitting ? <ActivityIndicator size="small" color="#111" /> : <Text style={styles.buttonText}>允许解密标题</Text>}
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
