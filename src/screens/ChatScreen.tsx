import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  PanResponder,
  Linking,
  ActivityIndicator,
  Image,
  Animated,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSession } from '../context/SessionContext';
import type { RootStackParamList } from '../navigation/types';
import {
  createConversation,
  streamChat,
  cancelConversation,
  submitSafetyDecision,
  getConversation,
  type ChatStreamEvent,
  type ConversationMessage,
} from '../api';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { MarkdownContent } from '../components/MarkdownContent';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { shadowCircleButton, shadowFab, shadowSoft } from '../theme/shadows';
import { mergeToolResultChunk } from '../utils/toolResultPatch';
import { ansiToSegments, stripAnsi } from '../utils/ansiToSegments';
import {
  parseExecCommandArgs,
  parseFileToolArgs,
  parseReadPagesBlockArgs,
  readPagesResultEntryCount,
  readPagesFinishedCount,
  readPagesSuccessStats,
  readPagesReadingEntries,
  decodeUrlPctForDisplay,
  getReadPagesListSortBucket,
  tryParsePartialReadingStream,
} from '../utils/toolCardParsers';
import { parseSearchEngineBlockArgs } from '../utils/searchEngineParseArgs';
import { ReadPagesDetailSheet } from '../components/ReadPagesDetailSheet';

type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; blocks?: StreamBlock[] }
  | { role: 'error'; content: string };

type ToolResult = { stdout?: string; stderr?: string; error?: string; success?: boolean; exit_code?: number };

type StreamBlock =
  | { type: 'text'; content: string }
  | {
      type: 'tool';
      index?: number;
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

const SEARCH_HEADER_QUERIES_MAX = 5;
const SEARCH_COLLAPSED_QUERIES_MAX_LEN = 120;

function formatSearchHeaderQueries(queries: string[]): string {
  const n = queries.length;
  if (n === 0) return 'Searching 0 queries';
  if (n <= SEARCH_HEADER_QUERIES_MAX) {
    return `Searching ${n} ${n === 1 ? 'query' : 'queries'}: ${queries.join(', ')}`;
  }
  const head = queries.slice(0, SEARCH_HEADER_QUERIES_MAX).join(', ');
  return `Searching ${n} queries: ${head}, …`;
}

function formatSearchCollapsedTail(queries: string[]): string {
  if (!queries.length) return '0 queries';
  const joined = queries.join(', ');
  if (joined.length <= SEARCH_COLLAPSED_QUERIES_MAX_LEN) {
    return `${queries.length} queries: ${joined}`;
  }
  return `${queries.length} queries: ${joined.slice(0, SEARCH_COLLAPSED_QUERIES_MAX_LEN - 1)}…`;
}

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

type ChatRouteParams = RootStackParamList['Chat'];

/** Header 底部的 loading 条（与 Web flops-read-pages-card-header-loadbar 一致） */
function ReadPagesHeaderLoadBar() {
  const translateX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, { toValue: 1, duration: 1150, useNativeDriver: true }),
        Animated.timing(translateX, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [translateX]);
  const slide = translateX.interpolate({ inputRange: [0, 1], outputRange: [-60, 160] });
  return (
    <View style={styles.readPagesHeaderLoadBarTrack}>
      <Animated.View style={[styles.readPagesHeaderLoadBarBar, { transform: [{ translateX: slide }] }]} />
    </View>
  );
}

export function ChatScreen() {
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Chat'>>();
  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  /** 底部渐变条高度（叠在滚动内容上，透明→白） */
  const gradientStripHeight = 48;
  /** 输入行高度（输入框+发送按钮） */
  const inputRowHeight = 92;
  /** 底部整块高度：渐变 + 输入行，贴屏幕底，渐变延伸到底无单独白底 */
  const bottomOverlayHeight = gradientStripHeight + inputRowHeight;
  /** 列表底部留白，让内容可滚入渐变下方 */
  const scrollBottomPadding = bottomOverlayHeight + 12;
  const params = (route.params ?? undefined) as ChatRouteParams | undefined;
  const [conversationId, setConversationId] = useState(params?.conversationId ?? '');
  const [conversationTitle, setConversationTitle] = useState(params?.conversationTitle ?? '');
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
  /** search_engine：已展开的 query 文案（与 Web expandedQueries Set 一致） */
  const [searchEngineExpandedByCard, setSearchEngineExpandedByCard] = useState<Record<string, string[]>>({});
  /** local_exec_command 执行中时每秒 +1，用于刷新耗时显示 */
  const [runningExecTick, setRunningExecTick] = useState(0);
  /** read_pages 点击某条条目后打开的详情 Sheet（与 Task 页筛选同款 BottomSheetModal） */
  const [readPagesModalEntry, setReadPagesModalEntry] = useState<{
    cardKey: string;
    entryKey: string;
    entry: Record<string, unknown>;
  } | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  /** 流式文件卡片(半折叠)内部 ScrollView 引用，保持视图跟随最后几行 */
  const fileToolPreviewScrollRefs = useRef<Record<string, ScrollView | null>>({});
  /** key -> { startMs, completedSec }，用于 exec 卡片耗时与自动折叠 */
  const execCardTimeRef = useRef<Record<string, { startMs: number; completedSec?: number }>>({});
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

    const findLastToolBlockByIndex = (index: number): number => {
      for (let i = localBlocks.length - 1; i >= 0; i--) {
        if (localBlocks[i].type === 'tool' && localBlocks[i].index === index) return i;
      }
      return -1;
    };

    const onEvent = (event: ChatStreamEvent) => {
      if ('conversation_id' in event && event.conversation_id && !convId) {
        setConversationId(event.conversation_id);
        convId = event.conversation_id;
      }
      if ('type' in event && event.type === 'conversation_title' && typeof (event as { title?: string }).title === 'string') {
        setConversationTitle((event as { title: string }).title);
      }
      if ('error' in event && event.error) throw new Error(event.error);
      if ('type' in event) {
        if (event.type === 'thinking') setStreamStatus('thinking');
        if (event.type === 'checking_tools') setStreamStatus('checking_tools');
        if (event.type === 'tool_call_start') {
          const idx = event.index ?? 0;
          const name = String(event.name || '');
          const i = findLastToolBlockByIndex(idx);
          const existingCompleted = i >= 0 && localBlocks[i].type === 'tool' && localBlocks[i].status === 'completed';
          if (i >= 0 && !existingCompleted) {
            localBlocks[i] = { ...localBlocks[i], type: 'tool', index: idx, tool_name: name, status: 'pending', arguments: '', streaming_content: '' } as StreamBlock;
          } else {
            localBlocks.push({ type: 'tool', index: idx, tool_name: name, status: 'pending', arguments: '', streaming_content: '' });
          }
          syncBlocks();
        }
        if (event.type === 'tool_call_delta') {
          const idx = event.index ?? 0;
          const delta = event.arguments_delta ?? '';
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], arguments: (localBlocks[i].arguments || '') + delta };
            syncBlocks();
          }
        }
        if (event.type === 'tool_call_ready') {
          const idx = event.index ?? 0;
          const name = String(event.name || '');
          const args = event.arguments ?? '{}';
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], tool_name: name, arguments: args, status: 'waiting' };
          } else {
            localBlocks.push({ type: 'tool', index: idx, tool_name: name, status: 'waiting', arguments: args, streaming_content: '' });
          }
          syncBlocks();
        }
        if (event.type === 'tool_call_executing') {
          const idx = event.index ?? 0;
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], status: 'running' };
            setStreamStatus('tool_running');
            syncBlocks();
          }
        }
        if (event.type === 'tool_call_done') {
          const idx = event.index ?? 0;
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], status: 'completed' };
            setStreamStatus('tool_result');
            syncBlocks();
          }
        }
        if (event.type === 'tool_start') {
          setStreamStatus('tool_running');
          const name = String(event.tool_name || 'unknown');
          const idx = (event as { index?: number }).index;
          if (typeof idx === 'number') {
            const i = findLastToolBlockByIndex(idx);
            const existingCompleted = i >= 0 && localBlocks[i].type === 'tool' && localBlocks[i].status === 'completed';
            if (i >= 0 && !existingCompleted && localBlocks[i].type === 'tool') {
              localBlocks[i] = { ...localBlocks[i], tool_name: name, arguments: event.arguments, status: 'running', streaming_content: '' };
            } else {
              localBlocks.push({ type: 'tool', index: idx, tool_name: name, status: 'running', arguments: event.arguments, streaming_content: '' });
            }
          } else {
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
              localBlocks.push({ type: 'tool', tool_name: name, status: 'running', arguments: event.arguments, streaming_content: '' });
            }
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
        if (event.type === 'tool_result_chunk') {
          const idx = event.index ?? 0;
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            const result = mergeToolResultChunk(localBlocks[i].result, {
              patches: event.patches,
              stdout_append: event.stdout_append,
              set: event.set,
              readings_by_url: event.readings_by_url,
            });
            localBlocks[i] = { ...localBlocks[i], result };
            syncBlocks();
          }
        }
        if (event.type === 'tool_result') {
          setStreamStatus('tool_result');
          const name = event.tool_name;
          const idx = (event as { index?: number }).index;
          if (typeof idx === 'number') {
            const i = findLastToolBlockByIndex(idx);
            if (i >= 0 && localBlocks[i].type === 'tool') {
              localBlocks[i] = { ...localBlocks[i], status: 'completed', result: event.result };
            }
          } else {
            for (let i = localBlocks.length - 1; i >= 0; i--) {
              const b = localBlocks[i];
              if (b.type === 'tool' && b.tool_name === name) {
                localBlocks[i] = { ...b, status: 'completed', result: event.result };
                break;
              }
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

    const findLastToolBlockByIndex = (index: number): number => {
      for (let i = localBlocks.length - 1; i >= 0; i--) {
        if (localBlocks[i].type === 'tool' && localBlocks[i].index === index) return i;
      }
      return -1;
    };

    const onEvent = (event: ChatStreamEvent) => {
      if ('error' in event && event.error) throw new Error(event.error);
      if ('type' in event) {
        if (event.type === 'thinking') setStreamStatus('thinking');
        if (event.type === 'checking_tools') setStreamStatus('checking_tools');
        if (event.type === 'tool_call_start') {
          const idx = event.index ?? 0;
          const name = String(event.name || '');
          const i = findLastToolBlockByIndex(idx);
          const existingCompleted = i >= 0 && localBlocks[i].type === 'tool' && localBlocks[i].status === 'completed';
          if (i >= 0 && !existingCompleted) {
            localBlocks[i] = { ...localBlocks[i], type: 'tool', index: idx, tool_name: name, status: 'pending', arguments: '', streaming_content: '' } as StreamBlock;
          } else {
            localBlocks.push({ type: 'tool', index: idx, tool_name: name, status: 'pending', arguments: '', streaming_content: '' });
          }
          syncBlocks();
        }
        if (event.type === 'tool_call_delta') {
          const idx = event.index ?? 0;
          const delta = event.arguments_delta ?? '';
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], arguments: (localBlocks[i].arguments || '') + delta };
            syncBlocks();
          }
        }
        if (event.type === 'tool_call_ready') {
          const idx = event.index ?? 0;
          const name = String(event.name || '');
          const args = event.arguments ?? '{}';
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], tool_name: name, arguments: args, status: 'waiting' };
          } else {
            localBlocks.push({ type: 'tool', index: idx, tool_name: name, status: 'waiting', arguments: args, streaming_content: '' });
          }
          syncBlocks();
        }
        if (event.type === 'tool_call_executing') {
          const idx = event.index ?? 0;
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], status: 'running' };
            setStreamStatus('tool_running');
            syncBlocks();
          }
        }
        if (event.type === 'tool_call_done') {
          const idx = event.index ?? 0;
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            localBlocks[i] = { ...localBlocks[i], status: 'completed' };
            setStreamStatus('tool_result');
            syncBlocks();
          }
        }
        if (event.type === 'tool_start') {
          setStreamStatus('tool_running');
          const name = String(event.tool_name || 'unknown');
          const idx = (event as { index?: number }).index;
          if (typeof idx === 'number') {
            const i = findLastToolBlockByIndex(idx);
            const existingCompleted = i >= 0 && localBlocks[i].type === 'tool' && localBlocks[i].status === 'completed';
            if (i >= 0 && !existingCompleted && localBlocks[i].type === 'tool') {
              localBlocks[i] = { ...localBlocks[i], tool_name: name, arguments: event.arguments, status: 'running', streaming_content: '' };
            } else {
              localBlocks.push({ type: 'tool', index: idx, tool_name: name, status: 'running', arguments: event.arguments, streaming_content: '' });
            }
          } else {
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
              localBlocks.push({ type: 'tool', tool_name: name, status: 'running', arguments: event.arguments, streaming_content: '' });
            }
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
        if (event.type === 'tool_result_chunk') {
          const idx = event.index ?? 0;
          const i = findLastToolBlockByIndex(idx);
          if (i >= 0 && localBlocks[i].type === 'tool') {
            const result = mergeToolResultChunk(localBlocks[i].result, {
              patches: event.patches,
              stdout_append: event.stdout_append,
              set: event.set,
              readings_by_url: event.readings_by_url,
            });
            localBlocks[i] = { ...localBlocks[i], result };
            syncBlocks();
          }
        }
        if (event.type === 'tool_result') {
          setStreamStatus('tool_result');
          const name = event.tool_name;
          const idx = (event as { index?: number }).index;
          if (typeof idx === 'number') {
            const i = findLastToolBlockByIndex(idx);
            if (i >= 0 && localBlocks[i].type === 'tool') {
              localBlocks[i] = { ...localBlocks[i], status: 'completed', result: event.result };
            }
          } else {
            for (let i = localBlocks.length - 1; i >= 0; i--) {
              const b = localBlocks[i];
              if (b.type === 'tool' && b.tool_name === name) {
                localBlocks[i] = { ...b, status: 'completed', result: event.result };
                break;
              }
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

  // local_exec_command：运行中自动半展开(preview)、成功结束自动折叠；记录开始/结束时间供耗时显示
  useEffect(() => {
    const now = Date.now();
    const ref = execCardTimeRef.current;
    const keysToPreview: string[] = [];
    const keysToCollapse: string[] = [];

    messages.forEach((msg, idx) => {
      const blocks = (msg as AssistantMessage).blocks;
      if (!blocks?.length) return;
      blocks.forEach((block, bi) => {
        if (block.type !== 'tool' || (block as ToolBlock).tool_name !== 'local_exec_command') return;
        const key = `msg-tool-${idx}-${bi}`;
        const status = (block as ToolBlock).status;
        const result = (block as ToolBlock).result as ToolResult | undefined;
        const exitCode = result?.exit_code ?? undefined;

        if (status === 'running' || status === 'pending') {
          if (!ref[key]) ref[key] = { startMs: now };
          keysToPreview.push(key);
        } else if (status === 'completed') {
          if (ref[key] && ref[key].completedSec === undefined)
            ref[key] = { ...ref[key], completedSec: Math.floor((now - ref[key].startMs) / 1000) };
          if (exitCode === 0) keysToCollapse.push(key);
        }
      });
    });
    (currentAssistantBlocks || []).forEach((block, bi) => {
      if (block.type !== 'tool' || (block as ToolBlock).tool_name !== 'local_exec_command') return;
      const key = `stream-tool-${bi}`;
      const status = (block as ToolBlock).status;
      const result = (block as ToolBlock).result as ToolResult | undefined;
      const exitCode = result?.exit_code ?? undefined;

      if (status === 'running' || status === 'pending') {
        if (!ref[key]) ref[key] = { startMs: now };
        keysToPreview.push(key);
      } else if (status === 'completed') {
        if (ref[key] && ref[key].completedSec === undefined)
          ref[key] = { ...ref[key], completedSec: Math.floor((now - ref[key].startMs) / 1000) };
        if (exitCode === 0) keysToCollapse.push(key);
      }
    });

    setToolCardViewMode((prev) => {
      let next: Record<string, 'collapsed' | 'preview' | 'full'> | null = null;
      const setMode = (k: string, mode: 'collapsed' | 'preview') => {
        const cur = prev[k];
        if (cur === mode) return;
        if (!next) next = { ...prev };
        next[k] = mode;
      };
      keysToPreview.forEach((k) => setMode(k, 'preview'));
      keysToCollapse.forEach((k) => setMode(k, 'collapsed'));
      return next ?? prev;
    });
  }, [messages, currentAssistantBlocks]);

  // 与 Web 保持一致：流式文件工具（write/edit）在半折叠时总是滚到末尾，展示最新几行
  useEffect(() => {
    (currentAssistantBlocks || []).forEach((block, bi) => {
      if (block.type !== 'tool') return;
      if (block.tool_name !== 'local_write_file' && block.tool_name !== 'local_edit_file') return;
      if (block.status !== 'pending' && block.status !== 'running') return;
      const key = `stream-tool-${bi}`;
      const mode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
      if (mode !== 'preview') return;
      fileToolPreviewScrollRefs.current[key]?.scrollToEnd({ animated: false });
    });
  }, [currentAssistantBlocks, toolCardViewMode]);

  // 有执行中的 exec 卡片时每秒刷新一次，用于显示“执行中（0:05）”
  const hasRunningExec = (() => {
    const check = (blocks: MessageBlock[] | undefined) =>
      (blocks || []).some(
        (b) => b.type === 'tool' && (b as ToolBlock).tool_name === 'local_exec_command' && ((b as ToolBlock).status === 'running' || (b as ToolBlock).status === 'pending')
      );
    if (messages.some((m) => check((m as AssistantMessage).blocks))) return true;
    return check(currentAssistantBlocks);
  })();
  useEffect(() => {
    if (!hasRunningExec) return;
    const id = setInterval(() => setRunningExecTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunningExec]);

  // 从历史对话列表进入时，根据路由参数加载对话
  useEffect(() => {
    const id = params?.conversationId;
    if (!id || !session) return;
    let cancelled = false;
    setLoading(true);
    getConversation(session, id)
      .then(({ conversation }) => {
        if (cancelled) return;
        const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
        setMessages(rawMessagesToLocal(raw));
        setConversationId(id);
        setConversationTitle(conversation?.title?.trim() || '新对话');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '打开对话失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [params?.conversationId, session, rawMessagesToLocal]);

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

  const toggleSearchEngineQuery = useCallback((cardKey: string, q: string) => {
    setSearchEngineExpandedByCard((prev) => {
      const cur = prev[cardKey] ?? [];
      const has = cur.includes(q);
      const nextList = has ? cur.filter((x) => x !== q) : [...cur, q];
      return { ...prev, [cardKey]: nextList };
    });
  }, []);

  /** 与 Web/Desktop 一致：read_pages、文件卡片、exec 默认半展开；search_engine 等默认折叠 */
  function getDefaultToolCardViewMode(toolName: string): 'collapsed' | 'preview' {
    if (
      toolName === 'read_pages' ||
      toolName === 'local_write_file' ||
      toolName === 'local_edit_file' ||
      toolName === 'local_exec_command'
    )
      return 'preview';
    /* search_engine 等与 Desktop getDefaultToolCardViewMode 一致，默认 collapsed */
    return 'collapsed';
  }

  /**
   * 与 Web `.tool-card-write-preview` / `.tool-card-diff` 一致：半折叠(preview)时 max-height 120px；
   * 流式(pending/running)时内部可滚动；非流式时底部渐变 + 「…」。
   */
  function wrapFileToolPreviewBody(
    isFull: boolean,
    isStreaming: boolean,
    cardKey: string,
    children: React.ReactNode
  ): React.ReactNode {
    if (isFull) {
      return <View style={styles.fileToolPreviewFullWrap}>{children}</View>;
    }
    if (isStreaming) {
      return (
        <ScrollView
          style={styles.fileToolPreviewScroll}
          contentContainerStyle={styles.fileToolPreviewScrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
          ref={(el) => {
            fileToolPreviewScrollRefs.current[cardKey] = el;
          }}
          onContentSizeChange={() => {
            fileToolPreviewScrollRefs.current[cardKey]?.scrollToEnd({ animated: false });
          }}
          onLayout={() => {
            fileToolPreviewScrollRefs.current[cardKey]?.scrollToEnd({ animated: false });
          }}
        >
          {children}
        </ScrollView>
      );
    }
    return (
      <View style={styles.fileToolPreviewClip}>
        {children}
        <LinearGradient
          colors={['rgba(245,245,245,0)', '#f5f5f5']}
          style={styles.fileToolPreviewFade}
          pointerEvents="none"
        />
        <Text style={styles.fileToolPreviewEllipsis} pointerEvents="none">
          …
        </Text>
      </View>
    );
  }

  function getToolStatusLabel(status: string): string {
    return status === 'completed'
      ? '成功'
      : status === 'pending'
        ? '参数生成中'
        : status === 'waiting'
          ? '等待执行'
          : status === 'running'
            ? '执行中'
            : status;
  }

  function formatSec(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function renderCollapsedToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
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
          {getToolStatusLabel(block.status)}
        </Text>
      </Pressable>
    );
  }

  function renderAnsiText(text: string, maxLen: number) {
    const raw = String(text ?? '');
    const sliced = raw.length > maxLen ? raw.slice(raw.length - maxLen) : raw;
    const segments = ansiToSegments(sliced);
    return (
      <Text selectable style={styles.toolCardCodeText}>
        {segments.map((seg, i) => (
          <Text key={i} style={seg.style}>
            {seg.text}
          </Text>
        ))}
      </Text>
    );
  }

  function readPagesPageCount(block: Extract<StreamBlock, { type: 'tool' }>, parsed: { urls: string[] }): number {
    const fromResult = readPagesResultEntryCount(block.result);
    const fromArgs = parsed.urls.length;
    return Math.max(fromArgs, fromResult) || fromArgs || fromResult || 0;
  }

  function readPagesTitleLine(block: Extract<StreamBlock, { type: 'tool' }>, parsed: { goal: string; urls: string[] }): string {
    const isPreparingArgs = block.status === 'pending';
    if (isPreparingArgs) {
      const q = parsed.goal.trim() || '…';
      return q !== '…'
        ? `Reading preparing: ${q}`
        : parsed.urls.length > 0
          ? `Reading preparing…（${parsed.urls.length} 个链接见下方）`
          : 'Reading preparing…';
    }
    const n = readPagesPageCount(block, parsed);
    const goal = parsed.goal.trim() || '—';
    const isCompleted = block.status === 'completed';
    if (isCompleted) {
      let { total, success } = readPagesSuccessStats(block.result);
      if (total === 0 && parsed.urls.length > 0) {
        total = parsed.urls.length;
        success = 0;
      }
      if (total > 0) {
        const pageWord = total === 1 ? 'page' : 'pages';
        const statusPart = success === total ? '(all success)' : `(${success} success)`;
        return `Read ${total} ${pageWord} ${statusPart}: ${goal}`;
      }
    }
    const total = n;
    const done = readPagesFinishedCount(block.result);
    const pageWord = total === 1 ? 'page' : 'pages';
    const prefix = total > 0 ? `Reading ${done}/${total} ${pageWord}:` : `Reading ${n} ${n === 1 ? 'page' : 'pages'}:`;
    return `${prefix} ${goal}`;
  }

  function readPagesCollapsedTail(block: Extract<StreamBlock, { type: 'tool' }>, parsed: { goal: string; urls: string[] }): string {
    const isPreparingArgs = block.status === 'pending';
    if (isPreparingArgs) {
      const g = parsed.goal.trim();
      const t = g ? (g.slice(0, 48) + (g.length > 48 ? '…' : '')) : (parsed.urls.length > 0 ? `${parsed.urls.length} links` : '…');
      return `prep · ${t}`;
    }
    const g = parsed.goal.slice(0, 36);
    if (block.status === 'completed') {
      let { total, success } = readPagesSuccessStats(block.result);
      if (total === 0 && parsed.urls.length > 0) {
        total = parsed.urls.length;
        success = 0;
      }
      if (total > 0) {
        const head = success === total ? `${total}p all` : `${success}/${total}p`;
        return `${head}${g ? ` · ${g}` : ''}${parsed.goal.length > 36 ? '…' : ''}`;
      }
    }
    const n = readPagesPageCount(block, parsed);
    const total = n;
    const done = readPagesFinishedCount(block.result);
    const head = total > 0 ? `${done}/${total}p` : `${n}p`;
    return `${head}${g ? ` · ${g}` : ''}${parsed.goal.length > 36 ? '…' : ''}`;
  }

  function renderReadPagesToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    const parsed = parseReadPagesBlockArgs(block);
    const isPreparingArgs = block.status === 'pending';
    const hasReadings = readPagesResultEntryCount(block.result) > 0;
    const entries = readPagesReadingEntries(block.result).map(([urlKey, r]) => ({ key: urlKey, r }));

    if (viewMode === 'collapsed') {
      const collapsedTail = readPagesCollapsedTail(block, parsed);
      return (
        <Pressable
          key={key}
          style={({ pressed }) => [styles.toolCard, styles.toolCardCollapsed, pressed && styles.toolCardCollapsedPressed]}
          onPress={() => setToolCardMode(key, 'preview')}
          accessibilityLabel="点击展开"
        >
          <Text style={styles.toolCardCollapsedName} numberOfLines={1}>
            Reading
          </Text>
          <Text style={[styles.toolCardCollapsedTail, { flex: 1 }]} numberOfLines={1}>
            {collapsedTail}
          </Text>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={styles.toolCardBadge}>{getToolStatusLabel(block.status)}</Text>
          </View>
        </Pressable>
      );
    }

    const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
    const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;
    const titleLine = readPagesTitleLine(block, parsed);
    /** 与 Web 一致：按 加载中(0) → 成功(1) → 失败(2) 排序；同档内按目标 URL 顺序稳定排列，避免执行结束后因后端返回顺序变化而乱序 */
    const urlOrderOf = (key: string) => {
      const i = parsed.urls.indexOf(key);
      return i >= 0 ? i : 999999;
    };
    const sortedEntries = entries
      .map((e, index) => ({ ...e, index, urlOrder: urlOrderOf(e.key) }))
      .sort((a, b) => {
        const ba = getReadPagesListSortBucket(a.r);
        const bb = getReadPagesListSortBucket(b.r);
        if (ba !== bb) return ba - bb;
        return a.urlOrder !== b.urlOrder ? a.urlOrder - b.urlOrder : a.index - b.index;
      });

    return (
      <View key={key} style={styles.toolCard}>
        <Pressable
          onPress={() => setToolCardMode(key, 'collapsed')}
          style={({ pressed }) => (pressed ? styles.toolCardContentPressed : undefined)}
          accessibilityLabel="点击收起"
        >
          <Text style={styles.toolCardHeader} numberOfLines={1} ellipsizeMode="tail">
            {titleLine}
          </Text>

          {isPreparingArgs ? (
            <View style={styles.readPagesUrlListWrap}>
              {parsed.urls.length === 0 ? (
                <Text style={styles.toolCardSafetyMeta}>（尚未解析到 URL，参数生成完成后将列出）</Text>
              ) : (
                parsed.urls.map((u) => (
                  <Pressable key={u} onPress={() => Linking.openURL(u)} style={styles.readPagesUrlItem}>
                    <Text style={styles.readPagesUrlLink} numberOfLines={1}>{u}</Text>
                    <Ionicons name="open-outline" size={14} color="#64748b" />
                  </Pressable>
                ))
              )}
            </View>
          ) : hasReadings ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.readPagesCardsScroll}
              style={styles.readPagesCardsScrollView}
            >
              {sortedEntries.map(({ key: ek, r }, i) => {
                const title = decodeUrlPctForDisplay(String(r.title || r.url || ek || `页面 ${i + 1}`));
                const loading = r.loading === true;
                const previewOk = typeof r.page_preview_data_url === 'string' && r.page_preview_data_url.startsWith('data:image/');
                const llmStarted = typeof r.llm_raw === 'string' && (r.llm_raw as string).trim().length > 0;
                const phase = typeof r.phase === 'string' ? r.phase : '';
                const showThumb = Boolean(loading && previewOk && !llmStarted);
                // 与 Web 一致：仅 opening 或等首图时显示 loading，有图/有内容后不再回退到 spinner
                const showSpinner =
                  loading &&
                  !showThumb &&
                  (phase === 'opening' || (phase === 'page_preview' && !previewOk));
                const error = typeof r.error === 'string' ? r.error : '';
                const partial = typeof r.llm_raw === 'string' && (r.llm_raw as string).trim() ? tryParsePartialReadingStream(r.llm_raw as string) : null;
                const summary = r.summary && typeof r.summary === 'object' ? (r.summary as Record<string, unknown>) : null;
                const brief = (summary && typeof summary.brief === 'string' ? summary.brief : '') || (partial?.summary?.brief ?? '');
                const takeover = r.takeaway && typeof r.takeaway === 'object' ? (r.takeaway as Record<string, unknown>) : null;
                const answersFin = takeover && Array.isArray(takeover.answers) ? (takeover.answers as string[]).filter((x) => x != null && String(x).trim()).slice(0, 4) : [];
                const quotesFin = takeover && Array.isArray(takeover.quotes) ? (takeover.quotes as string[]).filter((x) => x != null && String(x).trim()).slice(0, 4) : [];
                const answers = answersFin.length ? answersFin : (partial?.takeaway?.answers ?? []).slice(0, 4);
                const quotes = quotesFin.length ? quotesFin : (partial?.takeaway?.quotes ?? []).slice(0, 4);
                const links = Array.isArray(r.links) ? r.links : [];
                const urlStr = typeof r.url === 'string' ? r.url : '';
                const hasPartialLayout = Boolean(brief || answers.length || quotes.length);
                const loadBarThumbWait = Boolean(loading && previewOk && !llmStarted);
                const showCardHeaderLoadBar = hasPartialLayout || loadBarThumbWait;

                return (
                  <Pressable
                    key={ek}
                    style={styles.readPagesSmallCard}
                    onPress={() => setReadPagesModalEntry({ cardKey: key, entryKey: ek, entry: r })}
                  >
                    <View style={[styles.readPagesSmallCardHeader, loading && showCardHeaderLoadBar && styles.readPagesSmallCardHeaderStreaming]}>
                      <Text style={styles.readPagesSmallCardTitle} numberOfLines={1} ellipsizeMode="tail">{title}</Text>
                      {urlStr ? (
                        <Pressable onPress={(e) => { e.stopPropagation(); Linking.openURL(urlStr); }} hitSlop={8}>
                          <Ionicons name="open-outline" size={14} color="#64748b" />
                        </Pressable>
                      ) : null}
                      {loading && showCardHeaderLoadBar ? <ReadPagesHeaderLoadBar /> : null}
                    </View>
                    <View style={styles.readPagesSmallCardBodyWrap}>
                      {showThumb && r.page_preview_data_url ? (
                        <View style={styles.readPagesCardSquare}>
                          <Image source={{ uri: r.page_preview_data_url as string }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                        </View>
                      ) : showSpinner ? (
                        <View style={[styles.readPagesCardSquare, styles.readPagesCardSquareCenter]}>
                          <ActivityIndicator size="small" color="#64748b" />
                        </View>
                      ) : (
                        <ScrollView
                          style={[styles.readPagesCardSquare, styles.readPagesCardSquareBody]}
                          contentContainerStyle={styles.readPagesCardBodyScroll}
                          showsVerticalScrollIndicator={true}
                        >
                          {error ? (
                            <Text style={styles.readPagesErrorText} numberOfLines={5}>{error}</Text>
                          ) : brief || answers.length || quotes.length ? (
                            <>
                              {brief ? <Text style={styles.readPagesTextBlock}>{brief}</Text> : null}
                              {answers.length ? <Text style={styles.readPagesTextBlock}>要点: {answers.join('；')}</Text> : null}
                              {quotes.length ? <Text style={styles.readPagesTextBlock}>引用: {quotes.join('；')}</Text> : null}
                            </>
                          ) : loading ? (
                            <Text style={styles.toolCardSafetyMeta}>模型输出中…</Text>
                          ) : (
                            <Text style={styles.toolCardSafetyMeta}>无正文或结构化摘要。</Text>
                          )}
                        </ScrollView>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : parsed.urls.length > 0 ? (
            <View>
              <View style={styles.readPagesUrlListWrap}>
                {parsed.urls.map((u) => (
                  <Pressable key={u} onPress={() => Linking.openURL(u)} style={styles.readPagesUrlItem}>
                    <Text style={styles.readPagesUrlLink} numberOfLines={1}>{u}</Text>
                    <Ionicons name="open-outline" size={14} color="#64748b" />
                  </Pressable>
                ))}
              </View>
              <Text style={styles.toolCardSafetyMeta}>
                {block.status === 'waiting' ? '等待执行…' : '阅读中，摘要将随后显示…'}
              </Text>
            </View>
          ) : (
            <Text style={styles.toolCardSafetyMeta}>
              {block.result == null ? '暂无结果' : '结果结构未知（请检查 JSON）'}
            </Text>
          )}

          {isAwaiting && block.review_id ? (
            <View style={styles.safetyActions}>
              <TouchableOpacity style={styles.safetyBtn} onPress={() => handleSafetyDecision(block.review_id!, 'reject')} disabled={!!isSubmitting}>
                <Text style={styles.safetyBtnText}>拒绝</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.safetyBtn, styles.safetyBtnPrimary]} onPress={() => handleSafetyDecision(block.review_id!, 'approve')} disabled={!!isSubmitting}>
                <Text style={styles.safetyBtnPrimaryText}>{isSubmitting ? '提交中...' : '确认执行'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </Pressable>
      </View>
    );
  }

  function renderFileWriteToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const fileArgs = parseFileToolArgs(block);
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    const collapsedLabel = fileArgs.pathDisplay || '等待参数…';
    if (viewMode === 'collapsed') {
      return (
        <Pressable
          key={key}
          style={({ pressed }) => [styles.toolCard, styles.toolCardCollapsed, pressed && styles.toolCardCollapsedPressed]}
          onPress={() => setToolCardMode(key, 'preview')}
          accessibilityLabel="点击展开"
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.toolCardCollapsedName} numberOfLines={1} ellipsizeMode="tail">
              {collapsedLabel}
            </Text>
          </View>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
              {getToolStatusLabel(block.status)}
            </Text>
          </View>
        </Pressable>
      );
    }

    const isFull = viewMode === 'full';
    const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
    const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;
    const isStreaming = block.status === 'pending' || block.status === 'running';

    const content = fileArgs.content ?? '';
    const contentDisplay =
      isFull && content.length > 2000
        ? `${content.slice(0, 2000)}\n… (共 ${content.length} 字符)`
        : content.length > 50000
          ? `${content.slice(0, 50000)}\n…`
          : content;

    const hasPath = Boolean(fileArgs.pathDisplay);
    const waitingPathOrArgs =
      !hasPath && (block.arguments || block.status === 'pending' || block.status === 'waiting')
        ? fileArgs.pathDisplay
          ? '参数解析中…'
          : '等待参数…'
        : null;
    const noContentHint =
      hasPath && !content
        ? isStreaming
          ? '内容生成中…'
          : '无内容预览'
        : null;

    return (
      <View key={key} style={styles.toolCard}>
        <Pressable
          onPress={() => {
            if (!isFull) setToolCardMode(key, 'collapsed');
          }}
          style={({ pressed }) => (pressed && !isFull ? styles.toolCardContentPressed : undefined)}
          accessibilityLabel={isFull ? undefined : '点击收起'}
        >
          <View style={styles.toolCardHeaderRow}>
            <View style={styles.toolCardHeaderMain}>
              <Text
                style={fileArgs.pathDisplay ? styles.toolCardHeaderFilename : styles.toolCardHeaderFilenamePlaceholder}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {fileArgs.pathDisplay || '等待路径…'}
              </Text>
            </View>
            <View style={styles.toolCardBadgeWrap}>
              <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
                {getToolStatusLabel(block.status)}
              </Text>
            </View>
          </View>

          {waitingPathOrArgs ? <Text style={styles.toolCardBodyMuted}>{waitingPathOrArgs}</Text> : null}
          {noContentHint ? <Text style={styles.toolCardBodyMuted}>{noContentHint}</Text> : null}
          {hasPath && content
            ? wrapFileToolPreviewBody(
                isFull,
                isStreaming,
                key,
                <View style={styles.toolCardWritePreview}>
                  <Text
                    style={[styles.toolCardBody, styles.toolCardDiffPre, styles.toolCardWritePreviewText]}
                    selectable
                  >
                    {contentDisplay}
                  </Text>
                </View>
              )
            : null}

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

  function renderFileEditToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const fileArgs = parseFileToolArgs(block);
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    const collapsedLabel = fileArgs.pathDisplay || '等待参数…';
    if (viewMode === 'collapsed') {
      return (
        <Pressable
          key={key}
          style={({ pressed }) => [styles.toolCard, styles.toolCardCollapsed, pressed && styles.toolCardCollapsedPressed]}
          onPress={() => setToolCardMode(key, 'preview')}
          accessibilityLabel="点击展开"
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.toolCardCollapsedName} numberOfLines={1} ellipsizeMode="tail">
              {collapsedLabel}
            </Text>
          </View>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
              {getToolStatusLabel(block.status)}
            </Text>
          </View>
        </Pressable>
      );
    }

    const isFull = viewMode === 'full';
    const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
    const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;
    const isStreaming = block.status === 'pending' || block.status === 'running';

    const oldStr = fileArgs.oldString || '';
    const newStr = fileArgs.newString || '';
    const hasOldNew = Boolean(oldStr || newStr);
    const capPreview = (s: string) => (s.length > 50000 ? `${s.slice(0, 50000)}\n…` : s);
    const oldTrim = isFull
      ? oldStr.length > 8000
        ? `${oldStr.slice(0, 8000)}\n…`
        : oldStr
      : capPreview(oldStr);
    const newTrim = isFull
      ? newStr.length > 8000
        ? `${newStr.slice(0, 8000)}\n…`
        : newStr
      : capPreview(newStr);

    const editSummary =
      hasOldNew && oldStr
        ? oldStr.includes('\n')
          ? `${oldStr.split('\n')[0].slice(0, 40)}…`
          : oldStr.length > 40
            ? `${oldStr.slice(0, 40)}…`
            : oldStr
        : hasOldNew
          ? '(空)'
          : null;

    return (
      <View key={key} style={styles.toolCard}>
        <Pressable
          onPress={() => {
            if (!isFull) setToolCardMode(key, 'collapsed');
          }}
          style={({ pressed }) => (pressed && !isFull ? styles.toolCardContentPressed : undefined)}
          accessibilityLabel={isFull ? undefined : '点击收起'}
        >
          <View style={styles.toolCardHeaderRow}>
            <View style={styles.toolCardHeaderMain}>
              <Text
                style={fileArgs.pathDisplay ? styles.toolCardHeaderFilename : styles.toolCardHeaderFilenamePlaceholder}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {fileArgs.pathDisplay || '等待路径…'}
              </Text>
              {editSummary !== null ? (
                <Text style={styles.toolCardHeaderEditSummary} numberOfLines={1} ellipsizeMode="tail">
                  被替换: {editSummary}
                </Text>
              ) : null}
            </View>
            <View style={styles.toolCardBadgeWrap}>
              <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
                {getToolStatusLabel(block.status)}
              </Text>
            </View>
          </View>

          {hasOldNew ? (
            wrapFileToolPreviewBody(
              isFull,
              isStreaming,
              key,
              <View style={[styles.toolCardDiff, styles.toolCardDiffPreview]}>
                <View style={[styles.toolCardDiffSide, styles.toolCardDiffOld]}>
                  <Text style={styles.toolCardDiffLabel}>替换前</Text>
                  <Text style={styles.toolCardDiffPre} selectable>
                    {oldTrim || '(无)'}
                  </Text>
                </View>
                <View style={styles.toolCardDiffSide}>
                  <Text style={styles.toolCardDiffLabel}>替换后</Text>
                  <Text style={styles.toolCardDiffPre} selectable>
                    {newTrim || '(空)'}
                  </Text>
                </View>
              </View>
            )
          ) : (block.arguments || block.status === 'pending' || block.status === 'waiting') ? (
            <Text style={styles.toolCardBodyMuted}>
              {fileArgs.pathDisplay ? '参数解析中…' : '等待参数…'}
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

  function renderExecCommandToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    const execArgs = parseExecCommandArgs(block);
    const resultObj = block.result && typeof block.result === 'object' ? (block.result as Record<string, unknown>) : null;
    const stdout = resultObj && typeof resultObj.stdout === 'string' ? resultObj.stdout : '';
    const exitCode = resultObj && typeof resultObj.exit_code === 'number' ? resultObj.exit_code : null;
    const timeInfo = execCardTimeRef.current[key];
    const isRunning = block.status === 'running' || block.status === 'pending';
    const elapsedSec = timeInfo && isRunning ? Math.floor((Date.now() - timeInfo.startMs) / 1000) : 0;
    const completedSec = timeInfo?.completedSec;

    if (viewMode === 'collapsed') {
      const headerLabel = execArgs.description || '终端命令';
      const programTail = execArgs.programName ? ` (${execArgs.programName})` : '';
      const lastLine = stripAnsi(stdout).trim().split(/\n/).filter(Boolean).pop() ?? '';
      const tailText = lastLine.length > 60 ? '…' + lastLine.slice(-60) : lastLine;
      const timeStr = completedSec != null ? ` (执行完成 ${formatSec(completedSec)})` : isRunning ? ` (${formatSec(elapsedSec)})` : '';
      const collapsedTail = (tailText ? tailText + timeStr : timeStr) || ' ';
      return (
        <Pressable
          key={key}
          style={({ pressed }) => [styles.toolCard, styles.toolCardCollapsed, pressed && styles.toolCardCollapsedPressed]}
          onPress={() => setToolCardMode(key, 'preview')}
          accessibilityLabel="点击展开"
        >
          <Text style={styles.toolCardCollapsedName} numberOfLines={1}>
            {headerLabel}
            {programTail}
          </Text>
          <Text style={[styles.toolCardCollapsedTail, { flex: 1 }]} numberOfLines={1}>
            {collapsedTail}
          </Text>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={[styles.toolCardBadge, exitCode === 0 ? styles.toolCardBadgeSuccess : undefined]}>
              {getToolStatusLabel(block.status)}
            </Text>
          </View>
        </Pressable>
      );
    }

    const isFull = viewMode === 'full';
    const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
    const isSubmitting = submittingReviewId && submittingReviewId === block.review_id;
    const stderr = resultObj && typeof resultObj.stderr === 'string' ? resultObj.stderr : '';
    const errorMsg = resultObj && typeof resultObj.error === 'string' ? resultObj.error : null;

    const streamingFallback = typeof block.streaming_content === 'string' ? block.streaming_content : '';
    const stdoutForDisplay = stdout || streamingFallback;
    const stderrForDisplay = stderr;
    const headerLabel = execArgs.description || '终端命令';
    const programTail = execArgs.programName ? ` (${execArgs.programName})` : '';

    const maxOutLen = isFull ? 12000 : 3500;
    const plainTail = stripAnsi(stdoutForDisplay).trim();
    const previewTail = plainTail.length ? (plainTail.length > 220 ? plainTail.slice(plainTail.length - 220) : plainTail) : '';

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
            {headerLabel}
            {programTail}
            {' · '}
            {getToolStatusLabel(block.status)}
          </Text>

          {execArgs.command || execArgs.cwd ? (
            <Text style={styles.toolCardSafetyMeta} numberOfLines={2}>
              $ {execArgs.command || '(无命令)'}
              {execArgs.cwd ? `  (cwd: ${execArgs.cwd})` : ''}
            </Text>
          ) : null}

          {errorMsg ? (
            <Text style={styles.readPagesErrorText} numberOfLines={6}>
              {errorMsg}
            </Text>
          ) : null}

          {viewMode !== 'full' && !stdoutForDisplay && block.status !== 'completed' ? (
            <Text style={styles.toolCardSafetyMeta}>输出生成中...</Text>
          ) : null}

          {stdoutForDisplay ? (
            isFull ? (
              renderAnsiText(stdoutForDisplay, maxOutLen)
            ) : (
              previewTail ? (
                <Text style={[styles.toolCardBody, styles.toolCardCodeText]} numberOfLines={6} selectable>
                  {previewTail}
                </Text>
              ) : (
                <Text style={styles.toolCardSafetyMeta}>无输出</Text>
              )
            )
          ) : null}

          {stderrForDisplay ? (
            isFull ? (
              <View style={{ marginTop: 8 }}>
                {renderAnsiText(stderrForDisplay, Math.floor(maxOutLen / 2))}
              </View>
            ) : null
          ) : null}

          {isFull && block.status === 'completed' && exitCode != null ? (
            <Text style={styles.toolCardSafetyMeta} numberOfLines={1}>
              exit_code: {exitCode}
            </Text>
          ) : null}

          {(isRunning && elapsedSec >= 0) || completedSec != null ? (
            <Text style={styles.toolCardSafetyMeta} numberOfLines={1}>
              {block.status === 'completed' ? `执行完成（${formatSec(completedSec ?? 0)}）` : `执行中（${formatSec(elapsedSec)}）`}
            </Text>
          ) : null}

          {block.streaming_content && viewMode !== 'full' && !stdout ? (
            <Text style={[styles.toolCardBody, styles.toolCardCodeText]} numberOfLines={5} selectable>
              {block.streaming_content.length > 1000 ? block.streaming_content.slice(0, 1000) + '\n...' : block.streaming_content}
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

  /** 与 FlopsDesktop SearchEngineCard.jsx 1:1（无「完全展开」行，默认折叠） */
  function renderSearchEngineToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    const parsed = parseSearchEngineBlockArgs(block);
    const queries = parsed.queries || [];
    const searchGoal = parsed.search_goal || '';
    const result =
      block.result && typeof block.result === 'object' && !Array.isArray(block.result)
        ? (block.result as Record<string, unknown>)
        : null;
    const mergedResults = Array.isArray(result?.results) ? (result.results as Record<string, unknown>[]) : [];
    const resultsByQuery =
      result?.results_by_query && typeof result.results_by_query === 'object' && !Array.isArray(result.results_by_query)
        ? (result.results_by_query as Record<string, unknown[]>)
        : null;
    const isRunning = block.status === 'running' || block.status === 'pending';
    const errStr = result && typeof result.error === 'string' ? result.error : '';
    /** 与 Web：`result && !result.success && result.error`（success 未定义时仍视为失败提示） */
    const hasError = Boolean(result && errStr && result.success !== true);

    const headerMain = (() => {
      const n = queries.length;
      if (n === 0 && block.status === 'pending') return 'Searching: …';
      if (n === 0) return 'Searching 0 queries';
      return formatSearchHeaderQueries(queries);
    })();

    const collapsedTail =
      queries.length > 0 ? formatSearchCollapsedTail(queries) : result?.success === false ? '失败' : '…';

    const expandedQueries = searchEngineExpandedByCard[key] ?? [];

    const pickSearchItemFields = (item: Record<string, unknown>) => {
      const title = String(item?.title ?? item?.name ?? '')
        .trim()
        .replace(/\s+/g, ' ') || '（无标题）';
      const url = String(item?.url ?? item?.link ?? '').trim();
      const desc = String(item?.desc ?? item?.description ?? '').trim();
      return { title, url, desc };
    };

    const renderHeroResult = (item: Record<string, unknown>, index: number) => {
      const { title, url, desc } = pickSearchItemFields(item);
      return (
        <View key={index} style={styles.searchEngineHeroItem}>
          {url ? (
            <Pressable onPress={() => Linking.openURL(url)}>
              <Text style={styles.searchEngineHeroLink} numberOfLines={2}>
                {title}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.searchEngineHeroTitle} numberOfLines={2}>
              {title}
            </Text>
          )}
          {desc ? (
            <Text style={styles.searchEngineHeroDesc} numberOfLines={2}>
              {desc}
            </Text>
          ) : null}
        </View>
      );
    };

    const renderPerQueryResult = (item: Record<string, unknown>, index: number) => {
      const { title, url, desc } = pickSearchItemFields(item);
      return (
        <View key={index} style={styles.searchEnginePerQueryItem}>
          <Text style={styles.searchEnginePerQueryIndex}>{index + 1}.</Text>
          <View style={styles.searchEnginePerQueryMain}>
            {url ? (
              <Pressable onPress={() => Linking.openURL(url)}>
                <Text style={styles.searchEnginePerQueryLink}>{title}</Text>
              </Pressable>
            ) : (
              <Text style={styles.searchEnginePerQueryTitle}>{title}</Text>
            )}
            {desc ? <Text style={styles.searchEnginePerQueryDesc}>{desc}</Text> : null}
          </View>
        </View>
      );
    };

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
            Searching
          </Text>
          <Text style={[styles.toolCardCollapsedTail, { flex: 1 }]} numberOfLines={1} ellipsizeMode="tail">
            {collapsedTail}
          </Text>
          <View style={styles.toolCardBadgeWrap}>
            <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
              {getToolStatusLabel(block.status)}
            </Text>
          </View>
        </Pressable>
      );
    }

    return (
      <View key={key} style={styles.toolCard}>
        <Pressable
          onPress={() => setToolCardMode(key, 'collapsed')}
          style={({ pressed }) => (pressed ? styles.toolCardContentPressed : undefined)}
          accessibilityLabel="点击收起"
        >
          <View style={styles.toolCardHeaderRow}>
            <View style={styles.toolCardHeaderMain}>
              <Text style={styles.searchEngineHeaderMain} selectable>
                {headerMain}
              </Text>
            </View>
            <View style={styles.toolCardBadgeWrap}>
              <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
                {getToolStatusLabel(block.status)}
              </Text>
            </View>
          </View>

          <View style={styles.searchEngineWrap}>
            {queries.length > 0 ? (
              <View style={styles.searchEngineQueriesSection}>
                <View style={styles.searchEngineQueriesLine}>
                  <Text style={styles.searchEngineQueriesPrefix}>搜索了</Text>
                  {queries.map((q, qi) => {
                    const open = expandedQueries.includes(q);
                    return (
                      <Pressable
                        key={`${qi}-${q}`}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                        onPress={() => toggleSearchEngineQuery(key, q)}
                      >
                        <Text
                          style={[styles.searchEngineQueryChip, open && styles.searchEngineQueryChipOpen]}
                          suppressHighlighting
                        >
                          {q}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {queries.map((q, qi) => {
                  if (!expandedQueries.includes(q)) return null;
                  const raw = resultsByQuery && Array.isArray(resultsByQuery[q]) ? resultsByQuery[q] : [];
                  const results = raw.filter((x): x is Record<string, unknown> => x != null && typeof x === 'object');
                  if (results.length === 0) return null;
                  return (
                    <View key={`ex-${qi}-${q}`} style={styles.searchEngineQueryExpanded}>
                      <View style={styles.searchEnginePerQueryList}>
                        {results.map((item, i) => renderPerQueryResult(item, i))}
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}

            <View style={styles.searchEngineHero}>
              {hasError ? (
                <Text style={styles.searchEngineError}>{errStr}</Text>
              ) : mergedResults.length > 0 ? (
                <>
                  <View style={styles.searchEngineHeroHead}>
                    {searchGoal ? (
                      <Text style={styles.searchEngineGoalInline} numberOfLines={1}>
                        精选目标：{searchGoal}
                      </Text>
                    ) : null}
                    {searchGoal ? <Text style={styles.searchEngineHeroSep}>·</Text> : null}
                    <Text style={styles.searchEngineHeroLabelInline}>AI 精选 {mergedResults.length} 条</Text>
                  </View>
                  <View style={styles.searchEngineHeroGrid}>
                    {mergedResults.map((item, i) => renderHeroResult(item, i))}
                  </View>
                </>
              ) : isRunning ? (
                <Text style={styles.searchEngineMuted}>搜索中…</Text>
              ) : (
                <Text style={styles.searchEngineMuted}>暂无精选结果</Text>
              )}
            </View>
          </View>

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
                <Text style={styles.safetyBtnPrimaryText}>{isSubmitting ? '提交中...' : '确认执行'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {block.streaming_content ? (
            <Text style={[styles.toolCardBody, styles.toolCardCodeText]} numberOfLines={15} selectable>
              {block.streaming_content}
            </Text>
          ) : null}
        </Pressable>
      </View>
    );
  }

  const canGoBack = navigation.canGoBack();
  const leftEdgePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10,
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx > 60 && gestureState.moveX <= 40) {
          navigation.goBack();
        }
      },
    })
  ).current;

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

    if (block.tool_name === 'read_pages') {
      return renderReadPagesToolCard(block, key);
    }
    if (block.tool_name === 'local_write_file') {
      return renderFileWriteToolCard(block, key);
    }
    if (block.tool_name === 'local_edit_file') {
      return renderFileEditToolCard(block, key);
    }
    if (block.tool_name === 'local_exec_command') {
      return renderExecCommandToolCard(block, key);
    }
    if (block.tool_name === 'search_engine') {
      return renderSearchEngineToolCard(block, key);
    }

    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
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
            {block.status === 'completed' ? '成功' : block.status === 'pending' ? '参数生成中' : block.status === 'waiting' ? '等待执行' : block.status === 'running' ? '执行中' : block.status}
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
            {block.tool_name} · {block.status === 'completed' ? '成功' : block.status === 'pending' ? '参数生成中' : block.status === 'waiting' ? '等待执行' : block.status === 'running' ? '执行中' : block.status}
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
  const streamStatusBracketLabel =
    streamStatus === 'thinking'
      ? 'thinking'
      : streamStatus === 'checking_tools'
        ? 'checking tools'
        : streamStatus === 'tool_running' || streamStatus === 'tool_result'
          ? 'calling tools'
          : streamStatus === 'awaiting_safety_confirmation'
            ? 'awaiting confirmation'
            : 'talking';
  const streamStatusLabel =
    streamStatus === 'thinking'
      ? 'Thinking...'
      : streamStatus === 'checking_tools'
        ? 'Checking tools...'
        : streamStatus === 'awaiting_safety_confirmation'
          ? '等待安全确认'
          : 'Thinking...';

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
    <View style={styles.containerInner}>
      {canGoBack ? (
        <View
          style={styles.leftEdgeGesture}
          {...leftEdgePan.panHandlers}
          pointerEvents="box-only"
        />
      ) : null}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground style={StyleSheet.absoluteFill} topSolidHeight={insets.top + 8} />
        {canGoBack ? (
          <TouchableOpacity
            style={styles.circleBtn}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={24} color="#374151" />
          </TouchableOpacity>
        ) : (
          <View style={styles.circleBtn} />
        )}
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
            {conversationId ? (conversationTitle || '新对话') : 'Flops'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={handleNewConversation}
          disabled={loading}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={24} color="#374151" />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.select({ ios: 'padding', android: 'height' })}
        keyboardVerticalOffset={0}
      >
        {error ? (
          <Text style={[styles.globalError, { marginTop: headerHeight + 8 }]}>{error}</Text>
        ) : null}

        <View style={styles.scrollAndGradientWrap}>
          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={[
              styles.scrollContent,
              { paddingTop: headerHeight + 20, paddingBottom: scrollBottomPadding },
            ]}
            keyboardDismissMode="on-drag"
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
                  <Text style={styles.bubbleRole}>Flops ({streamStatusBracketLabel})</Text>
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
          {/* 底部整块贴屏底：渐变铺满整块并延伸到底，输入行叠在渐变底部，无单独白底 */}
          <View style={[styles.bottomOverlay, { height: bottomOverlayHeight }]}>
            <LinearGradient
              colors={[
                'rgba(255,255,255,0)',
                'rgba(255,255,255,0.5)',
                'rgba(255,255,255,0.9)',
                'rgba(255,255,255,0.98)',
              ]}
              locations={[0, 0.45, 0.7, 1]}
              style={StyleSheet.absoluteFill}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              pointerEvents="none"
            />
            <View style={styles.inputRowInOverlay} pointerEvents="box-none">
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
              <Pressable
                style={[
                  styles.sendBtn,
                  loading && styles.sendBtnStop,
                  (!canSend && !loading) && styles.sendBtnDisabled,
                ]}
                onPress={loading ? handleStop : handleSendMessage}
                disabled={!loading && !canSend}
              >
                {loading ? (
                  <Ionicons name="stop" size={24} color="#fff" />
                ) : (
                  <Ionicons name="send" size={22} color="#fff" />
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>

    <ReadPagesDetailSheet
      visible={readPagesModalEntry != null}
      onClose={() => setReadPagesModalEntry(null)}
      title={
        readPagesModalEntry
          ? decodeUrlPctForDisplay(
              String(
                readPagesModalEntry.entry.title ||
                  readPagesModalEntry.entry.url ||
                  readPagesModalEntry.entryKey
              )
            )
          : ''
      }
      entry={readPagesModalEntry?.entry ?? null}
    />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  containerInner: { flex: 1 },
  keyboardView: { flex: 1 },
  scrollAndGradientWrap: { flex: 1 },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  inputRowInOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    gap: 12,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  circleBtn: {
    width: HEADER_CIRCLE_BTN_SIZE,
    height: HEADER_CIRCLE_BTN_SIZE,
    borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    ...shadowCircleButton,
  },
  leftEdgeGesture: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 24,
    zIndex: 10,
  },
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: 8,
  },
  headerTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: '#0f172a' },
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
    marginRight: 8,
  },
  toolCardCollapsedTail: {
    fontSize: 11,
    color: '#64748b',
    marginRight: 8,
  },
  toolCardBadgeWrap: { marginLeft: 4 },
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
  toolCardBadgeSuccess: {
    color: '#166534',
    backgroundColor: '#dcfce7',
    borderColor: '#86efac',
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
  toolCardHeader: { fontSize: 13, fontWeight: '600', color: '#1f2937', marginBottom: 8, minWidth: 0 },
  toolCardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  toolCardHeaderMain: { flex: 1, minWidth: 0 },
  toolCardHeaderFilename: { fontSize: 13, fontWeight: '600', color: '#262626' },
  toolCardHeaderFilenamePlaceholder: { fontSize: 13, fontWeight: '600', color: '#737373' },
  toolCardHeaderEditSummary: { fontSize: 11, fontWeight: '500', color: '#525252', marginTop: 2 },
  toolCardBodyMuted: { fontSize: 12, color: '#737373', fontStyle: 'italic', marginTop: 6 },
  /** search_engine：与 FlopsDesktop search-engine-card.css 对齐 */
  searchEngineHeaderMain: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1f2937',
    lineHeight: 20,
  },
  searchEngineWrap: {
    flexDirection: 'column',
    gap: 10,
  },
  searchEngineQueriesSection: {},
  searchEngineQueriesLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 6,
    rowGap: 6,
  },
  searchEngineQueriesPrefix: {
    fontSize: 12,
    color: '#a3a3a3',
    marginRight: 4,
  },
  searchEngineQueryChip: {
    fontSize: 12,
    color: '#737373',
    textDecorationLine: 'underline',
  },
  searchEngineQueryChipOpen: {
    color: '#404040',
  },
  searchEngineQueryExpanded: {
    marginTop: 8,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: '#eee',
  },
  searchEnginePerQueryList: {
    marginTop: 6,
    paddingTop: 6,
    paddingLeft: 12,
    paddingRight: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  searchEnginePerQueryItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingVertical: 4,
  },
  searchEnginePerQueryIndex: {
    fontSize: 11,
    color: '#a3a3a3',
    lineHeight: 18,
    minWidth: 18,
  },
  searchEnginePerQueryMain: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  searchEnginePerQueryLink: {
    fontSize: 12,
    fontWeight: '400',
    color: '#171717',
    flexWrap: 'wrap',
  },
  searchEnginePerQueryTitle: {
    fontSize: 12,
    fontWeight: '400',
    color: '#171717',
  },
  searchEnginePerQueryDesc: {
    fontSize: 12,
    color: '#737373',
    lineHeight: 17,
    marginTop: 2,
  },
  searchEngineHero: {
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  searchEngineHeroHead: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    minWidth: 0,
    overflow: 'hidden',
  },
  searchEngineGoalInline: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 17,
    color: '#737373',
  },
  searchEngineHeroSep: {
    flexShrink: 0,
    fontSize: 12,
    color: '#d4d4d4',
  },
  searchEngineHeroLabelInline: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '600',
    color: '#525252',
    letterSpacing: 0.3,
  },
  searchEngineHeroGrid: {
    gap: 10,
  },
  searchEngineHeroItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaeaea',
    minWidth: 0,
    gap: 2,
  },
  searchEngineHeroLink: {
    fontSize: 14,
    fontWeight: '500',
    color: '#171717',
    lineHeight: 19,
  },
  searchEngineHeroTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#171717',
    lineHeight: 19,
  },
  searchEngineHeroDesc: {
    fontSize: 12,
    color: '#737373',
    lineHeight: 17,
    marginTop: 2,
  },
  searchEngineMuted: {
    fontSize: 13,
    color: '#737373',
    margin: 0,
  },
  searchEngineError: {
    fontSize: 13,
    color: '#b91c1c',
    margin: 0,
  },
  /** 与 Web `.tool-card-write-preview` 半折叠区域一致 */
  fileToolPreviewFullWrap: { marginTop: 8 },
  fileToolPreviewClip: {
    maxHeight: 120,
    marginTop: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  fileToolPreviewScroll: { maxHeight: 120, marginTop: 8 },
  fileToolPreviewScrollContent: { paddingBottom: 4 },
  fileToolPreviewFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 36,
  },
  fileToolPreviewEllipsis: {
    position: 'absolute',
    bottom: 2,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 12,
    color: '#737373',
  },
  toolCardWritePreview: {},
  toolCardWritePreviewText: { marginTop: 0 },
  toolCardDiff: { flexDirection: 'row', gap: 12, marginTop: 8 },
  toolCardDiffPreview: { marginTop: 0 },
  toolCardDiffSide: { flex: 1, minWidth: 0 },
  toolCardDiffOld: { borderRightWidth: 1, borderRightColor: '#e5e5e5', paddingRight: 12 },
  toolCardDiffLabel: { fontSize: 11, fontWeight: '600', color: '#737373', marginBottom: 2 },
  toolCardDiffPre: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 12,
    lineHeight: 18,
    color: '#262626',
    margin: 0,
  },
  toolCardBody: { fontSize: 13, color: '#1e293b', marginTop: 6, lineHeight: 20 },
  toolCardCodeText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 12,
    color: '#0f172a',
    lineHeight: 18,
    marginTop: 6,
  },
  toolCardSafetyMeta: { fontSize: 11, color: '#64748b', marginTop: 6 },
  toolCardSafetyReason: { fontSize: 12, color: '#334155', marginTop: 6 },
  readPagesEntryBox: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e5e5',
  },
  readPagesEntryTitle: { fontSize: 12, fontWeight: '600', color: '#111827' },
  readPagesTextBlock: { fontSize: 13, color: '#1e293b', lineHeight: 20, marginTop: 6 },
  readPagesErrorText: { fontSize: 12, color: '#991b1b', marginTop: 6 },
  readPagesLinksText: { fontSize: 12, color: '#334155', marginTop: 6 },
  readPagesUrlListWrap: { marginTop: 8, gap: 6 },
  readPagesUrlItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  readPagesUrlLink: { flex: 1, fontSize: 12, color: '#2563eb' },
  readPagesCardsScrollView: { marginTop: 8 },
  readPagesCardsScroll: { paddingVertical: 4, gap: 4 },
  readPagesSmallCard: {
    width: 160,
    backgroundColor: '#f5f5f5',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d8d8d8',
    overflow: 'hidden',
    marginRight: 6,
  },
  readPagesSmallCardHeader: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#ebebeb',
    borderBottomWidth: 1,
    borderBottomColor: '#d5d5d5',
  },
  readPagesSmallCardHeaderStreaming: {
    borderBottomWidth: 0,
    paddingBottom: 9,
  },
  readPagesHeaderLoadBarTrack: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 0,
    height: 2,
    backgroundColor: '#c8c8c8',
    borderRadius: 2,
    overflow: 'hidden',
  },
  readPagesHeaderLoadBarBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 56,
    height: 2,
    backgroundColor: '#667eea',
    borderRadius: 2,
  },
  readPagesSmallCardTitle: { flex: 1, fontSize: 11, fontWeight: '600', color: '#262626', minWidth: 0 },
  readPagesSmallCardBodyWrap: {
    width: '100%',
    aspectRatio: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  readPagesCardSquare: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ececec',
  },
  readPagesCardSquareBody: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#f5f5f5',
  },
  readPagesCardSquareCenter: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  readPagesCardBodyScroll: {
    padding: 8,
    paddingBottom: 12,
  },
  readPagesCardThumb: { width: '100%', aspectRatio: 1, backgroundColor: '#f0f0f0' },
  readPagesCardSpinner: { marginVertical: 20 },
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
  composerInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.10)',
    borderRadius: 28,
    paddingHorizontal: 20,
    paddingVertical: 14,
    fontSize: 16,
    color: '#111827',
    ...(Platform.OS === 'ios' ? shadowSoft : {}),
  },
  sendBtn: {
    width: 52,
    height: 52,
    borderRadius: 28,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    overflow: 'hidden',
    ...(Platform.OS === 'ios' ? shadowFab : {}),
  },
  sendBtnStop: { backgroundColor: '#dc2626' },
  sendBtnDisabled: { opacity: 0.5 },
});
