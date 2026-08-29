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
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import Ionicons from 'react-native-vector-icons/Ionicons';
import { SubagentCard } from '../screens/chat-cards/SubagentCard';
import { SubagentConversationMessages } from './SubagentConversationMessages';
import { rawMessagesToLocal } from '../utils/chatLocalMessages';
import { getSubagentView, getExecutorSubagentView } from '../api';
import type { Session } from '../api';
import { shadowSheet } from '../theme/shadows';

type Msg = { role?: string; content?: string };

type ViewData = {
  success?: boolean;
  status?: string;
  title?: string;
  message_count?: number;
  returned?: number;
  messages?: Msg[];
  /** 原始 OpenAI 消息（含 tool_calls / tool_call_id / metadata），供普通对话列表形态渲染。 */
  messages_full?: any[];
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
  /** 子agent 类型：flops 走 subagent_view；claude/cursor 走 executor_subagent_view。 */
  agentType?: 'flops' | 'claude' | 'cursor';
  deviceId?: string;
  cwd?: string;
  onClose: () => void;
  /** ChatScreen 的样式/配色/工具状态文案——传给复用的 SubagentCard，令其渲染与主对话一致。 */
  cardStyles: Record<string, any>;
  cardColors: Record<string, any>;
  getToolStatusLabel: (status: string) => string;
};

export function SubagentViewOverlay({
  visible,
  session,
  parentConversationId,
  targetSessionId,
  agentType = 'flops',
  deviceId,
  cwd,
  onClose,
  cardStyles,
  cardColors,
  getToolStatusLabel,
}: Props): React.ReactElement | null {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<ViewData | null>(null);
  // claude/cursor 分支：直接从 agent_blocks 建好的假 block（不经消息→block 转换）。
  const [blockOverride, setBlockOverride] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(() => {
    if (!targetSessionId || !parentConversationId) return;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        if (agentType === 'claude' || agentType === 'cursor') {
          const result = await getExecutorSubagentView(session, {
            parentConversationId,
            sessionId: targetSessionId,
            agentType,
            deviceId,
            cwd,
          });
          if (result && result.ok === false) {
            throw new Error(String(result.error || '查看子对话失败'));
          }
          setBlockOverride({
            type: 'tool',
            tool_name: 'subagent_start',
            index: 0,
            status: result?.running ? 'running' : 'completed',
            arguments: JSON.stringify({
              agent_type: agentType,
              prompt: String(result?.prompt_preview || ''),
              session_id: targetSessionId,
            }),
            result: {
              session_id: targetSessionId,
              agent_blocks: result?.agent_blocks || [],
              ...(result?.model ? { model: result.model } : {}),
            },
          });
        } else {
          const res = await getSubagentView(session, {
            parentConversationId,
            targetSessionId,
            limit: 30,
          });
          setData(res as ViewData);
        }
      } catch (e) {
        setError((e as Error)?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [session, parentConversationId, targetSessionId, agentType, deviceId, cwd]);

  useEffect(() => {
    if (visible) load();
    else {
      setData(null);
      setBlockOverride(null);
      setError('');
    }
  }, [visible, load]);

  const styles = useMemo(() => createStyles(cardColors), [cardColors]);

  if (!visible) return null;

  const isExecutor = agentType === 'claude' || agentType === 'cursor';
  const locked = !isExecutor && data?.status === 'needs_authorization';
  const hasContent = isExecutor
    ? Boolean(blockOverride)
    : Boolean(data && data.success !== false && !locked);
  const cardAgentLabel = agentType === 'claude' ? 'Claude 对话' : agentType === 'cursor' ? 'Cursor 对话' : 'Flops 对话';

  // 标题：${agentLabel} 子对话；副标题：会话 ${8位} · 运行中/已完成（有数据时才带状态）。
  const agentLabel = agentType === 'claude' ? 'Claude' : agentType === 'cursor' ? 'Cursor' : 'Flops';
  const running = isExecutor
    ? Boolean((blockOverride as any)?.status === 'running')
    : Boolean(data?.is_running);
  const sessionShort = (targetSessionId || '').slice(0, 8);
  const statusText = hasContent ? (running ? '运行中' : '已完成') : '';
  const subtitle = statusText ? `会话 ${sessionShort} · ${statusText}` : `会话 ${sessionShort}`;

  const spinnerColor = (cardColors?.textSecondary as string) || (cardColors?.textPrimary as string) || '#888';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <View style={styles.headerTextCol}>
              <Text style={styles.title} numberOfLines={1}>
                {`${agentLabel} 子对话`}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={[styles.iconBtn, loading && styles.iconBtnDisabled]}
                onPress={load}
                disabled={loading}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {loading && (data || blockOverride) ? (
                  <ActivityIndicator size="small" color={spinnerColor} />
                ) : (
                  <Ionicons name="refresh" size={20} color={cardColors?.textSecondary || '#888'} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={onClose}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={22} color={cardColors?.textSecondary || '#888'} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.body}>
            {loading && !data && !blockOverride ? (
              <View style={styles.centerRow}>
                <ActivityIndicator size="small" color={spinnerColor} />
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
                {isExecutor ? (
                  /* claude/cursor：仍复用工具卡组件，完全展开态，与主对话里展开的子 agent 卡一致。 */
                  <SubagentCard
                    block={blockOverride as unknown as never}
                    cardKey={`subagent-view-${targetSessionId}`}
                    agentLabel={cardAgentLabel}
                    styles={cardStyles}
                    colors={cardColors}
                    iconColor={cardColors?.textSecondary || '#8ab4ff'}
                    getToolStatusLabel={getToolStatusLabel}
                    renderToolCardSafetyActions={() => null}
                    isSubmitting={false}
                    defaultExpanded
                  />
                ) : (
                  /* flops：铺开成普通对话消息列表（用户气泡 + assistant 正文/思考/工具块）。 */
                  <SubagentConversationMessages
                    messages={rawMessagesToLocal(
                      ((data as any)?.messages_full || (data as any)?.messages || []) as any[]
                    )}
                    styles={cardStyles}
                    colors={cardColors}
                    getToolStatusLabel={getToolStatusLabel}
                  />
                )}
              </ScrollView>
            ) : (
              <View style={styles.centerCol}>
                <Text style={styles.dimText}>暂无内容</Text>
              </View>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(c: Record<string, any>) {
  const surface = (c?.surface as string) || '#1f1f1f';
  const border = (c?.border as string) || 'rgba(255,255,255,0.14)';
  const textPrimary = (c?.textPrimary as string) || '#f3f4f6';
  const textSecondary = (c?.textSecondary as string) || '#d1d5db';
  const textMuted = (c?.textMuted as string) || '#9ca3af';
  const backdrop = (c?.modalBackdrop as string) || 'rgba(0,0,0,0.55)';
  const surfaceMuted = (c?.surfaceMuted as string) || 'rgba(255,255,255,0.06)';
  const danger = (c?.danger as string) || '#ff8f8a';

  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: backdrop,
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    card: {
      maxHeight: '82%',
      backgroundColor: surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: border,
      overflow: 'hidden',
      ...(shadowSheet as object),
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: border,
      gap: 12,
    },
    headerTextCol: { flex: 1, minWidth: 0 },
    title: { color: textPrimary, fontSize: 16, fontWeight: '600' },
    subtitle: { color: textMuted, fontSize: 12, marginTop: 2 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    iconBtn: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 8,
    },
    iconBtnDisabled: { opacity: 0.5 },
    body: { flexShrink: 1 },
    // flexShrink 让 ScrollView 在 card 的 maxHeight 内收缩并内部滚动，长对话不被裁切。
    scroll: { flexShrink: 1 },
    cardScrollContent: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 },
    centerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      padding: 24,
      justifyContent: 'center',
    },
    centerCol: { padding: 24, alignItems: 'center', gap: 8 },
    dimText: { color: textMuted, fontSize: 13, lineHeight: 19 },
    errorText: { color: danger, fontSize: 13, lineHeight: 19, textAlign: 'center' },
    lockedPanel: {
      margin: 16,
      padding: 16,
      borderRadius: 12,
      backgroundColor: surfaceMuted,
      gap: 8,
    },
    lockedText: { color: textSecondary, fontSize: 13, lineHeight: 20 },
  });
}
