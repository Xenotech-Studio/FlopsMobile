/**
 * 批量标题解密授权（list_conversations 触发）的应用内确认卡片：agent 想看 N 个加密对话的
 * 标题以便定位，问用户放不放行。
 *
 * 来源：ConversationContext 的 inbox SSE 收到 conversation_titles_request 帧，经
 * conversationAccessBus 汇到这里弹根级 Modal。与 ConversationAccessRequestOverlay 同款。
 *
 * 「允许」→ 客户端用 K_user 逐个解出这些对话的标题明文打包上送（submitConversationTitlesDecision）。
 * 服务端没有 K_user、不解标题，只把客户端解好的明文短驻留缓存 5min。「拒绝」→ 只回 reject。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { submitConversationTitlesDecision } from '../api';
import { useSession } from '../context/SessionContext';
import {
  clearConversationTitlesRequest,
  subscribeConversationTitlesRequest,
  type ConversationTitlesRequestDetail,
} from '../utils/conversationAccessBus';

export function ConversationTitlesRequestOverlay(): React.ReactElement | null {
  const { session } = useSession();
  const [detail, setDetail] = useState<ConversationTitlesRequestDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const unsub = subscribeConversationTitlesRequest((d) => {
      if (!sessionRef.current) return;
      setError('');
      setSubmitting(false);
      setDetail(d);
    });
    return unsub;
  }, []);

  if (!session || !detail) return null;

  const count = detail.count || (detail.targetIds || []).length;

  const submit = (decision: 'approve' | 'reject') => {
    if (submitting) return;
    const s = sessionRef.current;
    if (!s) return;
    setSubmitting(true);
    setError('');
    void (async () => {
      try {
        await submitConversationTitlesDecision(s, {
          requestId: detail.requestId,
          decision,
          requesterConversationId: detail.requesterConversationId,
          targetIds: detail.targetIds,
        });
        setDetail(null);
        clearConversationTitlesRequest();
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
          <Text style={styles.title}>Agent 请求查看加密对话的标题</Text>
          <Text style={styles.body}>
            这个对话里的 agent 想列出你的对话来定位，其中有 {count} 个是加密对话、标题服务端看不到。
            你同意后，客户端才会用你的密钥把这些标题解出来交给它（明文标题 5 分钟内有效，只给标题、不含内容）。
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
              {submitting ? (
                <ActivityIndicator size="small" color="#111" />
              ) : (
                <Text style={styles.buttonText}>允许解密标题</Text>
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
