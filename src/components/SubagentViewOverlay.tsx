/**
 * 查看 flops 子agent 的子对话内容——全屏 Modal 覆盖层。
 *
 * 点子agent 卡片的「查看对话」触发：拉取子对话最近 N 条消息（GET 语义走 POST subagent_view），
 * 渲染用户/子agent 双方消息 + 运行状态。加密子对话需带父对话 K_conv wire（api.getSubagentView
 * 内部处理）；拿不到钥匙时服务端回 needs_authorization，本层显示 locked 面板提示先在对话中授权。
 *
 * 样式对齐 ConversationTitlesRequestOverlay / ConversationAccessRequestOverlay 的暗色卡片语汇。
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
import { MarkdownContent } from './MarkdownContent';
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
  note?: string;
};

type Props = {
  visible: boolean;
  session: Session;
  parentConversationId: string;
  targetSessionId: string;
  title?: string;
  onClose: () => void;
};

export function SubagentViewOverlay({
  visible,
  session,
  parentConversationId,
  targetSessionId,
  title,
  onClose,
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

  // 一变可见就拉一次（每次打开都刷新）。
  useEffect(() => {
    if (visible) load();
    else {
      setData(null);
      setError('');
    }
  }, [visible, load]);

  if (!visible) return null;

  const locked = data?.status === 'needs_authorization';
  const isRunning = Boolean(data?.is_running);
  const subStatus = String(data?.subagent_status || '').trim();
  const headerTitle = (data?.title || title || '').trim() || '子对话';
  const messages = Array.isArray(data?.messages) ? (data?.messages as Msg[]) : [];

  const statusText = isRunning
    ? '运行中'
    : subStatus === 'completed' || (data && !isRunning && !locked)
      ? '已完成'
      : subStatus || '';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={2}>
              {headerTitle}
            </Text>
            {statusText ? (
              <View style={[styles.badge, isRunning ? styles.badgeRunning : styles.badgeDone]}>
                <Text style={[styles.badgeText, isRunning ? styles.badgeTextRunning : styles.badgeTextDone]}>
                  {statusText}
                </Text>
              </View>
            ) : null}
          </View>

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
            ) : (
              <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                {messages.length === 0 ? (
                  <Text style={styles.dimText}>暂无内容</Text>
                ) : (
                  messages.map((m, i) => {
                    const isUser = String(m?.role || '') === 'user';
                    // 复用工具卡展开态的呈现：提问/回答 label（同卡片语汇）+ 内容走与卡片同一个
                    // MarkdownContent（代码块/列表/字体一致），而非纯文本。
                    return (
                      <View key={i} style={styles.msgRow}>
                        <Text style={[styles.roleLabel, isUser ? styles.roleUser : styles.roleAgent]}>
                          {isUser ? '提问' : '回答'}
                        </Text>
                        <View style={styles.msgBody}>
                          <MarkdownContent text={String(m?.content || '').trim()} showCopyButton={false} />
                        </View>
                      </View>
                    );
                  })
                )}
                {isRunning ? (
                  <View style={styles.thinkingRow}>
                    <ActivityIndicator size="small" color="rgba(255,255,255,0.7)" />
                    <Text style={styles.dimText}>思考中…</Text>
                  </View>
                ) : null}
              </ScrollView>
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
    paddingHorizontal: 16,
  },
  card: {
    maxHeight: '80%',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: '#1c1c1e',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.10)',
  },
  title: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '600' },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 9999,
  },
  badgeRunning: { backgroundColor: 'rgba(90,170,255,0.18)' },
  badgeDone: { backgroundColor: 'rgba(120,200,140,0.18)' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  badgeTextRunning: { color: '#7cbcff' },
  badgeTextDone: { color: '#86d29a' },
  body: { minHeight: 120, maxHeight: 460 },
  scroll: { flexGrow: 0 },
  scrollContent: { padding: 16, gap: 14 },
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 24,
    justifyContent: 'center',
  },
  centerCol: { padding: 24, alignItems: 'center', gap: 8 },
  msgRow: { gap: 4 },
  roleLabel: { fontSize: 11, fontWeight: '600' },
  roleUser: { color: 'rgba(255,255,255,0.55)' },
  roleAgent: { color: '#7cbcff' },
  // 内容容器：对齐工具卡回答区（reply body）的轻缩进；正文交给 MarkdownContent 渲染。
  msgBody: { marginTop: 2 },
  msgContent: { color: 'rgba(255,255,255,0.88)', fontSize: 13, lineHeight: 20 },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  lockedPanel: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    gap: 8,
  },
  lockedText: { color: 'rgba(255,255,255,0.82)', fontSize: 13, lineHeight: 20 },
  dimText: { color: 'rgba(255,255,255,0.5)', fontSize: 13, lineHeight: 19 },
  errorText: { color: '#ff8f8a', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.10)',
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
