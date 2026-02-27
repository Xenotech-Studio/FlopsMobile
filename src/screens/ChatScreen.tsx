import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import {
  createConversation,
  streamChat,
  cancelConversation,
  submitSafetyDecision,
  listConversations,
  getConversation,
  type ChatStreamEvent,
  type ConversationListItem,
  type ConversationMessage,
} from '../api';
import Ionicons from 'react-native-vector-icons/Ionicons';
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

const TOOL_PACKAGE_NAV_NAMES = ['open_tool_packages', 'close_tool_packages'];

function getToolPackageNavLabel(name: string, argsStr: string | undefined): string {
  let paths: string[] = [];
  try {
    const obj = typeof argsStr === 'string' ? JSON.parse(argsStr || '{}') : argsStr || {};
    paths = Array.isArray(obj.package_paths) ? obj.package_paths : [];
  } catch {
    // ignore
  }
  const list = paths.map((p) => (typeof p === 'string' ? p : String(p))).filter(Boolean);
  const isOpen = name === 'open_tool_packages';
  if (list.length === 0) return isOpen ? '工具包已激活' : '工具包已关闭';
  if (list.length === 1) return `${list[0]} 工具包已${isOpen ? '激活' : '关闭'}`;
  return `${list[0]} 等 ${list.length} 个工具包已${isOpen ? '激活' : '关闭'}`;
}

function isToolPackageNavBlock(b: { type: string; tool_name?: string }): boolean {
  return b.type === 'tool' && b.tool_name != null && TOOL_PACKAGE_NAV_NAMES.includes(b.tool_name);
}

/** 解析 tool 消息的 content 为 result 对象 */
function parseToolResult(msg: ConversationMessage): unknown {
  if (!msg || msg.role !== 'tool') return null;
  const raw = typeof msg.content === 'string' ? msg.content : '';
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** 将服务端一轮 assistant + tool 消息合并为一条本地 assistant（含 blocks） */
function coalesceAssistantTurn(messages: ConversationMessage[]): Message | null {
  if (!messages || messages.length === 0) return null;
  const blocks: StreamBlock[] = [];
  let fullContent = '';
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const text = (msg.content != null ? String(msg.content) : '').trim();
      if (text) {
        blocks.push({ type: 'text', content: text });
        fullContent += (fullContent ? '\n\n' : '') + text;
      }
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length > 0) {
        for (let j = 0; j < toolCalls.length; j++) {
          const tc = toolCalls[j];
          const fn = typeof tc === 'object' && tc && tc.function ? tc.function : {};
          const name = (fn.name != null && fn.name !== '') ? fn.name : 'unknown';
          const args =
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments != null ? fn.arguments : {});
          const toolMsg = messages[i + 1 + j];
          const result = toolMsg && toolMsg.role === 'tool' ? parseToolResult(toolMsg) : null;
          blocks.push({
            type: 'tool',
            tool_name: name,
            status: 'completed',
            arguments: args,
            result,
          });
        }
        i += 1 + toolCalls.length;
        continue;
      }
      i++;
    } else if (msg.role === 'tool') {
      i++;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) return null;
  return {
    role: 'assistant',
    content: fullContent || '(empty)',
    blocks,
  };
}

export function ChatScreen() {
  const { session, logout } = useSession();
  const [conversationId, setConversationId] = useState('');
  const [conversationTitle, setConversationTitle] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [currentAssistantBlocks, setCurrentAssistantBlocks] = useState<StreamBlock[]>([]);
  const [error, setError] = useState('');
  const [submittingReviewId, setSubmittingReviewId] = useState('');
  /** 工具卡片展示状态：key -> 'collapsed' | 'preview' | 'full' */
  const [toolCardViewMode, setToolCardViewMode] = useState<Record<string, 'collapsed' | 'preview' | 'full'>>({});
  const [historyModalVisible, setHistoryModalVisible] = useState(false);
  const [historyList, setHistoryList] = useState<ConversationListItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);
  /** 仅在有新消息/回复完成时滚到底部，避免展开折叠工具卡片时误滚 */
  const shouldScrollToEndRef = useRef(false);

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
    shouldScrollToEndRef.current = true;

    let convId = conversationId;
    if (!convId) {
      try {
        const { id } = await createConversation(session);
        convId = id;
        setConversationId(id);
        setConversationTitle(nextMessage.slice(0, 50) || '新对话');
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
        shouldScrollToEndRef.current = true;
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
        shouldScrollToEndRef.current = true;
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
        shouldScrollToEndRef.current = true;
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

  /** 回退到第 (afterUserIndex+1) 条 user 消息处并重新生成该条 AI 回复 */
  const handleRegenerate = useCallback(
    async (afterUserIndex: number) => {
      if (!session || !conversationId || loading || afterUserIndex == null) return;
      setMessages((prev) => {
        let userCount = 0;
        let keepThroughIdx = -1;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].role === 'user') {
            userCount++;
            if (userCount === afterUserIndex + 1) {
              keepThroughIdx = i;
              break;
            }
          }
        }
        if (keepThroughIdx < 0) return prev;
        return prev.slice(0, keepThroughIdx + 1);
      });
    setError('');
    setLoading(true);
    setStreamingText('');
    setCurrentAssistantBlocks([]);
    setStreamStatus('thinking');
    shouldScrollToEndRef.current = true;

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
                conversation_id: event.conversation_id || conversationId,
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
              conversation_id: event.conversation_id || conversationId,
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

    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    try {
      await streamChat(session, conversationId, '', onEvent, controller.signal, {
        regenerate: true,
        after_user_index: afterUserIndex,
      });
      clearTimeout(timeout);
      if (streamDone || finalText.trim()) {
        shouldScrollToEndRef.current = true;
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
        shouldScrollToEndRef.current = true;
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
        shouldScrollToEndRef.current = true;
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
  },
    [session, conversationId, loading]
  );

  const handleStop = useCallback(async () => {
    setError('');
    manualStopRef.current = true;
    const snapshotBlocks = [...currentAssistantBlocks];
    const snapshotText = streamingText;
    if (snapshotBlocks.length > 0 || (snapshotText && snapshotText.trim())) {
      shouldScrollToEndRef.current = true;
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
    setConversationTitle('');
    setMessages([]);
    try {
      if (session) {
        const { id } = await createConversation(session);
        setConversationId(id);
        setConversationTitle('新对话');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建会话失败');
    }
  }, [session, loading]);

  const openHistoryModal = useCallback(async () => {
    if (!session) return;
    setHistoryModalVisible(true);
    setHistoryLoading(true);
    setHistoryList([]);
    setError('');
    try {
      const { conversations } = await listConversations(session);
      setHistoryList(conversations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取历史对话失败');
    } finally {
      setHistoryLoading(false);
    }
  }, [session]);

  /** 将服务端消息列表转为本地 Message[]：过滤 system，合并 assistant+tool 为带 blocks 的 assistant */
  const rawMessagesToLocal = useCallback((raw: ConversationMessage[]): Message[] => {
    const out: Message[] = [];
    let assistantGroup: ConversationMessage[] = [];
    const flushAssistant = () => {
      const one = coalesceAssistantTurn(assistantGroup);
      if (one) out.push(one);
      assistantGroup = [];
    };
    for (const msg of raw ?? []) {
      if (!msg || typeof msg.role !== 'string') continue;
      if (msg.role === 'system') continue;
      if (msg.role === 'user') {
        flushAssistant();
        const content = typeof msg.content === 'string' ? msg.content : '';
        out.push({ role: 'user', content });
        continue;
      }
      if (msg.role === 'assistant' || msg.role === 'tool') {
        assistantGroup.push(msg);
        continue;
      }
    }
    flushAssistant();
    return out;
  }, []);

  const formatHistoryTime = useCallback((isoString: string) => {
    try {
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return isoString;
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return isoString;
    }
  }, []);

  const switchToConversation = useCallback(
    async (id: string) => {
      if (!session) return;
      setHistoryModalVisible(false);
      setError('');
      setLoading(true);
      try {
        const { conversation } = await getConversation(session, id);
        const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
        const local = rawMessagesToLocal(raw);
        setConversationId(id);
        setConversationTitle(conversation?.title?.trim() || '新对话');
        setMessages(local);
        setStreamingText('');
        setCurrentAssistantBlocks([]);
        setStreamStatus('');
      } catch (e) {
        setError(e instanceof Error ? e.message : '打开对话失败');
      } finally {
        setLoading(false);
      }
    },
    [session, rawMessagesToLocal]
  );

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

  const setToolCardMode = useCallback((cardKey: string, mode: 'collapsed' | 'preview' | 'full') => {
    setToolCardViewMode((prev) => ({ ...prev, [cardKey]: mode }));
  }, []);

  function renderToolBlock(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    if (block.tool_name === 'local_cursor_agent') {
      return renderCursorAgentBlock(block, key);
    }
    if (block.tool_name === 'open_tool_packages' || block.tool_name === 'close_tool_packages') {
      return (
        <View key={key} style={styles.toolPackageNavLine}>
          <Text style={styles.toolPackageNavLineText}>
            {getToolPackageNavLabel(block.tool_name, block.arguments)}
          </Text>
        </View>
      );
    }
    const viewMode = toolCardViewMode[key] ?? 'collapsed';
    const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
    const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;

    if (viewMode === 'collapsed') {
      return (
        <Pressable
          key={key}
          style={({ pressed }) => [styles.toolCard, styles.toolCardCollapsed, pressed && styles.toolCardCollapsedPressed]}
          onPress={() => setToolCardMode(key, 'preview')}
          accessibilityLabel="点击展开"
        >
          <Text style={styles.toolCardCollapsedName} numberOfLines={1}>
            {block.tool_name}
          </Text>
          <Text
            style={[
              styles.toolCardBadge,
              block.status === 'completed' ? styles.toolCardBadgeOk : undefined,
            ]}
          >
            {block.status === 'completed' ? '成功' : block.status}
          </Text>
        </Pressable>
      );
    }

    const isFull = viewMode === 'full';
    const resultText =
      block.result != null
        ? typeof block.result === 'string'
          ? block.result
          : JSON.stringify(block.result, null, 2)
        : '';

    return (
      <View key={key} style={styles.toolCard}>
        <Pressable
          onPress={() => {
            if (!isFull) setToolCardMode(key, 'collapsed');
          }}
          style={({ pressed }) => (pressed && !isFull ? styles.toolCardContentPressed : undefined)}
          accessibilityLabel={isFull ? undefined : '点击收起'}
        >
          <Text style={styles.toolCardHeader}>
            {block.tool_name} · {block.status}
          </Text>
          {block.arguments ? (
            <Text style={styles.toolCardBody} numberOfLines={10}>
              args: {String(block.arguments)}
            </Text>
          ) : null}
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
          {block.streaming_content ? (
            <Text style={styles.toolCardBody} numberOfLines={15}>
              {block.streaming_content}
            </Text>
          ) : null}
          {block.result != null ? (
            <Text
              style={styles.toolCardBody}
              numberOfLines={isFull ? undefined : 3}
            >
              result: {resultText}
            </Text>
          ) : null}
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.toolCardExpandRow,
            pressed && styles.toolCardExpandRowPressed,
          ]}
          onPress={() => setToolCardMode(key, isFull ? 'preview' : 'full')}
          accessibilityLabel={isFull ? '收起' : '完全展开'}
        >
          <Ionicons
            name={isFull ? 'chevron-up' : 'chevron-down'}
            size={16}
            color="#64748b"
          />
        </Pressable>
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
    const afterUserIndex =
      !isUser && msg.role === 'assistant'
        ? messages.slice(0, idx).filter((m) => m.role === 'user').length - 1
        : -1;
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
            msg.blocks.map((block, bi) => {
              const prevBlock = msg.blocks[bi - 1];
              const compactAbove = prevBlock != null && isToolPackageNavBlock(prevBlock);
              return block.type === 'text' ? (
                <View
                  key={bi}
                  style={[styles.assistantTextBlock, compactAbove && styles.assistantTextBlockCompactAbove]}
                >
                  <MarkdownContent
                    text={block.content}
                    showCopyButton={isLastAssistant && bi === lastTextBlockIdx}
                    showRegenerateButton={bi === lastTextBlockIdx}
                    onRegenerate={afterUserIndex >= 0 ? () => handleRegenerate(afterUserIndex) : undefined}
                    regenerateDisabled={!conversationId || loading}
                  />
                </View>
              ) : (
                renderToolBlock(block, `msg-tool-${idx}-${bi}`)
              );
            })
          ) : (
            isUser ? (
              <Text style={styles.userText} selectable>{msg.content}</Text>
            ) : (
              <MarkdownContent
                text={msg.content}
                showCopyButton={isLastAssistant}
                showRegenerateButton
                onRegenerate={afterUserIndex >= 0 ? () => handleRegenerate(afterUserIndex) : undefined}
                regenerateDisabled={!conversationId || loading}
              />
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
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
            {conversationId ? (conversationTitle || '新对话') : 'Flops'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={openHistoryModal}
            disabled={loading}
          >
            <Text style={styles.headerBtnText}>历史</Text>
          </TouchableOpacity>
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

      <Modal
        visible={historyModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setHistoryModalVisible(false)}
      >
        <View style={styles.historyModalOverlay}>
          <View style={styles.historyModalContent}>
            <View style={styles.historyModalHead}>
              <Text style={styles.historyModalTitle}>历史对话</Text>
              <TouchableOpacity
                style={styles.historyModalClose}
                onPress={() => setHistoryModalVisible(false)}
                accessibilityLabel="关闭"
              >
                <Text style={styles.historyModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>
            {historyLoading ? (
              <View style={styles.historyModalLoading}>
                <ActivityIndicator size="large" color="#0f172a" />
              </View>
            ) : historyList.length === 0 ? (
              <View style={styles.historyModalEmpty}>
                <Text style={styles.historyModalEmptyText}>暂无历史对话</Text>
              </View>
            ) : (
              <ScrollView style={styles.historyModalList} keyboardShouldPersistTaps="handled">
                {historyList.map((conv) => (
                  <TouchableOpacity
                    key={conv.id}
                    style={[
                      styles.historyModalItem,
                      conv.id === conversationId && styles.historyModalItemActive,
                    ]}
                    onPress={() => switchToConversation(conv.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.historyModalItemTitle} numberOfLines={1}>
                      {conv.title && conv.title.trim() ? conv.title.trim() : '新对话'}
                    </Text>
                    {conv.updated_at ? (
                      <Text style={styles.historyModalItemMeta} numberOfLines={1}>
                        {formatHistoryTime(conv.updated_at)}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
      {error ? <Text style={styles.globalError}>{error}</Text> : null}

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        onContentSizeChange={() => {
          if (shouldScrollToEndRef.current) {
            shouldScrollToEndRef.current = false;
            scrollRef.current?.scrollToEnd({ animated: true });
          }
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.chatContentWrap}>
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
                currentAssistantBlocks.map((block, bi) => {
                  const prevBlock = currentAssistantBlocks[bi - 1];
                  const compactAbove = prevBlock != null && isToolPackageNavBlock(prevBlock);
                  return block.type === 'text' ? (
                    <View
                      key={bi}
                      style={[styles.assistantTextBlock, compactAbove && styles.assistantTextBlockCompactAbove]}
                    >
                      <MarkdownContent text={block.content} />
                    </View>
                  ) : (
                    renderToolBlock(block, `stream-tool-${bi}`)
                  );
                })
              ) : null}
              {currentAssistantBlocks.length === 0 ? (
                <View style={styles.assistantTextBlock}>
                  <MarkdownContent text={streamingText || streamStatusLabel} />
                </View>
              ) : null}
            </View>
          </View>
        ) : null}
        </View>
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 12,
  },
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  headerActions: { flexDirection: 'row', gap: 12, flexShrink: 0 },
  headerBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  headerBtnText: { fontSize: 14, color: '#374151' },
  globalError: { color: '#dc2626', fontSize: 13, paddingHorizontal: 28, paddingVertical: 8 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 28,
    paddingVertical: 20,
    paddingBottom: 32,
    alignItems: 'center',
  },
  chatContentWrap: {
    width: '100%',
    maxWidth: 380,
  },
  emptyStage: { flex: 1, paddingVertical: 40 },
  welcomeTitle: { fontSize: 22, fontWeight: '700', color: '#0f172a', marginBottom: 8 },
  welcomeSubtitle: { fontSize: 15, color: '#6b7280' },
  bubbleWrap: { marginBottom: 18 },
  userBubbleWrap: { alignItems: 'flex-end' },
  assistantBubbleWrap: { width: '100%' },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  userBubble: { backgroundColor: '#000000' },
  assistantBubble: {
    width: '100%',
    maxWidth: '100%',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  bubbleRole: { fontSize: 12, color: '#6b7280', marginBottom: 6 },
  userText: { fontSize: 16, color: '#fff' },
  assistantText: { fontSize: 16, color: '#111827', lineHeight: 24 },
  streamStatus: { fontSize: 14, color: '#6b7280', fontStyle: 'italic' },
  errorWrap: { marginBottom: 18, padding: 14, backgroundColor: '#fef2f2', borderRadius: 8 },
  errorText: { color: '#dc2626', fontSize: 14 },
  assistantTextBlock: { marginTop: 10 },
  assistantTextBlockCompactAbove: { marginTop: 8 },
  toolPackageNavLine: {
    marginTop: -4,
    paddingVertical: 2,
  },
  toolPackageNavLineText: {
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 18,
  },
  toolCard: {
    marginTop: 4,
    marginBottom: 4,
    marginLeft: 0,
    marginRight: 0,
    padding: 14,
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e5e5',
  },
  toolCardCollapsed: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
  },
  toolCardCollapsedPressed: { backgroundColor: '#e5e5e5' },
  toolCardCollapsedName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1f2937',
    flex: 1,
    marginRight: 8,
  },
  toolCardBadge: {
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d4d4d4',
    color: '#525252',
    backgroundColor: '#e5e5e5',
  },
  toolCardBadgeOk: {
    color: '#374151',
    backgroundColor: '#e5e5e5',
    borderColor: '#d4d4d4',
  },
  toolCardContentPressed: { opacity: 0.95 },
  toolCardExpandRow: {
    marginTop: 8,
    marginHorizontal: -10,
    marginBottom: -10,
    paddingVertical: 2,
    paddingHorizontal: 10,
    paddingBottom: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolCardExpandRowPressed: { backgroundColor: '#e5e5e5' },
  toolCardHeader: { fontSize: 13, fontWeight: '600', color: '#1f2937', marginBottom: 8 },
  toolCardBody: { fontSize: 13, color: '#1e293b', marginTop: 6, lineHeight: 20 },
  toolCardSafetyMeta: { fontSize: 11, color: '#64748b', marginTop: 6 },
  toolCardSafetyReason: { fontSize: 12, color: '#334155', marginTop: 6 },
  toolCardSafetyAdvice: {
    fontSize: 12,
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e5e5',
    backgroundColor: '#f8f8f8',
  },
  toolCardSafetyAdviceDanger: {
    color: '#991b1b',
    backgroundColor: '#fff1f2',
    borderColor: '#fecdd3',
  },
  safetyActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  safetyBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#e5e7eb' },
  safetyBtnPrimary: { backgroundColor: '#000000' },
  safetyBtnText: { color: '#374151', fontSize: 14 },
  safetyBtnPrimaryText: { color: '#fff', fontSize: 14 },
  cursorAgentWrap: { marginTop: 8, gap: 14 },
  cursorAgentPromptCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
  },
  cursorAgentPromptLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  cursorAgentPromptText: { fontSize: 14, lineHeight: 22, color: '#111827' },
  cursorAgentPromptMeta: { fontSize: 12, color: '#6b7280', marginTop: 10 },
  cursorAgentReply: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e5e5',
    backgroundColor: '#fff',
  },
  cursorAgentReplyLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#525252',
    marginBottom: 10,
    letterSpacing: 0.4,
  },
  cursorAgentReplyBody: { marginTop: 4 },
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
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    gap: 10,
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111827',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnStop: { backgroundColor: '#dc2626' },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnText: { color: '#fff', fontSize: 18 },
  historyModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  historyModalContent: {
    backgroundColor: '#fff',
    borderRadius: 16,
    maxHeight: '80%',
    overflow: 'hidden',
  },
  historyModalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  historyModalTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  historyModalClose: { padding: 4 },
  historyModalCloseText: { fontSize: 24, color: '#6b7280' },
  historyModalLoading: { padding: 40, alignItems: 'center' },
  historyModalEmpty: { padding: 40, alignItems: 'center' },
  historyModalEmptyText: { fontSize: 15, color: '#6b7280' },
  historyModalList: { maxHeight: 400 },
  historyModalItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  historyModalItemActive: { backgroundColor: '#f0f0f0' },
  historyModalItemTitle: { fontSize: 15, fontWeight: '600', color: '#111827' },
  historyModalItemMeta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
});
