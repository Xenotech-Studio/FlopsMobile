/**
 * 查看 flops 子agent 的子对话内容——全屏 Modal 覆盖层。
 *
 * 弹窗退化为纯容器（遮罩 + 关闭/刷新）；内容本体是**复用的工具卡** SubagentCard，以完全展开态渲染，
 * 与主对话流里展开的子 agent 卡完全一致。做法：把 subagent_view 读到的消息列表适配成一个
 * subagent_start block（提问=首条 user 消息，回答=其余消息转 agent_blocks），交给 SubagentCard。
 *
 * 加密子对话需带父对话 K_conv wire（api.getSubagentView 内部处理）；拿不到钥匙时服务端回
 * needs_authorization，本层显示 locked 面板提示先在对话中授权。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SubagentCard } from '../screens/chat-cards/SubagentCard';
import { getSubagentView } from '../api';
import type { Session } from '../api';

type Msg = { role?: string; content?: string };

type ViewData = {
  success?: boolean;
  status?: string;
  title?: string;
  message_count?: number;
  returned?: number;
  messages?: Msg[];
  subagent_status?: string;
  is_running?: boolean;
  prompt_preview?: string;
  note?: string;
};

type Props = {
  visible: boolean;
  session: Session;
  parentConversationId: string;
  targetSessionId: string;
  title?: string;
  onClose: () => void;
  /** ChatScreen 的样式/配色/工具状态文案——传给复用的 SubagentCard，令其渲染与主对话一致。 */
  cardStyles: Record<string, any>;
  cardColors: Record<string, any>;
  getToolStatusLabel: (status: string) => string;
};

/** 子对话消息列表 → subagent_start 工具调用 block（供 SubagentCard 完全展开态渲染）。 */
function buildSubagentBlock(data: ViewData | null, sessionId: string): Record<string, unknown> {
  const messages: Msg[] = Array.isArray(data?.messages) ? (data?.messages as Msg[]) : [];
  let prompt = '';
  let rest = messages;
  if (messages.length && messages[0]?.role === 'user') {
    prompt = String(messages[0]?.content || '');
    rest = messages.slice(1);
  } else {
    prompt = String(data?.prompt_preview || '');
  }
  const agentBlocks = rest.map((m) => ({
    type: 'text',
    content:
      m?.role === 'user'
        ? `\n\n**· 追问 ·**\n\n${String(m?.content || '')}`
        : String(m?.content || ''),
  }));
  return {
    type: 'tool',
    tool_name: 'subagent_start',
    index: 0,
    status: data?.is_running ? 'running' : 'completed',
    arguments: JSON.stringify({ agent_type: 'flops', prompt, session_id: sessionId }),
    result: { session_id: sessionId, agent_blocks: agentBlocks },
  };
}

export function SubagentViewOverlay({
  visible,
  session,
  parentConversationId,
  targetSessionId,
  onClose,
  cardStyles,
  cardColors,
  getToolStatusLabel,
}: Props): React.ReactElement | null {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<ViewData | null>(null);

  const load = useCallback(() => {
    if (!targetSessionId || !parentConversationId) return;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const res = await getSubagentView(session, {
          parentConversationId,
          targetSessionId,
          limit: 30,
        });
        setData(res as ViewData);
      } catch (e) {
        setError((e as Error)?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [session, parentConversationId, targetSessionId]);

  useEffect(() => {
    if (visible) load();
    else {
      setData(null);
      setError('');
    }
  }, [visible, load]);

  if (!visible) return null;

  const locked = data?.status === 'needs_authorization';
  const hasContent = Boolean(data && data.success !== false && !locked);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.shell} onPress={(e) => e.stopPropagation()}>
          <View style={styles.body}>
            {loading && !data ? (
              <View style={styles.centerRow}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.dimText}>加载中…</Text>
              </View>
            ) : error ? (
              <View style={styles.centerCol}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : locked ? (
              <View style={styles.lockedPanel}>
                <Text style={styles.lockedText}>该加密子对话需在对话中授权后才能查看。</Text>
                {data?.note ? <Text style={styles.dimText}>{data.note}</Text> : null}
              </View>
            ) : hasContent ? (
              <ScrollView style={styles.scroll} contentContainerStyle={styles.cardScrollContent}>
                {/* 复用真正的工具卡组件：完全展开态，视觉与主对话里展开的子 agent 卡一致。 */}
                <SubagentCard
                  block={buildSubagentBlock(data, targetSessionId) as unknown as never}
                  cardKey={`subagent-view-${targetSessionId}`}
                  agentLabel="Flops 对话"
                  styles={cardStyles}
                  colors={cardColors}
                  iconColor={cardColors?.textSecondary || '#8ab4ff'}
                  getToolStatusLabel={getToolStatusLabel}
                  renderToolCardSafetyActions={() => null}
                  isSubmitting={false}
                  defaultExpanded
                />
              </ScrollView>
            ) : (
              <View style={styles.centerCol}>
                <Text style={styles.dimText}>暂无内容</Text>
              </View>
            )}
          </View>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.btn, styles.btnGhost, loading && styles.btnDisabled]}
              onPress={load}
              disabled={loading}
              activeOpacity={0.7}
            >
              {loading && data ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.btnGhostText}>刷新</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.btnText}>关闭</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  // 纯容器：无边框/背景，工具卡自身边框即弹窗边框。
  shell: { maxHeight: '82%' },
  body: { flexShrink: 1 },
  scroll: { flexGrow: 0 },
  cardScrollContent: { paddingBottom: 4 },
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 24,
    justifyContent: 'center',
  },
  centerCol: { padding: 24, alignItems: 'center', gap: 8 },
  dimText: { color: 'rgba(255,255,255,0.5)', fontSize: 13, lineHeight: 19 },
  errorText: { color: '#ff8f8a', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  lockedPanel: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    gap: 8,
  },
  lockedText: { color: 'rgba(255,255,255,0.82)', fontSize: 13, lineHeight: 20 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 12,
  },
  btn: {
    minWidth: 88,
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 9999,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#111', fontSize: 14, fontWeight: '600' },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  btnGhostText: { color: '#fff', fontSize: 14, fontWeight: '500' },
});
