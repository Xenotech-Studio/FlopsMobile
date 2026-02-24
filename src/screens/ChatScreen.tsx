import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import {
  createConversation,
  streamChat,
  cancelConversation,
  submitSafetyDecision,
  type ChatStreamEvent,
} from '../api';
import { MarkdownContent } from '../components/MarkdownContent';

type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; blocks?: StreamBlock[] }
  | { role: 'error'; content: string };

type ToolResult = { stdout?: string; error?: string; success?: boolean };

type StreamBlock =
  | { type: 'text'; content: string }
  | {
      type: 'tool';
      tool_name: string;
      status: string;
      arguments?: string;
      streaming_content?: string;
      result?: ToolResult | unknown;
      review_id?: string;
      conversation_id?: string;
      review?: Record<string, unknown>;
      command?: string;
      cwd?: string;
    };

const STREAM_TIMEOUT_MS = 300000;

export function ChatScreen() {
  const { session, logout } = useSession();
  const [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [currentAssistantBlocks, setCurrentAssistantBlocks] = useState<StreamBlock[]>([]);
  const [error, setError] = useState('');
  const [submittingReviewId, setSubmittingReviewId] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);

  const canSend = Boolean(session && messageInput.trim() && !loading);

  const handleSendMessage = useCallback(async () => {
    if (!session || !messageInput.trim() || loading) return;
    const nextMessage = messageInput.trim();
    setMessageInput('');
    setError('');
    setLoading(true);
    setStreamingText('');
    setCurrentAssistantBlocks([]);
    setStreamStatus('thinking');
    setMessages((prev) => [...prev, { role: 'user', content: nextMessage }]);

    let convId = conversationId;
    if (!convId) {
      try {
        const { id } = await createConversation(session);
        convId = id;
        setConversationId(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : '创建会话失败');
        setMessages((prev) => [...prev, { role: 'error', content: String(e) }]);
        setLoading(false);
        return;
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    manualStopRef.current = false;
    let finalText = '';
    let streamDone = false;
    const localBlocks: StreamBlock[] = [];

    const syncBlocks = () => {
      setCurrentAssistantBlocks([...localBlocks]);
      finalText = localBlocks
        .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
        .map((b) => b.content)
        .join('');
      setStreamingText(finalText);
    };

    const onEvent = (event: ChatStreamEvent) => {
      if ('conversation_id' in event && event.conversation_id && !convId) {
        setConversationId(event.conversation_id);
        convId = event.conversation_id;
      }
      if ('error' in event && event.error) throw new Error(event.error);
      if ('type' in event) {
        if (event.type === 'thinking') setStreamStatus('thinking');
        if (event.type === 'checking_tools') setStreamStatus('checking_tools');
        if (event.type === 'tool_start') {
          setStreamStatus('tool_running');
          const name = String(event.tool_name || 'unknown');
          let updated = false;
          for (let i = 0; i < localBlocks.length; i++) {
            const b = localBlocks[i];
            if (b.type === 'tool' && b.tool_name === name && b.status !== 'completed') {
              localBlocks[i] = { ...b, status: 'running', arguments: event.arguments, streaming_content: '' };
              updated = true;
              break;
            }
          }
          if (!updated) {
            localBlocks.push({
              type: 'tool',
              tool_name: name,
              status: 'running',
              arguments: event.arguments,
              streaming_content: '',
            });
          }
          syncBlocks();
        }
        if (event.type === 'tool_stream') {
          const name = String(event.tool_name || 'local_cursor_agent');
          const chunk = typeof (event as { chunk?: string }).chunk === 'string' ? (event as { chunk: string }).chunk : '';
          if (chunk) {
            for (let i = localBlocks.length - 1; i >= 0; i--) {
              const b = localBlocks[i];
              if (b.type === 'tool' && b.tool_name === name && b.status === 'running') {
                const cur = b.streaming_content ?? '';
                localBlocks[i] = { ...b, streaming_content: cur + chunk };
                break;
              }
            }
            syncBlocks();
          }
        }
        if (event.type === 'tool_result') {
          setStreamStatus('tool_result');
          const name = event.tool_name;
          for (let i = localBlocks.length - 1; i >= 0; i--) {
            const b = localBlocks[i];
            if (b.type === 'tool' && b.tool_name === name) {
              localBlocks[i] = { ...b, status: 'completed', result: event.result };
              break;
            }
          }
          syncBlocks();
        }
        if (event.type === 'safety_confirmation_required') {
          setStreamStatus('awaiting_safety_confirmation');
          const name = event.tool_name;
          let updated = false;
          for (let i = localBlocks.length - 1; i >= 0; i--) {
            const b = localBlocks[i];
            if (b.type === 'tool' && b.tool_name === name) {
              localBlocks[i] = {
                ...b,
                status: 'awaiting_confirmation',
                arguments: event.command ?? (event as { arguments?: string }).arguments,
                review_id: event.review_id,
                conversation_id: event.conversation_id || convId,
                review: event.review,
                command: event.command,
                cwd: event.cwd,
              };
              updated = true;
              break;
            }
          }
          if (!updated) {
            localBlocks.push({
              type: 'tool',
              tool_name: name,
              status: 'awaiting_confirmation',
              review_id: event.review_id,
              conversation_id: event.conversation_id || convId,
              review: event.review,
              command: event.command,
              cwd: event.cwd,
            });
          }
          syncBlocks();
        }
      }
      if ('content' in event && typeof event.content === 'string' && event.content.length > 0) {
        setStreamStatus('streaming_text');
        const last = localBlocks[localBlocks.length - 1];
        if (last && last.type === 'text') {
          last.content += event.content;
        } else {
          localBlocks.push({ type: 'text', content: event.content });
        }
        syncBlocks();
      }
      if ('done' in event && event.done === true) streamDone = true;
    };

    const timeout = setTimeout(() => {
      controller.abort();
    }, STREAM_TIMEOUT_MS);

    try {
      await streamChat(session, convId, nextMessage, onEvent, controller.signal);
      clearTimeout(timeout);
      if (streamDone || finalText.trim()) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: finalText.trim() || '(empty response)',
            blocks: localBlocks.length ? localBlocks : undefined,
          },
        ]);
      }
    } catch (e) {
      clearTimeout(timeout);
      if (e && (e as { name?: string }).name === 'AbortError' && manualStopRef.current) {
        const stoppedPrefix = '[已停止]\n';
        const text = (finalText || '').trim();
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: text ? `${stoppedPrefix}${text}` : '[已停止]',
            blocks: localBlocks.length ? [{ type: 'text', content: stoppedPrefix }, ...localBlocks] : undefined,
          },
        ]);
      } else {
        const msg =
          (e as { name?: string })?.name === 'AbortError'
            ? '已手动停止本轮执行。'
            : e instanceof Error
              ? e.message
              : String(e);
        setMessages((prev) => [...prev, { role: 'error', content: msg }]);
      }
    } finally {
      abortRef.current = null;
      manualStopRef.current = false;
      setSubmittingReviewId('');
      setLoading(false);
      setStreamingText('');
      setCurrentAssistantBlocks([]);
      setStreamStatus('');
    }
  }, [session, conversationId, messageInput, loading]);

  const handleStop = useCallback(async () => {
    setError('');
    manualStopRef.current = true;
    const snapshotBlocks = [...currentAssistantBlocks];
    const snapshotText = streamingText;
    if (snapshotBlocks.length > 0 || (snapshotText && snapshotText.trim())) {
      const stoppedPrefix = '[已停止]\n';
      const text = (snapshotText || '').trim();
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: text ? `${stoppedPrefix}${text}` : '[已停止]',
          blocks: [{ type: 'text', content: stoppedPrefix }, ...snapshotBlocks],
        },
      ]);
    }
    if (abortRef.current) abortRef.current.abort();
    if (session && conversationId) {
      try {
        await cancelConversation(session, conversationId);
      } catch {
        // ignore
      }
    }
    setLoading(false);
    setStreamStatus('');
    setStreamingText('');
    setCurrentAssistantBlocks([]);
  }, [session, conversationId, currentAssistantBlocks, streamingText]);

  const handleNewConversation = useCallback(async () => {
    if (loading) return;
    setError('');
    setConversationId('');
    setMessages([]);
    try {
      if (session) {
        const { id } = await createConversation(session);
        setConversationId(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建会话失败');
    }
  }, [session, loading]);

  const handleSafetyDecision = useCallback(
    async (reviewId: string, decision: 'approve' | 'reject') => {
      if (!session || !conversationId) return;
      setSubmittingReviewId(reviewId);
      try {
        await submitSafetyDecision(session, conversationId, reviewId, decision);
        if (decision === 'approve') setStreamStatus('tool_running');
      } catch (e) {
        setError(e instanceof Error ? e.message : '提交确认失败');
      } finally {
        setSubmittingReviewId('');
      }
    },
    [session, conversationId]
  );

  function parseCursorAgentArgs(block: StreamBlock): { prompt: string; cwd: string } {
    if (block.type !== 'tool') return { prompt: '', cwd: '' };
    const raw = block.arguments;
    if (raw == null || raw === '') return { prompt: '', cwd: '' };
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        prompt: String(obj.prompt ?? '').trim(),
        cwd: String(obj.cwd ?? '').trim(),
      };
    } catch {
      return { prompt: String(raw).slice(0, 500), cwd: '' };
    }
  }

  function renderCursorAgentBlock(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const { prompt, cwd } = parseCursorAgentArgs(block);
    const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
    const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;

    if (isAwaiting) {
      const review = block.review as { reason?: string; advice?: string; decision?: string } | undefined;
      return (
        <View key={key} style={styles.toolCard}>
          <Text style={styles.toolCardHeader}>Cursor Agent · {block.status}</Text>
          {block.cwd ? <Text style={styles.toolCardSafetyMeta}>cwd: {block.cwd}</Text> : null}
          {review?.reason ? <Text style={styles.toolCardSafetyReason}>{review.reason}</Text> : null}
          {review?.advice ? (
            <Text
              style={[
                styles.toolCardSafetyAdvice,
                review.decision === 'need_confirm_after_warning' && styles.toolCardSafetyAdviceDanger,
              ]}
            >
              {review.advice}
            </Text>
          ) : null}
          <View style={styles.safetyActions}>
            <TouchableOpacity
              style={styles.safetyBtn}
              onPress={() => handleSafetyDecision(block.review_id!, 'reject')}
              disabled={!!isSubmitting}
            >
              <Text style={styles.safetyBtnText}>拒绝</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.safetyBtn, styles.safetyBtnPrimary]}
              onPress={() => handleSafetyDecision(block.review_id!, 'approve')}
              disabled={!!isSubmitting}
            >
              <Text style={styles.safetyBtnPrimaryText}>
                {isSubmitting ? '提交中...' : '确认执行'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    const result = block.result as ToolResult | undefined;
    const replyText =
      block.streaming_content ??
      (result && typeof result.stdout === 'string' ? result.stdout : '') ??
      '';
    const errorMsg = result && typeof result.error === 'string' ? result.error : null;
    const hasError = Boolean(errorMsg || (result && result.success === false));
    const isRunning = block.status === 'running';

    return (
      <View key={key} style={styles.cursorAgentWrap}>
        <View style={styles.cursorAgentPromptCard}>
          <Text style={styles.cursorAgentPromptLabel}>提问</Text>
          <Text style={styles.cursorAgentPromptText}>{prompt || '(无 prompt)'}</Text>
          {cwd ? <Text style={styles.cursorAgentPromptMeta}>cwd: {cwd}</Text> : null}
        </View>
        <View style={styles.cursorAgentReply}>
          <Text style={styles.cursorAgentReplyLabel}>回答</Text>
          {hasError && errorMsg ? (
            <Text style={styles.cursorAgentReplyError}>{errorMsg}</Text>
          ) : replyText ? (
            <View style={styles.cursorAgentReplyBody}>
              <MarkdownContent text={replyText} showCopyButton />
            </View>
          ) : isRunning ? (
            <Text style={styles.cursorAgentReplyLoading}>Cursor 正在分析并输出…</Text>
          ) : (
            <Text style={styles.cursorAgentReplyEmpty}>暂无输出</Text>
          )}
        </View>
      </View>
    );
  }

  function renderToolBlock(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    if (block.tool_name === 'local_cursor_agent') {
      return renderCursorAgentBlock(block, key);
    }
    const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
    const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;
    return (
      <View key={key} style={styles.toolCard}>
        <Text style={styles.toolCardHeader}>
          {block.tool_name} · {block.status}
        </Text>
        {block.arguments ? (
          <Text style={styles.toolCardBody} numberOfLines={10}>
            args: {String(block.arguments)}
          </Text>
        ) : null}
        {block.streaming_content ? (
          <Text style={styles.toolCardBody} numberOfLines={15}>
            {block.streaming_content}
          </Text>
        ) : null}
        {block.result != null && (
          <Text style={styles.toolCardBody} numberOfLines={10}>
            {typeof block.result === 'string'
              ? block.result
              : JSON.stringify(block.result)}
          </Text>
        )}
        {isAwaiting && block.review_id ? (
          <View style={styles.safetyActions}>
            <TouchableOpacity
              style={styles.safetyBtn}
              onPress={() => handleSafetyDecision(block.review_id!, 'reject')}
              disabled={!!isSubmitting}
            >
              <Text style={styles.safetyBtnText}>拒绝</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.safetyBtn, styles.safetyBtnPrimary]}
              onPress={() => handleSafetyDecision(block.review_id!, 'approve')}
              disabled={!!isSubmitting}
            >
              <Text style={styles.safetyBtnPrimaryText}>
                {isSubmitting ? '提交中...' : '确认执行'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  }

  if (!session) return null;

  const lastAssistantIdx = (() => {
    let last = -1;
    messages.forEach((m, i) => {
      if (m.role === 'assistant') last = i;
    });
    return last;
  })();

  const renderMessage = (msg: Message, idx: number) => {
    if (msg.role === 'error') {
      return (
        <View key={`err-${idx}`} style={styles.errorWrap}>
          <Text style={styles.errorText}>{msg.content}</Text>
        </View>
      );
    }
    const isUser = msg.role === 'user';
    const isLastAssistant = !isUser && msg.role === 'assistant' && idx === lastAssistantIdx;
    let lastTextBlockIdx = -1;
    if (!isUser && msg.role === 'assistant' && msg.blocks?.length) {
      msg.blocks.forEach((b, i) => {
        if (b.type === 'text') lastTextBlockIdx = i;
      });
    }
    return (
      <View
        key={`${msg.role}-${idx}`}
        style={[styles.bubbleWrap, isUser ? styles.userBubbleWrap : styles.assistantBubbleWrap]}
      >
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          {!isUser && <Text style={styles.bubbleRole}>Flops</Text>}
          {!isUser && msg.role === 'assistant' && msg.blocks && msg.blocks.length > 0 ? (
            msg.blocks.map((block, bi) =>
              block.type === 'text' ? (
                <View key={bi} style={styles.assistantTextBlock}>
                  <MarkdownContent
                    text={block.content}
                    showCopyButton={isLastAssistant && bi === lastTextBlockIdx}
                  />
                </View>
              ) : (
                renderToolBlock(block, `msg-tool-${idx}-${bi}`)
              )
            )
          ) : (
            isUser ? (
              <Text style={styles.userText} selectable>{msg.content}</Text>
            ) : (
              <MarkdownContent text={msg.content} showCopyButton={isLastAssistant} />
            )
          )}
        </View>
      </View>
    );
  };

  const showEmpty = messages.length === 0 && !loading;
  const streamStatusLabel =
    streamStatus === 'checking_tools'
      ? 'Checking tools...'
      : streamStatus === 'tool_running'
        ? 'Running tools...'
        : streamStatus === 'awaiting_safety_confirmation'
          ? '等待安全确认'
          : 'Thinking...';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={0}
      >
        <View style={styles.header}>
        <Text style={styles.headerTitle}>Flops</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={handleNewConversation}
            disabled={loading}
          >
            <Text style={styles.headerBtnText}>新对话</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} onPress={logout}>
            <Text style={styles.headerBtnText}>退出</Text>
          </TouchableOpacity>
        </View>
      </View>
      {error ? <Text style={styles.globalError}>{error}</Text> : null}
      {conversationId ? (
        <Text style={styles.convMeta} numberOfLines={1}>
          Conversation: {conversationId}
        </Text>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {showEmpty ? (
          <View style={styles.emptyStage}>
            <Text style={styles.welcomeTitle}>Hi, {session.user_id}</Text>
            <Text style={styles.welcomeSubtitle}>输入第一句话开始对话。</Text>
          </View>
        ) : (
          messages.map(renderMessage)
        )}
        {loading ? (
          <View style={[styles.bubbleWrap, styles.assistantBubbleWrap]}>
            <View style={[styles.bubble, styles.assistantBubble]}>
              <Text style={styles.bubbleRole}>Flops (streaming)</Text>
              {streamStatus === 'checking_tools' ? (
                <Text style={styles.streamStatus}>Checking tools...</Text>
              ) : null}
              {streamStatus === 'tool_running' ? (
                <Text style={styles.streamStatus}>Running local tools...</Text>
              ) : null}
              {currentAssistantBlocks.length > 0 ? (
                currentAssistantBlocks.map((block, bi) =>
                  block.type === 'text' ? (
                    <View key={bi} style={styles.assistantTextBlock}>
                      <MarkdownContent text={block.content} />
                    </View>
                  ) : (
                    renderToolBlock(block, `stream-tool-${bi}`)
                  )
                )
              ) : null}
              {currentAssistantBlocks.length === 0 ? (
                <View style={styles.assistantTextBlock}>
                  <MarkdownContent text={streamingText || streamStatusLabel} />
                </View>
              ) : null}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={messageInput}
          onChangeText={setMessageInput}
          placeholder={showEmpty ? '输入你的第一句话...' : '输入消息'}
          placeholderTextColor="#9ca3af"
          editable={!loading}
          onSubmitEditing={handleSendMessage}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={[
            styles.sendBtn,
            loading && styles.sendBtnStop,
            (!canSend && !loading) && styles.sendBtnDisabled,
          ]}
          onPress={loading ? handleStop : handleSendMessage}
          disabled={!loading && !canSend}
        >
          {loading ? (
            <Text style={styles.sendBtnText}>■</Text>
          ) : (
            <Text style={styles.sendBtnText}>↑</Text>
          )}
        </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  keyboardView: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  headerActions: { flexDirection: 'row', gap: 12 },
  headerBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  headerBtnText: { fontSize: 14, color: '#374151' },
  globalError: { color: '#dc2626', fontSize: 13, paddingHorizontal: 16, paddingVertical: 6 },
  convMeta: { fontSize: 11, color: '#6b7280', paddingHorizontal: 16, marginBottom: 4 },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24 },
  emptyStage: { flex: 1, paddingVertical: 40 },
  welcomeTitle: { fontSize: 22, fontWeight: '700', color: '#0f172a', marginBottom: 8 },
  welcomeSubtitle: { fontSize: 15, color: '#6b7280' },
  bubbleWrap: { marginBottom: 12 },
  userBubbleWrap: { alignItems: 'flex-end' },
  assistantBubbleWrap: { width: '100%' },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  userBubble: { backgroundColor: '#0f172a' },
  assistantBubble: {
    width: '100%',
    maxWidth: '100%',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingVertical: 8,
    paddingHorizontal: 0,
  },
  bubbleRole: { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  userText: { fontSize: 16, color: '#fff' },
  assistantText: { fontSize: 16, color: '#111827', lineHeight: 22 },
  streamStatus: { fontSize: 14, color: '#6b7280', fontStyle: 'italic' },
  errorWrap: { marginBottom: 12, padding: 12, backgroundColor: '#fef2f2', borderRadius: 8 },
  errorText: { color: '#dc2626', fontSize: 14 },
  assistantTextBlock: { marginTop: 4 },
  toolCard: {
    marginTop: 8,
    padding: 10,
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#dbeafe',
  },
  toolCardHeader: { fontSize: 12, fontWeight: '600', color: '#1f2937', marginBottom: 6 },
  toolCardBody: { fontSize: 12, color: '#1e293b', marginTop: 4 },
  toolCardSafetyMeta: { fontSize: 11, color: '#64748b', marginTop: 4 },
  toolCardSafetyReason: { fontSize: 12, color: '#334155', marginTop: 4 },
  toolCardSafetyAdvice: {
    fontSize: 12,
    marginTop: 6,
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#dbeafe',
    backgroundColor: '#f8fafc',
  },
  toolCardSafetyAdviceDanger: {
    color: '#991b1b',
    backgroundColor: '#fff1f2',
    borderColor: '#fecdd3',
  },
  safetyActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  safetyBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#e5e7eb' },
  safetyBtnPrimary: { backgroundColor: '#0f172a' },
  safetyBtnText: { color: '#374151', fontSize: 14 },
  safetyBtnPrimaryText: { color: '#fff', fontSize: 14 },
  cursorAgentWrap: { marginTop: 4, gap: 12 },
  cursorAgentPromptCard: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
  },
  cursorAgentPromptLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 6,
    letterSpacing: 0.4,
  },
  cursorAgentPromptText: { fontSize: 14, lineHeight: 20, color: '#111827' },
  cursorAgentPromptMeta: { fontSize: 12, color: '#6b7280', marginTop: 8 },
  cursorAgentReply: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#dbeafe',
    backgroundColor: '#fff',
  },
  cursorAgentReplyLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1d4ed8',
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  cursorAgentReplyBody: { marginTop: 0 },
  cursorAgentReplyLoading: { fontSize: 13, color: '#6b7280', fontStyle: 'italic' },
  cursorAgentReplyEmpty: { fontSize: 13, color: '#6b7280', fontStyle: 'italic' },
  cursorAgentReplyError: {
    fontSize: 13,
    color: '#b91c1c',
    backgroundColor: '#fef2f2',
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    gap: 8,
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111827',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnStop: { backgroundColor: '#dc2626' },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnText: { color: '#fff', fontSize: 18 },
});
