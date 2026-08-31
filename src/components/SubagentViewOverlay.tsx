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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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
  /** 「打开原对话」（仅 flops）：导航到该子对话作为独立会话（由 ChatScreen 注入）。 */
  onOpenConversation?: (conversationId: string) => void;
  /** ChatScreen 的样式/配色/工具状态文案——传给复用的 SubagentCard，令其渲染与主对话一致。 */
  cardStyles: Record<string, any>;
  cardColors: Record<string, any>;
  getToolStatusLabel: (status: string) => string;
};

/** 初始加载骨架屏：撑起正常高度（不塌陷），脉动占位；数据到了替换成真实内容。 */
function LoadingSkeleton({ colors }: { colors: Record<string, any> }): React.ReactElement {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const base =
    (colors?.surfaceMuted as string) || (colors?.border as string) || 'rgba(255,255,255,0.10)';
  const Bar = ({ w, h = 12, extra }: { w: number | string; h?: number; extra?: object }) => (
    <Animated.View
      style={[{ height: h, width: w as any, borderRadius: 6, backgroundColor: base, opacity: pulse }, extra]}
    />
  );
  return (
    <View style={{ minHeight: 280, paddingHorizontal: 14, paddingTop: 12, gap: 22 }}>
      {[0, 1].map((t) => (
        <View key={t} style={{ gap: 8 }}>
          <Bar w={'42%'} h={16} extra={{ alignSelf: 'flex-end' }} />
          <Bar w={'30%'} />
          <Bar w={'95%'} />
          <Bar w={'85%'} />
          <Bar w={'70%'} />
          <Bar w={'100%'} h={56} extra={{ borderRadius: 10 }} />
        </View>
      ))}
    </View>
  );
}

export function SubagentViewOverlay({
  visible,
  session,
  parentConversationId,
  targetSessionId,
  agentType = 'flops',
  deviceId,
  cwd,
  onClose,
  onOpenConversation,
  cardStyles,
  cardColors,
  getToolStatusLabel,
}: Props): React.ReactElement | null {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<ViewData | null>(null);
  // claude/cursor 分支：直接从 agent_blocks 建好的假 block（不经消息→block 转换）。
  const [blockOverride, setBlockOverride] = useState<Record<string, unknown> | null>(null);
  // 轮次分页（flops）：累积已加载的原始消息（最旧在前），配 oldestRound/hasMore 向前翻。
  const [rawAccum, setRawAccum] = useState<any[]>([]);
  const [oldestRound, setOldestRound] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 滚动锚定：加载更早时记录「距底距离」，内容变高后（onContentSizeChange）还原滚动位置，视口不跳。
  const scrollRef = useRef<ScrollView>(null);
  const contentHeightRef = useRef(0);
  const scrollYRef = useRef(0);
  const pendingAnchorRef = useRef<number | null>(null);

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
          // flops：子 agent 弹窗要看完整工作过程——subagent 常有多轮 trigger 提问、每轮带工具调用，
          // 只取 1 轮会切掉绝大多数工具步骤。取满 50 轮（后端上限）≈ 全部工作，超长再「加载更早」。
          const res = (await getSubagentView(session, {
            parentConversationId,
            targetSessionId,
            limitRounds: 50,
          })) as ViewData;
          setData(res);
          const raw = Array.isArray(res?.messages_full)
            ? res.messages_full
            : Array.isArray(res?.messages)
              ? res.messages
              : [];
          setRawAccum(raw);
          setOldestRound(
            typeof (res as any)?.round_start_index === 'number' ? (res as any).round_start_index : null,
          );
          setHasMore(Boolean((res as any)?.has_more));
        }
      } catch (e) {
        setError((e as Error)?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [session, parentConversationId, targetSessionId, agentType, deviceId, cwd]);

  // 加载更早一轮：取 oldestRound 之前一轮，PREPEND 到累积消息头部（保持最旧在前）。
  const loadMore = useCallback(() => {
    if (loadingMore || oldestRound == null || oldestRound <= 0) return;
    setLoadingMore(true);
    void (async () => {
      try {
        const res = (await getSubagentView(session, {
          parentConversationId,
          targetSessionId,
          limitRounds: 50,
          beforeRoundIndex: oldestRound,
        })) as ViewData;
        const older = Array.isArray(res?.messages_full)
          ? res.messages_full
          : Array.isArray(res?.messages)
            ? res.messages
            : [];
        if (older.length) {
          // prepend 前记录距底距离；onContentSizeChange 在内容变高后据此 scrollTo 还原。
          pendingAnchorRef.current = contentHeightRef.current - scrollYRef.current;
          setRawAccum((prev) => [...older, ...prev]);
        }
        setOldestRound(
          typeof (res as any)?.round_start_index === 'number' ? (res as any).round_start_index : 0,
        );
        setHasMore(Boolean((res as any)?.has_more));
      } catch (e) {
        setError((e as Error)?.message || String(e));
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [loadingMore, oldestRound, session, parentConversationId, targetSessionId]);

  useEffect(() => {
    if (visible) load();
    else {
      setData(null);
      setBlockOverride(null);
      setError('');
      setRawAccum([]);
      setOldestRound(null);
      setHasMore(false);
      setLoadingMore(false);
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
              {!isExecutor && targetSessionId && typeof onOpenConversation === 'function' ? (
                // 「打开原对话」（仅 flops）：导航到该子对话作为独立会话。
                <TouchableOpacity
                  style={styles.iconBtn}
                  onPress={() => onOpenConversation(targetSessionId)}
                  activeOpacity={0.7}
                  accessibilityLabel="打开原对话"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="open-outline" size={20} color={cardColors?.textSecondary || '#888'} />
                </TouchableOpacity>
              ) : null}
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
              <LoadingSkeleton colors={cardColors} />
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
              <ScrollView
                ref={scrollRef}
                style={styles.scroll}
                contentContainerStyle={styles.cardScrollContent}
                scrollEventThrottle={16}
                onScroll={(e) => {
                  scrollYRef.current = e.nativeEvent.contentOffset.y;
                }}
                onContentSizeChange={(_w, h) => {
                  contentHeightRef.current = h;
                  // 仅加载更早后有 pending：按新内容高度还原滚动位置，保持视口不动。
                  if (pendingAnchorRef.current != null) {
                    const y = Math.max(0, h - pendingAnchorRef.current);
                    pendingAnchorRef.current = null;
                    scrollRef.current?.scrollTo({ y, animated: false });
                  }
                }}
              >
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
                  /* flops：铺开成普通对话消息列表（用户气泡 + assistant 正文/思考/工具块）。
                     更早的轮次在上方：顶部「加载更早」按钮向前翻一轮。 */
                  <>
                    {hasMore ? (
                      <TouchableOpacity
                        style={styles.loadMoreBtn}
                        onPress={loadMore}
                        disabled={loadingMore}
                        activeOpacity={0.7}
                      >
                        {loadingMore ? (
                          <ActivityIndicator size="small" color={spinnerColor} />
                        ) : (
                          <Text style={styles.loadMoreText}>加载更早对话</Text>
                        )}
                      </TouchableOpacity>
                    ) : null}
                    <SubagentConversationMessages
                      messages={rawMessagesToLocal(rawAccum)}
                      styles={cardStyles}
                      colors={cardColors}
                      getToolStatusLabel={getToolStatusLabel}
                    />
                  </>
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
    // 顶部「加载更早对话」：居中胶囊按钮
    loadMoreBtn: {
      alignSelf: 'center',
      marginBottom: 12,
      paddingVertical: 6,
      paddingHorizontal: 16,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: border,
      minHeight: 30,
      justifyContent: 'center',
    },
    loadMoreText: { color: textMuted, fontSize: 13 },
  });
}
