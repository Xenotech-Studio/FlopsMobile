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
import { ansiToSegments } from '../utils/ansiToSegments';
import {
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
import { ReadPagesDetailSheet } from '../components/ReadPagesDetailSheet';
import { SearchEngineCard } from './chat-cards/SearchEngineCard';
import { FileWriteCard } from './chat-cards/FileWriteCard';
import { FileEditCard } from './chat-cards/FileEditCard';
import { ExecCommandCard } from './chat-cards/ExecCommandCard';
import { DefaultToolCard } from './chat-cards/DefaultToolCard';
import { CursorAgentCard } from './chat-cards/CursorAgentCard';
import { ReadPagesCard } from './chat-cards/ReadPagesCard';

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

type ToolBlock = Extract<StreamBlock, { type: 'tool' }>;

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
        const b = localBlocks[i];
        if (b.type === 'tool' && b.index === index) return i;
      }
      return -1;
    };

    const onEvent = (event: ChatStreamEvent) => {
      if ('conversation_id' in event && event.conversation_id && !convId) {
        setConversationId(event.conversation_id);
        convId = event.conversation_id;
      }
      const e = event as unknown as { type?: string; title?: string };
      if (e.type === 'conversation_title' && typeof e.title === 'string') {
        setConversationTitle(e.title);
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
        const b = localBlocks[i];
        if (b.type === 'tool' && b.index === index) return i;
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
      if (msg.role !== 'assistant') return;
      const blocks = msg.blocks;
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
    const check = (blocks: StreamBlock[] | undefined) =>
      (blocks || []).some(
        (b) => b.type === 'tool' && (b as ToolBlock).tool_name === 'local_exec_command' && ((b as ToolBlock).status === 'running' || (b as ToolBlock).status === 'pending')
      );
    if (messages.some((m) => m.role === 'assistant' && check(m.blocks))) return true;
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

  function renderCursorAgentBlock(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    return (
      <CursorAgentCard
        block={block}
        cardKey={key}
        styles={styles as unknown as Record<string, object>}
        renderToolCardSafetyActions={renderToolCardSafetyActions}
        isSubmitting={Boolean(submittingReviewId && submittingReviewId === block.review_id)}
      />
    );
  }

  const setToolCardMode = useCallback((cardKey: string, mode: 'collapsed' | 'preview' | 'full') => {
    setToolCardViewMode((prev) => ({ ...prev, [cardKey]: mode }));
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

  function renderToolCardSafetyActions(reviewId: string, isSubmitting: boolean) {
    return (
      <View style={styles.safetyActions}>
        <TouchableOpacity
          style={styles.safetyBtn}
          onPress={() => handleSafetyDecision(reviewId, 'reject')}
          disabled={isSubmitting}
        >
          <Text style={styles.safetyBtnText}>拒绝</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.safetyBtn, styles.safetyBtnPrimary]}
          onPress={() => handleSafetyDecision(reviewId, 'approve')}
          disabled={isSubmitting}
        >
          <Text style={styles.safetyBtnPrimaryText}>{isSubmitting ? '提交中...' : '确认执行'}</Text>
        </TouchableOpacity>
      </View>
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

  function renderReadPagesToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <ReadPagesCard
        block={block}
        cardKey={key}
        styles={styles as unknown as Record<string, object>}
        setToolCardMode={setToolCardMode}
        renderToolCardSafetyActions={renderToolCardSafetyActions}
        onOpenEntry={(entryKey, entry) => setReadPagesModalEntry({ cardKey: key, entryKey, entry })}
        getToolStatusLabel={getToolStatusLabel}
        viewMode={viewMode}
        isSubmitting={Boolean(submittingReviewId && submittingReviewId === block.review_id)}
        renderHeaderLoadBar={() => <ReadPagesHeaderLoadBar />}
      />
    );
  }

  function renderFileWriteToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const fileArgs = parseFileToolArgs(block);
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <FileWriteCard
        block={block}
        cardKey={key}
        fileArgs={fileArgs}
        viewMode={viewMode}
        styles={styles as unknown as Record<string, object>}
        getToolStatusLabel={getToolStatusLabel}
        setToolCardMode={setToolCardMode}
        renderToolCardSafetyActions={renderToolCardSafetyActions}
        wrapFileToolPreviewBody={wrapFileToolPreviewBody}
        isSubmitting={Boolean(submittingReviewId && submittingReviewId === block.review_id)}
      />
    );
  }

  function renderFileEditToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const fileArgs = parseFileToolArgs(block);
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <FileEditCard
        block={block}
        cardKey={key}
        fileArgs={fileArgs}
        viewMode={viewMode}
        styles={styles as unknown as Record<string, object>}
        getToolStatusLabel={getToolStatusLabel}
        setToolCardMode={setToolCardMode}
        renderToolCardSafetyActions={renderToolCardSafetyActions}
        wrapFileToolPreviewBody={wrapFileToolPreviewBody}
        isSubmitting={Boolean(submittingReviewId && submittingReviewId === block.review_id)}
      />
    );
  }

  function renderExecCommandToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    const timeInfo = execCardTimeRef.current[key];
    const isRunning = block.status === 'running' || block.status === 'pending';
    const elapsedSec = timeInfo && isRunning ? Math.floor((Date.now() - timeInfo.startMs) / 1000) : 0;
    const completedSec = timeInfo?.completedSec;
    return (
      <ExecCommandCard
        block={block}
        cardKey={key}
        viewMode={viewMode}
        styles={styles as unknown as Record<string, object>}
        getToolStatusLabel={getToolStatusLabel}
        setToolCardMode={setToolCardMode}
        renderToolCardSafetyActions={renderToolCardSafetyActions}
        renderAnsiText={renderAnsiText}
        formatSec={formatSec}
        elapsedSec={elapsedSec}
        completedSec={completedSec}
        isSubmitting={Boolean(submittingReviewId && submittingReviewId === block.review_id)}
      />
    );
  }

  /** 与 FlopsDesktop SearchEngineCard.jsx 1:1（无「完全展开」行，默认折叠） */
  function renderSearchEngineToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <SearchEngineCard
        block={block}
        cardKey={key}
        viewMode={viewMode}
        styles={styles as unknown as Record<string, object>}
        getToolStatusLabel={getToolStatusLabel}
        setToolCardMode={setToolCardMode}
        onSafetyDecision={handleSafetyDecision}
        submittingReviewId={submittingReviewId}
      />
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
    return (
      <DefaultToolCard
        block={block}
        cardKey={key}
        viewMode={viewMode}
        styles={styles as unknown as Record<string, object>}
        getToolStatusLabel={getToolStatusLabel}
        setToolCardMode={setToolCardMode}
        renderToolCardSafetyActions={renderToolCardSafetyActions}
        isSubmitting={Boolean(submittingReviewId && submittingReviewId === block.review_id)}
      />
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
              const blocks = msg.blocks ?? [];
              const prevBlock = blocks[bi - 1];
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
                <React.Fragment key={`msg-tool-${idx}-${bi}`}>
                  {renderToolBlock(block, `msg-tool-${idx}-${bi}`)}
                </React.Fragment>
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
                        <React.Fragment key={`stream-tool-${bi}`}>
                          {renderToolBlock(block, `stream-tool-${bi}`)}
                        </React.Fragment>
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
