import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  PanResponder,
  Linking,
  ActivityIndicator,
  Image,
  Animated,
  AppState,
  Alert,
  InteractionManager,
  Dimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { convProfileLog } from '../debug/conversationLoadProfile';
import { useSession } from '../context/SessionContext';
import type { RootStackParamList } from '../navigation/types';
import {
  createConversation,
  streamChatV2Loop,
  cancelConversation,
  submitSafetyDecision,
  getConversation,
  getLayoutPreferences,
  getModelsConfig,
  selectModel,
  getAgentIds,
  getAgentProfile,
  type ModelsConfigResponse,
  type ChatStreamEvent,
  type ChatV2StreamStart,
  type ConversationMessage,
  type Conversation,
  type UsageStats,
  type UsageRun,
  type AgentProfile,
  type ContextSummary,
} from '../api';
import {
  rawMessagesToLocal,
  rawMessagesToLocalWithUsageMap,
  resolveLocalAssistantIndexFromRawUsageIndex,
  type StreamBlock,
  type ChatMessage,
  type ToolResult,
} from '../utils/chatLocalMessages';
import {
  formatUsageTiny,
  formatUsageHoverDetail,
  formatConversationUsageHeaderLine,
  getConversationContextCompressMessagePercent,
} from '../utils/formatUsage';
import { resolveContextCompressDividerPlacement } from '../utils/contextCompress';
import { normalizeUsageCurrencyMode, type UsageCurrencyMode } from '../constants/pricingDisplay';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Clipboard from '@react-native-clipboard/clipboard';
import { MarkdownContent } from '../components/MarkdownContent';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { CHAT_COMPOSER_CONTROL_SIZE } from '../theme/layout';
import { chatInputOverlayGradient, toolPreviewFadeGradient } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { createChatStyles } from './chat/ChatScreen.styles';
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
import { ModelSelectSheet } from '../components/ModelSelectSheet';
import { resolveAgentDisplayLabel } from '../utils/agentDisplay';
import { UsageDetailModal } from '../components/UsageDetailModal';
import { ContextCompressDividerRow } from '../components/ContextCompressDividerRow';
import { SearchEngineCard } from './chat-cards/SearchEngineCard';
import { FileWriteCard } from './chat-cards/FileWriteCard';
import { FileEditCard } from './chat-cards/FileEditCard';
import { ExecCommandCard } from './chat-cards/ExecCommandCard';
import { DefaultToolCard } from './chat-cards/DefaultToolCard';
import { CursorAgentCard } from './chat-cards/CursorAgentCard';
import { ReadPagesCard } from './chat-cards/ReadPagesCard';
import { FlowDocItemMetaProvider } from '../context/FlowDocItemMetaContext';
import { FlowDocEditCard } from './chat-cards/FlowDocEditCard';
import { FlowDocPatchCard } from './chat-cards/FlowDocPatchCard';
import { FlowDocWriteCard } from './chat-cards/FlowDocWriteCard';
import { FlowDocReadCard } from './chat-cards/FlowDocReadCard';
import { FlowDocGetTreeCard } from './chat-cards/FlowDocGetTreeCard';

type ToolBlock = Extract<StreamBlock, { type: 'tool' }>;

function mergeToolBlockResultForSafetyEvent(
  prevResult: unknown,
  event: Extract<ChatStreamEvent, { type: 'safety_confirmation_required' }>,
): unknown {
  const dp = event.delete_pending;
  if (!dp || typeof dp !== 'object') return prevResult;
  const base =
    prevResult && typeof prevResult === 'object' && !Array.isArray(prevResult)
      ? { ...(prevResult as Record<string, unknown>) }
      : {};
  const out: Record<string, unknown> = {
    ...base,
    requires_double_check: true,
  };
  if (dp.delete_target != null) out.delete_target = dp.delete_target;
  if (dp.preflight_stats != null) out.preflight_stats = dp.preflight_stats;
  if (dp.description != null) out.description = dp.description;
  const cwd = String(event.cwd || '').trim();
  if (cwd) out.cwd = cwd;
  return out;
}

const STREAM_TIMEOUT_MS = 300000;

/** High-resolution time when available (e.g. Hermes), else `Date.now()`. Avoids bare `performance` (not in RN TS libs). */
function perfNowMs(): number {
  const w = globalThis as typeof globalThis & { performance?: { now?: () => number } };
  const n = w.performance?.now;
  return typeof n === 'function' ? n.call(w.performance) : Date.now();
}

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

/** 与 FlopsWeb ModelPicker 下拉价展示一致（开启「对话内用量」时显示） */
function modelDropdownPriceLine(
  modelPriceReference: Record<string, unknown>,
  modelId: string,
  show: boolean
): string | null {
  if (!show) return null;
  const priceRef = modelPriceReference[modelId];
  if (priceRef === undefined) return null;
  if (priceRef === 0) return '免费';
  if (typeof priceRef === 'object' && priceRef != null) {
    const o = priceRef as { input?: unknown; output?: unknown };
    if (typeof o.input === 'number' && typeof o.output === 'number') {
      return `入 $${o.input} · 出 $${o.output} /M`;
    }
  }
  return null;
}

/** 与 FlopsWeb Chat.jsx 一致：存在进行中的 chat_v2 run 时去掉最后一条 user 之后的回复，避免与 subscribe 回放叠两套 */
function truncateMessagesAfterLastUser(messages: ChatMessage[]): ChatMessage[] {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') lastUserIdx = i;
  }
  if (lastUserIdx < 0) return messages;
  return messages.slice(0, lastUserIdx + 1);
}

type ChatRouteParams = RootStackParamList['Chat'];

/** Header 底部的 loading 条（与 Web flops-read-pages-card-header-loadbar 一致） */
function ReadPagesHeaderLoadBar({
  trackStyle,
  barStyle,
}: {
  trackStyle: StyleProp<ViewStyle>;
  barStyle: StyleProp<ViewStyle>;
}) {
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
    <View style={trackStyle}>
      <Animated.View style={[barStyle, { transform: [{ translateX: slide }] }]} />
    </View>
  );
}

export function ChatScreen() {
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Chat'>>();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createChatStyles(colors), [colors]);
  const headerHeight = insets.top + 8 + 12 + CHAT_COMPOSER_CONTROL_SIZE;
  /** 底部渐变条高度（叠在滚动内容上，透明→白） */
  const gradientStripHeight = 48;
  /** 输入行高度（输入框+发送+底部留白，模型/助手条绝对叠在留白内，不把整块顶上去） */
  const inputRowHeight = 92;
  /** 底部整块高度与改前一致：渐变 + 输入区（勿再加一行高度，否则输入框会整体上移） */
  const bottomOverlayHeight = gradientStripHeight + inputRowHeight;
  /** 列表底部留白，让内容可滚入渐变下方 */
  const scrollBottomPadding = bottomOverlayHeight + 12;
  const params = (route.params ?? undefined) as ChatRouteParams | undefined;
  const [conversationId, setConversationId] = useState(params?.conversationId ?? '');
  const [conversationTitle, setConversationTitle] = useState(params?.conversationTitle ?? '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverRawMessages, setServerRawMessages] = useState<ConversationMessage[]>([]);
  const [contextSummaries, setContextSummaries] = useState<ContextSummary[]>([]);
  const [activeContextSummaryId, setActiveContextSummaryId] = useState('');
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [usageRuns, setUsageRuns] = useState<UsageRun[]>([]);
  const [showTokenUsageInChat, setShowTokenUsageInChat] = useState(true);
  const [usageCurrencyDisplay, setUsageCurrencyDisplay] = useState<UsageCurrencyMode>(() =>
    normalizeUsageCurrencyMode(undefined)
  );
  const [modelPriceReference, setModelPriceReference] = useState<Record<string, unknown>>({});
  const [selectedModelId, setSelectedModelId] = useState('');
  const [availableModels, setAvailableModels] = useState<Record<string, string>>({});
  const [modelConfigLabel, setModelConfigLabel] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [draftAgentId, setDraftAgentId] = useState<string | null>(null);
  const [draftAgentProfile, setDraftAgentProfile] = useState<{ display_name: string; call_name: string }>({
    display_name: '',
    call_name: '',
  });
  /** 各 agent_id 的 display_name（用于底部选择与标签，避免只显示裸 id） */
  const [agentDisplayNameById, setAgentDisplayNameById] = useState<Record<string, string>>({});
  /** 有消息后的会话绑定 agent（来自 GET conversation） */
  const [conversationMeta, setConversationMeta] = useState<{
    bound_agent_id?: string;
    agent_profile?: AgentProfile;
  } | null>(null);
  const [usageDetailModalBody, setUsageDetailModalBody] = useState<string | null>(null);
  /** 编辑用户消息后重新生成（与 Web/Desktop 一致） */
  const [userMessageEdit, setUserMessageEdit] = useState<{ afterIndex: number; draft: string } | null>(null);
  const [messageInput, setMessageInput] = useState('');
  /** 回到本页时强制重建输入框，避免多行/高度在其它页编辑后残留 */
  const [composerRemountKey, setComposerRemountKey] = useState(0);
  const [loading, setLoading] = useState(false);
  /** 仅从路由拉取对话历史（GET conversation）期间，与流式 loading 分离 */
  const [conversationHistoryLoading, setConversationHistoryLoading] = useState(false);
  /** 正在执行 resumeV2Stream（含 AppState 恢复），用于空占位文案显示 Resuming... */
  const [v2ResumeUiActive, setV2ResumeUiActive] = useState(false);
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
  /** ScrollView 可视区域高度，用于把摘要分界滚到竖直方向居中 */
  const scrollViewportHeightRef = useRef(0);
  const chatContentWrapRef = useRef<View>(null);
  /** 摘要分界行原生节点，用于 measureLayout 相对 chatContentWrap 得到可 scrollTo 的偏移 */
  const contextCompressAnchorRef = useRef<View>(null);
  /** 流式文件卡片(半折叠)内部 ScrollView 引用，保持视图跟随最后几行 */
  const fileToolPreviewScrollRefs = useRef<Record<string, ScrollView | null>>({});
  /** key -> { startMs, completedSec }，用于 exec 卡片耗时与自动折叠 */
  const execCardTimeRef = useRef<Record<string, { startMs: number; completedSec?: number }>>({});
  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);
  /** 仅在有新消息/回复完成时滚到底部，避免展开折叠工具卡片时误滚 */
  const shouldScrollToEndRef = useRef(false);
  /** 与 shouldScrollToEndRef 配套：历史对话首次定位到底部用无动画，其余保持 true */
  const scrollToEndAnimatedRef = useRef(true);
  const conversationIdRef = useRef(conversationId);
  const sessionRef = useRef(session);
  const pausedByBackgroundRef = useRef(false);
  const hadBackgroundPauseRef = useRef(false);
  const streamInFlightRef = useRef(false);
  /** 供 Abort 后 catch 中读取本轮已流式片段（避免闭包陈旧） */
  const streamCaptureRef = useRef<{ text: string; blocks: StreamBlock[] }>({ text: '', blocks: [] });
  /** 路由进入会话时的 GET 请求代数，避免快速切换会话时旧响应误关 loading */
  const conversationRouteFetchGenRef = useRef(0);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    setUserMessageEdit(null);
  }, [conversationId]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const applyConversationUsageState = useCallback((conversation: Conversation) => {
    const raw =
      conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
    setServerRawMessages(raw);
    setUsageStats(conversation.usage_stats ?? null);
    setUsageRuns(Array.isArray(conversation.usage_runs) ? conversation.usage_runs : []);
    const sums = conversation.context_summaries;
    setContextSummaries(Array.isArray(sums) ? sums : []);
    const aid = conversation.active_context_summary_id;
    setActiveContextSummaryId(typeof aid === 'string' ? aid.trim() : '');
    setConversationMeta({
      bound_agent_id: typeof conversation.bound_agent_id === 'string' ? conversation.bound_agent_id : undefined,
      agent_profile: conversation.agent_profile,
    });
  }, []);

  const rawToLocalAssistantIndex = useMemo(
    () => rawMessagesToLocalWithUsageMap(serverRawMessages).rawToLocalAssistantIndex,
    [serverRawMessages]
  );

  const conversationForContextCompress = useMemo(
    () => ({
      messages: serverRawMessages,
      context_summaries: contextSummaries,
      active_context_summary_id: activeContextSummaryId,
    }),
    [serverRawMessages, contextSummaries, activeContextSummaryId]
  );

  const contextCompressMessagePercent = useMemo(
    () => getConversationContextCompressMessagePercent(conversationForContextCompress),
    [conversationForContextCompress]
  );

  const contextCompressPlacement = useMemo(
    () =>
      resolveContextCompressDividerPlacement({
        messageCount: messages.length,
        rawMessages: serverRawMessages,
        contextSummaries,
        activeContextSummaryId,
      }),
    [messages.length, serverRawMessages, contextSummaries, activeContextSummaryId]
  );

  const contextCompressScrollToAnchorTitle = '滚动到「摘要」位置（列表中间）';

  const scrollContentPaddingTop = headerHeight + 20;

  const scrollToContextCompressAnchor = useCallback(() => {
    const divider = contextCompressAnchorRef.current;
    const wrap = chatContentWrapRef.current;
    const sv = scrollRef.current;
    if (!divider || !wrap || !sv) return;
    const runMeasure = () => {
      // Fabric：measureLayout 的参照必须是原生 View 节点
      divider.measureLayout(
        wrap,
        (_left, top, _width, height) => {
          const dividerTopInContent = scrollContentPaddingTop + top;
          const dividerCenter = dividerTopInContent + Math.max(0, height) / 2;
          let viewportH = scrollViewportHeightRef.current;
          if (!(viewportH > 0)) {
            viewportH = Dimensions.get('window').height * 0.45;
          }
          const scrollY = Math.max(0, dividerCenter - viewportH / 2);
          sv.scrollTo({ y: scrollY, animated: true });
        },
        () => {
          /* measureLayout 失败时忽略 */
        }
      );
    };
    requestAnimationFrame(() => {
      InteractionManager.runAfterInteractions(runMeasure);
    });
  }, [scrollContentPaddingTop]);

  const usageByAssistantIdx = useMemo(() => {
    const m: Record<number, UsageStats> = {};
    for (const r of usageRuns) {
      const rawIdx = r.last_message_index;
      if (typeof rawIdx !== 'number' || rawIdx < 0 || !r.usage) continue;
      let localIdx = -1;
      if (rawToLocalAssistantIndex.size > 0) {
        localIdx = resolveLocalAssistantIndexFromRawUsageIndex(rawToLocalAssistantIndex, rawIdx);
      }
      if (localIdx < 0) localIdx = rawIdx;
      m[localIdx] = r.usage;
    }
    return m;
  }, [usageRuns, rawToLocalAssistantIndex]);

  const applyModelsConfig = useCallback((cfg: ModelsConfigResponse) => {
    const ref = cfg.model_price_reference;
    setModelPriceReference(ref && typeof ref === 'object' ? ref : {});
    setSelectedModelId(typeof cfg.selected_model === 'string' ? cfg.selected_model : '');
    const am = cfg.available_models;
    setAvailableModels(
      am && typeof am === 'object' && !Array.isArray(am) ? (am as Record<string, string>) : {}
    );
    const lab =
      typeof cfg.selected_model_label === 'string'
        ? cfg.selected_model_label
        : typeof cfg.selected_model === 'string'
          ? cfg.selected_model
          : '';
    setModelConfigLabel(lab);
  }, []);

  useEffect(() => {
    if (!session) return;
    getModelsConfig(session).then(applyModelsConfig).catch(() => {});
  }, [session, applyModelsConfig]);

  const modelOptions = useMemo(() => {
    const am = availableModels;
    const entries = Object.entries(am);
    if (entries.length > 0) {
      return entries
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([label, modelId]) => ({ label: label || modelId, value: modelId.trim() }))
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
    }
    const sel = selectedModelId;
    if (typeof sel === 'string' && sel.trim()) {
      return [{ label: modelConfigLabel || sel.trim(), value: sel.trim() }];
    }
    return [];
  }, [availableModels, selectedModelId, modelConfigLabel]);

  const composerModelTriggerLabel = useMemo(() => {
    const sel = selectedModelId;
    if (!sel) return '模型';
    const found = modelOptions.find((o) => o.value === sel);
    if (found) return found.label;
    return modelConfigLabel || sel;
  }, [selectedModelId, modelOptions, modelConfigLabel]);

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      const model = String(modelId || '').trim();
      if (!session || !model) return;
      setModelPickerOpen(false);
      if (model === selectedModelId) return;
      const prevId = selectedModelId;
      const prevLabel = modelConfigLabel;
      const prevRef = modelPriceReference;
      const opt = modelOptions.find((o) => o.value === model);
      setSelectedModelId(model);
      setModelConfigLabel(opt?.label ?? prevLabel);
      try {
        const data = await selectModel(session, model);
        applyModelsConfig(data);
      } catch (e) {
        setSelectedModelId(prevId);
        setModelConfigLabel(prevLabel);
        setModelPriceReference(prevRef);
        const msg = e instanceof Error ? e.message : String(e);
        Alert.alert('切换模型失败', msg);
      }
    },
    [
      session,
      selectedModelId,
      modelConfigLabel,
      modelPriceReference,
      modelOptions,
      applyModelsConfig,
    ]
  );

  const modelSheetOptions = useMemo(
    () =>
      modelOptions.map((o) => ({
        label: o.label,
        value: o.value,
        subtitle: modelDropdownPriceLine(
          modelPriceReference,
          o.value,
          showTokenUsageInChat
        ),
      })),
    [modelOptions, modelPriceReference, showTokenUsageInChat]
  );

  const reloadLayoutPrefs = useCallback(() => {
    if (!session) return;
    getLayoutPreferences(session)
      .then((prefs) => {
        if (typeof prefs.show_token_usage_in_chat === 'boolean') {
          setShowTokenUsageInChat(prefs.show_token_usage_in_chat);
        }
        if (prefs.usage_currency_display != null) {
          setUsageCurrencyDisplay(normalizeUsageCurrencyMode(prefs.usage_currency_display));
        }
      })
      .catch(() => {});
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      reloadLayoutPrefs();
      if (session) {
        getModelsConfig(session).then(applyModelsConfig).catch(() => {});
      }
    }, [reloadLayoutPrefs, session, applyModelsConfig])
  );

  const composerRemountSkipFirstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (composerRemountSkipFirstFocusRef.current) {
        composerRemountSkipFirstFocusRef.current = false;
        return;
      }
      setComposerRemountKey((n) => n + 1);
    }, [])
  );

  /** 空会话（欢迎/草稿）：拉 agent 列表，与 FlopsWeb 首页草稿一致 */
  useEffect(() => {
    if (!session || messages.length > 0) return;
    let cancelled = false;
    getAgentIds(session)
      .then((ids) => {
        if (!cancelled) setAgentIds(ids);
      })
      .catch(() => {
        if (!cancelled) setAgentIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session, messages.length]);

  const agentIdsProfileFetchKey = useMemo(
    () =>
      [...new Set(agentIds.map((x) => String(x || '').trim()).filter(Boolean))].sort().join('\0'),
    [agentIds]
  );

  /** 草稿会话：为可选 agent 列表拉 display_name */
  useEffect(() => {
    if (!session || !agentIdsProfileFetchKey) return;
    const ids = agentIdsProfileFetchKey.split('\0').filter(Boolean);
    let cancelled = false;
    void Promise.all(
      ids.map((id) =>
        getAgentProfile(session, id).then((p) => {
          const dn = (p.display_name || '').trim();
          return [id, dn] as const;
        })
      )
    ).then((entries) => {
      if (cancelled) return;
      setAgentDisplayNameById((prev) => {
        const next = { ...prev };
        for (const [id, dn] of entries) {
          if (dn) next[id] = dn;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [session, agentIdsProfileFetchKey]);

  const boundAgentIdForLabel = String(conversationMeta?.bound_agent_id || '').trim();
  const boundMetaDisplayName = String(conversationMeta?.agent_profile?.display_name || '').trim();
  const boundCachedDisplayName = boundAgentIdForLabel
    ? (agentDisplayNameById[boundAgentIdForLabel] ?? '')
    : '';

  /** 有消息会话：meta 未带 display_name 时补拉 profile */
  useEffect(() => {
    if (!session || !boundAgentIdForLabel || boundMetaDisplayName || boundCachedDisplayName) return;
    let cancelled = false;
    getAgentProfile(session, boundAgentIdForLabel).then((p) => {
      if (cancelled) return;
      const dn = (p.display_name || '').trim();
      if (!dn) return;
      setAgentDisplayNameById((prev) => ({ ...prev, [boundAgentIdForLabel]: dn }));
    });
    return () => {
      cancelled = true;
    };
  }, [session, boundAgentIdForLabel, boundMetaDisplayName, boundCachedDisplayName]);

  /** 草稿页默认选中首个 agent（字母序由服务端 agent_ids 决定） */
  useEffect(() => {
    if (messages.length > 0) return;
    if (!agentIds.length) return;
    setDraftAgentId((prev) => (prev && agentIds.includes(prev) ? prev : agentIds[0]));
  }, [messages.length, agentIds]);

  /** 草稿选中 agent 的显示名（气泡与 composer 标签） */
  useEffect(() => {
    if (!session || messages.length > 0 || !draftAgentId) return;
    let cancelled = false;
    getAgentProfile(session, draftAgentId)
      .then((p) => {
        if (cancelled) return;
        const display_name = typeof p.display_name === 'string' ? p.display_name : '';
        const call_name = typeof p.call_name === 'string' ? p.call_name : '';
        setDraftAgentProfile({
          display_name,
          call_name,
        });
        const dn = display_name.trim();
        if (dn) {
          setAgentDisplayNameById((prev) =>
            prev[draftAgentId] === dn ? prev : { ...prev, [draftAgentId]: dn }
          );
        }
      })
      .catch(() => {
        if (!cancelled) setDraftAgentProfile({ display_name: '', call_name: '' });
      });
    return () => {
      cancelled = true;
    };
  }, [session, messages.length, draftAgentId]);

  const composerAgentLabel = useMemo(() => {
    const labelFor = (id: string | null | undefined) =>
      resolveAgentDisplayLabel(id, id ? agentDisplayNameById[id] : undefined);
    if (messages.length > 0) {
      const fromProf = (conversationMeta?.agent_profile?.display_name || '').trim();
      if (fromProf) return fromProf;
      const bound = String(conversationMeta?.bound_agent_id || '').trim();
      if (bound) return labelFor(bound);
      /** 已发首条但 GET conversation 尚未回填 bound 时，沿用草稿区选中 */
      const draftDn = (draftAgentProfile.display_name || '').trim();
      if (draftDn) return draftDn;
      return labelFor(draftAgentId);
    }
    const draftDn = (draftAgentProfile.display_name || '').trim();
    if (draftDn) return draftDn;
    return labelFor(draftAgentId);
  }, [
    messages.length,
    conversationMeta?.agent_profile?.display_name,
    conversationMeta?.bound_agent_id,
    draftAgentProfile.display_name,
    draftAgentId,
    agentDisplayNameById,
  ]);

  const agentSheetOptions = useMemo(
    () =>
      agentIds.map((id) => ({
        label: resolveAgentDisplayLabel(id, agentDisplayNameById[id]),
        value: id,
      })),
    [agentIds, agentDisplayNameById]
  );

  const agentComposerInteractive = messages.length === 0 && agentIds.length > 0;
  const showAgentComposerColumn = agentIds.length > 0 || messages.length > 0;

  const handleSelectAgent = useCallback((agentId: string) => {
    const id = String(agentId || '').trim();
    if (!id) return;
    setDraftAgentId(id);
    setAgentPickerOpen(false);
  }, []);

  const canSend = Boolean(
    session && messageInput.trim() && !loading && !conversationHistoryLoading
  );

  const runV2WithHandlers = useCallback(
    async (opts: {
      convId: string;
      start: ChatV2StreamStart;
      signal: AbortSignal;
    }): Promise<{
      streamDone: boolean;
      finalText: string;
      localBlocks: StreamBlock[];
      lastConvId: string;
    }> => {
      if (!session) throw new Error('未登录');
      const streamTargetRef = { current: opts.convId };
      const localBlocks: StreamBlock[] = [];
      let finalText = '';
      let streamDone = false;
      streamCaptureRef.current = { text: '', blocks: [] };

      const syncBlocks = () => {
        setCurrentAssistantBlocks([...localBlocks]);
        finalText = localBlocks
          .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
          .map((b) => b.content)
          .join('');
        setStreamingText(finalText);
        streamCaptureRef.current = { text: finalText, blocks: [...localBlocks] };
      };

      const findLastToolBlockByIndex = (index: number): number => {
        for (let i = localBlocks.length - 1; i >= 0; i--) {
          const b = localBlocks[i];
          if (b.type === 'tool' && b.index === index) return i;
        }
        return -1;
      };

      const onEvent = (event: ChatStreamEvent) => {
        if ('type' in event && event.type === 'v2_run') return;
        if ('conversation_id' in event && event.conversation_id) {
          streamTargetRef.current = event.conversation_id;
          setConversationId(event.conversation_id);
          conversationIdRef.current = event.conversation_id;
        }
        const e = event as unknown as { type?: string; title?: string };
        if (e.type === 'conversation_title' && typeof e.title === 'string') {
          setConversationTitle(e.title);
        }
        if (e.type === 'usage') {
          const ev = event as { usage_stats?: UsageStats; usage_run?: UsageRun };
          if (ev.usage_stats) setUsageStats(ev.usage_stats);
          if (ev.usage_run) {
            const run = ev.usage_run;
            setUsageRuns((prev) => {
              const ur = [...prev];
              const ix = ur.findIndex((x) => x.run_id === run.run_id);
              if (ix >= 0) ur[ix] = run;
              else ur.push(run);
              return ur;
            });
          }
        }
        if ('error' in event && event.error) throw new Error(String(event.error));
        if ('type' in event) {
          if (event.type === 'thinking') setStreamStatus('thinking');
          if (event.type === 'checking_tools') setStreamStatus('checking_tools');
          if (event.type === 'tool_call_start') {
            const idx = event.index ?? 0;
            const name = String(event.name || '');
            const i = findLastToolBlockByIndex(idx);
            const existingCompleted = i >= 0 && localBlocks[i].type === 'tool' && localBlocks[i].status === 'completed';
            if (i >= 0 && !existingCompleted) {
              localBlocks[i] = {
                ...localBlocks[i],
                type: 'tool',
                index: idx,
                tool_name: name,
                status: 'pending',
                arguments: '',
                streaming_content: '',
              } as StreamBlock;
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
          if (event.type === 'history_revision') {
            const ev = event as { conversation_id?: string };
            const cid = String(ev.conversation_id || streamTargetRef.current || '').trim();
            if (cid && cid === conversationIdRef.current && session) {
              void (async () => {
                try {
                  const { conversation } = await getConversation(session, cid);
                  applyConversationUsageState(conversation);
                  const raw =
                    conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
                  let synced = rawMessagesToLocal(raw);
                  const stillRunning =
                    typeof conversation?.active_chat_v2_run_id === 'string' &&
                    conversation.active_chat_v2_run_id.trim();
                  if (stillRunning) synced = truncateMessagesAfterLastUser(synced);
                  if (conversationIdRef.current === cid) {
                    shouldScrollToEndRef.current = true;
                    setMessages(synced);
                  }
                } catch {
                  /* ignore */
                }
              })();
            }
          }
          if (event.type === 'safety_confirmation_required') {
            setStreamStatus('awaiting_safety_confirmation');
            const name = event.tool_name;
            let updated = false;
            for (let i = localBlocks.length - 1; i >= 0; i--) {
              const b = localBlocks[i];
              if (b.type === 'tool' && b.tool_name === name) {
                const merged = mergeToolBlockResultForSafetyEvent(b.result, event);
                localBlocks[i] = {
                  ...b,
                  status: 'awaiting_confirmation',
                  arguments: event.command ?? (event as { arguments?: string }).arguments,
                  review_id: event.review_id,
                  conversation_id: event.conversation_id || streamTargetRef.current,
                  review: event.review,
                  command: event.command,
                  cwd: event.cwd,
                  result: merged as ToolBlock['result'],
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
                conversation_id: event.conversation_id || streamTargetRef.current,
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

      /** 与 FlopsWeb Chat.jsx 一致：用本轮固定的 convId 判断存活；勿与 streamTargetRef 比（首包前 ref 可能尚未随 setState 同步） */
      const streamSessionConvId = opts.convId;
      await streamChatV2Loop(session, streamTargetRef.current, opts.start, onEvent, opts.signal, {
        isAlive: () => conversationIdRef.current === streamSessionConvId && !opts.signal.aborted,
      });

      return { streamDone, finalText, localBlocks, lastConvId: streamTargetRef.current };
    },
    [session, applyConversationUsageState]
  );

  const handleSendMessage = useCallback(async () => {
    if (!session || !messageInput.trim() || loading || conversationHistoryLoading) return;
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
        const bid = String(draftAgentId || '').trim();
        const { id } = await createConversation(
          session,
          bid ? { bound_agent_id: bid } : undefined
        );
        convId = id;
        setConversationId(id);
        conversationIdRef.current = id;
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
    streamInFlightRef.current = true;

    const timeout = setTimeout(() => {
      controller.abort();
    }, STREAM_TIMEOUT_MS);

    let silentBackgroundAbort = false;

    try {
      const { streamDone, finalText, localBlocks, lastConvId } = await runV2WithHandlers({
        convId,
        start: { tag: 'new_message', message: nextMessage },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const syncId = lastConvId;
      try {
        if (session) {
          const { conversation } = await getConversation(session, syncId);
          applyConversationUsageState(conversation);
          const raw =
            conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
          let synced = rawMessagesToLocal(raw);
          const stillRunning =
            typeof conversation?.active_chat_v2_run_id === 'string' &&
            conversation.active_chat_v2_run_id.trim();
          if (stillRunning) synced = truncateMessagesAfterLastUser(synced);
          if (streamDone || finalText.trim() || synced.length > 0) {
            shouldScrollToEndRef.current = true;
            setMessages(synced);
          }
          const t = conversation?.title?.trim();
          if (t) setConversationTitle(t);
        }
      } catch {
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
      }
    } catch (e) {
      clearTimeout(timeout);
      if (e && (e as { name?: string }).name === 'AbortError' && pausedByBackgroundRef.current) {
        pausedByBackgroundRef.current = false;
        silentBackgroundAbort = true;
      } else if (e && (e as { name?: string }).name === 'AbortError' && manualStopRef.current) {
        shouldScrollToEndRef.current = true;
        const stopNote = '[用户手动打断回复]';
        const cap = streamCaptureRef.current;
        const text = (cap.text || '').trim();
        const bl = cap.blocks || [];
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: text ? `${text}\n\n${stopNote}` : stopNote,
            blocks: bl.length ? [...bl, { type: 'text', content: stopNote }] : undefined,
          },
        ]);
      } else if (!silentBackgroundAbort) {
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
      streamInFlightRef.current = false;
      abortRef.current = null;
      manualStopRef.current = false;
      setSubmittingReviewId('');
      setLoading(false);
      setStreamingText('');
      setCurrentAssistantBlocks([]);
      setStreamStatus('');
    }
  }, [
    session,
    conversationId,
    messageInput,
    loading,
    conversationHistoryLoading,
    runV2WithHandlers,
    applyConversationUsageState,
    draftAgentId,
  ]);

  const handleStop = useCallback(async () => {
    setError('');
    manualStopRef.current = true;
    const snapshotBlocks = [...currentAssistantBlocks];
    const snapshotText = streamingText;
    if (snapshotBlocks.length > 0 || (snapshotText && snapshotText.trim())) {
      shouldScrollToEndRef.current = true;
      const stopNote = '[用户手动打断回复]';
      const text = (snapshotText || '').trim();
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: text ? `${text}\n\n${stopNote}` : stopNote,
          blocks: [...snapshotBlocks, { type: 'text', content: stopNote }],
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

  /** 回退到第 (afterUserIndex+1) 条 user 消息处并重新生成该条 AI 回复 */
  const handleRegenerate = useCallback(
    async (afterUserIndex: number, editedMessage?: string) => {
      if (!session || !conversationId || conversationHistoryLoading || afterUserIndex == null) return;
      if (editedMessage === undefined && loading) return;
      if (editedMessage !== undefined && loading) {
        await handleStop();
      }
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
        const sliced = prev.slice(0, keepThroughIdx + 1);
        if (editedMessage === undefined) return sliced;
        return sliced.map((m, i) =>
          i === keepThroughIdx && m.role === 'user' ? { ...m, content: editedMessage } : m,
        );
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
    streamInFlightRef.current = true;

    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    let silentBackgroundAbort = false;

    try {
      const regenStart: ChatV2StreamStart =
        editedMessage !== undefined
          ? { tag: 'regenerate', after_user_index: afterUserIndex, message: editedMessage }
          : { tag: 'regenerate', after_user_index: afterUserIndex };
      const { streamDone, finalText, localBlocks, lastConvId } = await runV2WithHandlers({
        convId: conversationId,
        start: regenStart,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const syncId = lastConvId;
      try {
        if (session) {
          const { conversation } = await getConversation(session, syncId);
          applyConversationUsageState(conversation);
          const raw =
            conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
          let synced = rawMessagesToLocal(raw);
          const stillRunning =
            typeof conversation?.active_chat_v2_run_id === 'string' &&
            conversation.active_chat_v2_run_id.trim();
          if (stillRunning) synced = truncateMessagesAfterLastUser(synced);
          if (streamDone || finalText.trim() || synced.length > 0) {
            shouldScrollToEndRef.current = true;
            setMessages(synced);
          }
          const t = conversation?.title?.trim();
          if (t) setConversationTitle(t);
        }
      } catch {
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
      }
    } catch (e) {
      clearTimeout(timeout);
      if (e && (e as { name?: string }).name === 'AbortError' && pausedByBackgroundRef.current) {
        pausedByBackgroundRef.current = false;
        silentBackgroundAbort = true;
      } else if (e && (e as { name?: string }).name === 'AbortError' && manualStopRef.current) {
        shouldScrollToEndRef.current = true;
        const stopNote = '[用户手动打断回复]';
        const cap = streamCaptureRef.current;
        const text = (cap.text || '').trim();
        const bl = cap.blocks || [];
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: text ? `${text}\n\n${stopNote}` : stopNote,
            blocks: bl.length ? [...bl, { type: 'text', content: stopNote }] : undefined,
          },
        ]);
      } else if (!silentBackgroundAbort) {
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
      streamInFlightRef.current = false;
      abortRef.current = null;
      manualStopRef.current = false;
      setSubmittingReviewId('');
      setLoading(false);
      setStreamingText('');
      setCurrentAssistantBlocks([]);
      setStreamStatus('');
    }
  },
    [
      session,
      conversationId,
      loading,
      conversationHistoryLoading,
      runV2WithHandlers,
      applyConversationUsageState,
      handleStop,
    ]
  );

  const handleNewConversation = useCallback(async () => {
    if (loading) return;
    const bidForCreate = String(draftAgentId || '').trim();
    setError('');
    setConversationId('');
    conversationIdRef.current = '';
    setConversationTitle('');
    setMessages([]);
    setServerRawMessages([]);
    setContextSummaries([]);
    setActiveContextSummaryId('');
    setUsageStats(null);
    setUsageRuns([]);
    setConversationMeta(null);
    try {
      if (session) {
        const { id } = await createConversation(
          session,
          bidForCreate ? { bound_agent_id: bidForCreate } : undefined
        );
        setConversationId(id);
        conversationIdRef.current = id;
        setConversationTitle('新对话');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建会话失败');
    }
  }, [session, loading, draftAgentId]);

  /** 从服务端 active_chat_v2_run_id 恢复流（打开会话 / 回到前台） */
  const resumeV2Stream = useCallback(
    async (runId: string, cid: string) => {
      if (!session) return;
      if (streamInFlightRef.current) return;
      streamInFlightRef.current = true;
      setV2ResumeUiActive(true);
      setError('');
      setLoading(true);
      setStreamingText('');
      setCurrentAssistantBlocks([]);
      setStreamStatus('thinking');
      shouldScrollToEndRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      manualStopRef.current = false;
      const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
      try {
        const { streamDone, finalText, localBlocks, lastConvId } = await runV2WithHandlers({
          convId: cid,
          start: { tag: 'resume', run_id: runId },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        try {
          const { conversation } = await getConversation(session, lastConvId);
          applyConversationUsageState(conversation);
          const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
          let synced = rawMessagesToLocal(raw);
          const stillRunning = typeof conversation?.active_chat_v2_run_id === 'string' && conversation.active_chat_v2_run_id.trim();
          if (stillRunning) {
            synced = truncateMessagesAfterLastUser(synced);
          }
          setMessages(synced);
          const t = conversation?.title?.trim();
          if (t) setConversationTitle(t);
        } catch {
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
        }
      } catch (e) {
        clearTimeout(timeout);
        if (e && (e as { name?: string }).name === 'AbortError' && pausedByBackgroundRef.current) {
          pausedByBackgroundRef.current = false;
        } else if (!(e && (e as { name?: string }).name === 'AbortError' && manualStopRef.current)) {
          setError(e instanceof Error ? e.message : String(e));
        }
        try {
          const { conversation } = await getConversation(session, cid);
          applyConversationUsageState(conversation);
          const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
          let synced = rawMessagesToLocal(raw);
          const stillRunning = typeof conversation?.active_chat_v2_run_id === 'string' && conversation.active_chat_v2_run_id.trim();
          if (stillRunning) {
            synced = truncateMessagesAfterLastUser(synced);
          }
          setMessages(synced);
        } catch {
          /* ignore */
        }
      } finally {
        streamInFlightRef.current = false;
        abortRef.current = null;
        manualStopRef.current = false;
        setSubmittingReviewId('');
        setV2ResumeUiActive(false);
        setLoading(false);
        setStreamingText('');
        setCurrentAssistantBlocks([]);
        setStreamStatus('');
      }
    },
    [session, runV2WithHandlers, applyConversationUsageState]
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        hadBackgroundPauseRef.current = true;
        if (abortRef.current && !manualStopRef.current) {
          pausedByBackgroundRef.current = true;
          abortRef.current.abort();
        }
      }
      if (next !== 'active') return;
      if (!hadBackgroundPauseRef.current) return;
      hadBackgroundPauseRef.current = false;
      const sess = sessionRef.current;
      const cid = conversationIdRef.current;
      if (!sess || !cid || streamInFlightRef.current) return;
      getConversation(sess, cid)
        .then(({ conversation }) => {
          const rid = conversation?.active_chat_v2_run_id;
          const s = typeof rid === 'string' ? rid.trim() : '';
          if (!s) return;
          applyConversationUsageState(conversation);
          const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
          setMessages(truncateMessagesAfterLastUser(rawMessagesToLocal(raw)));
          resumeV2Stream(s, cid);
        })
        .catch(() => {
          /* ignore */
        });
    });
    return () => sub.remove();
  }, [resumeV2Stream, applyConversationUsageState]);

  // local_exec_command / local_delete：运行中自动半展开(preview)、成功结束自动折叠；记录开始/结束时间供耗时显示
  useEffect(() => {
    const now = Date.now();
    const ref = execCardTimeRef.current;
    const keysToPreview: string[] = [];
    const keysToCollapse: string[] = [];

    const handleExecLikeBlock = (block: StreamBlock, key: string) => {
      if (block.type !== 'tool') return;
      const tb = block as ToolBlock;
      if (tb.tool_name !== 'local_exec_command' && tb.tool_name !== 'local_delete') return;
      const status = tb.status;
      const result = tb.result as ToolResult | undefined;
      const exitCode = result?.exit_code ?? undefined;
      const r = result as { ok?: boolean; success?: boolean } | undefined;

      if (status === 'running' || status === 'pending') {
        if (!ref[key]) ref[key] = { startMs: now };
        keysToPreview.push(key);
      } else if (status === 'completed') {
        if (ref[key] && ref[key].completedSec === undefined)
          ref[key] = { ...ref[key], completedSec: Math.floor((now - ref[key].startMs) / 1000) };
        const okCollapse =
          tb.tool_name === 'local_exec_command'
            ? exitCode === 0
            : Boolean(r?.ok === true || r?.success === true);
        if (okCollapse) keysToCollapse.push(key);
      }
    };

    messages.forEach((msg, idx) => {
      if (msg.role !== 'assistant') return;
      const blocks = msg.blocks;
      if (!blocks?.length) return;
      blocks.forEach((block, bi) => {
        handleExecLikeBlock(block, `msg-tool-${idx}-${bi}`);
      });
    });
    (currentAssistantBlocks || []).forEach((block, bi) => {
      handleExecLikeBlock(block, `stream-tool-${bi}`);
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
        (b) =>
          b.type === 'tool' &&
          ((b as ToolBlock).tool_name === 'local_exec_command' || (b as ToolBlock).tool_name === 'local_delete') &&
          ((b as ToolBlock).status === 'running' || (b as ToolBlock).status === 'pending')
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
    if (!id || !session) {
      setConversationHistoryLoading(false);
      return;
    }
    let cancelled = false;
    const gen = ++conversationRouteFetchGenRef.current;
    setConversationHistoryLoading(true);
    getConversation(session, id)
      .then(({ conversation }) => {
        if (cancelled || gen !== conversationRouteFetchGenRef.current) return;
        const tUi0 = perfNowMs();
        setConversationHistoryLoading(false);
        const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
        shouldScrollToEndRef.current = true;
        scrollToEndAnimatedRef.current = false;
        const rid = conversation?.active_chat_v2_run_id;
        const runId = typeof rid === 'string' ? rid.trim() : '';
        const tMap0 = perfNowMs();
        applyConversationUsageState(conversation);
        let localMsgs = rawMessagesToLocal(raw);
        if (runId) {
          localMsgs = truncateMessagesAfterLastUser(localMsgs);
        }
        const tMap1 = perfNowMs();
        setMessages(localMsgs);
        setConversationId(id);
        conversationIdRef.current = id;
        setConversationTitle(conversation?.title?.trim() || '新对话');
        convProfileLog('ChatScreen.routeOpen.afterGet', {
          conversationId: id,
          rawMessageCount: raw.length,
          localMessageCount: localMsgs.length,
          hasActiveRun: Boolean(runId),
          rawToLocalMs: Math.round(tMap1 - tMap0),
          syncWorkBeforeSetStateMs: Math.round(tMap1 - tUi0),
        });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const tPaint = perfNowMs();
            convProfileLog('ChatScreen.routeOpen.after2xRAF', {
              conversationId: id,
              msSinceUiStart: Math.round(tPaint - tUi0),
            });
          });
        });
        if (runId) {
          resumeV2Stream(runId, id);
        } else {
          setLoading(false);
        }
      })
      .catch((e) => {
        if (cancelled || gen !== conversationRouteFetchGenRef.current) return;
        setConversationHistoryLoading(false);
        setError(e instanceof Error ? e.message : '打开对话失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
      setConversationHistoryLoading(false);
    };
  }, [params?.conversationId, session, resumeV2Stream, applyConversationUsageState]);

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

  /** 与 Web/Desktop 一致：read_pages、文件卡片、exec、FlowDoc 写/编/树 默认半展开；read_doc、search_engine 等默认折叠 */
  function getDefaultToolCardViewMode(toolName: string): 'collapsed' | 'preview' {
    if (
      toolName === 'read_pages' ||
      toolName === 'local_write_file' ||
      toolName === 'local_edit_file' ||
      toolName === 'local_exec_command' ||
      toolName === 'local_delete' ||
      toolName === 'get_doc_tree' ||
      toolName === 'edit_doc_as_md' ||
      toolName === 'patch_doc_as_md' ||
      toolName === 'write_doc_as_md'
    )
      return 'preview';
    if (toolName === 'read_doc') return 'collapsed';
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
          colors={toolPreviewFadeGradient(isDark, colors)}
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
        renderHeaderLoadBar={() => (
          <ReadPagesHeaderLoadBar
            trackStyle={styles.readPagesHeaderLoadBarTrack}
            barStyle={styles.readPagesHeaderLoadBarBar}
          />
        )}
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

  function renderFlowDocEditToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <FlowDocEditCard
        block={block}
        cardKey={key}
        conversationId={conversationId || undefined}
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

  function renderFlowDocPatchToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <FlowDocPatchCard
        block={block}
        cardKey={key}
        conversationId={conversationId || undefined}
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

  function renderFlowDocWriteToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <FlowDocWriteCard
        block={block}
        cardKey={key}
        conversationId={conversationId || undefined}
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

  function renderFlowDocReadToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <FlowDocReadCard
        block={block}
        cardKey={key}
        conversationId={conversationId || undefined}
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

  function renderFlowDocGetTreeToolCard(block: Extract<StreamBlock, { type: 'tool' }>, key: string) {
    const viewMode = toolCardViewMode[key] ?? getDefaultToolCardViewMode(block.tool_name);
    return (
      <FlowDocGetTreeCard
        block={block}
        cardKey={key}
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
    if (block.tool_name === 'edit_doc_as_md') {
      return renderFlowDocEditToolCard(block, key);
    }
    if (block.tool_name === 'patch_doc_as_md') {
      return renderFlowDocPatchToolCard(block, key);
    }
    if (block.tool_name === 'write_doc_as_md') {
      return renderFlowDocWriteToolCard(block, key);
    }
    if (block.tool_name === 'read_doc') {
      return renderFlowDocReadToolCard(block, key);
    }
    if (block.tool_name === 'get_doc_tree') {
      return renderFlowDocGetTreeToolCard(block, key);
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

  const renderMessage = (msg: ChatMessage, idx: number) => {
    if (msg.role === 'error') {
      return (
        <View key={`err-${idx}`} style={styles.errorWrap}>
          <Text style={styles.errorText}>{msg.content}</Text>
        </View>
      );
    }
    const isUser = msg.role === 'user';
    const userOrdinalIndex = isUser
      ? messages.slice(0, idx + 1).filter((m) => m.role === 'user').length - 1
      : -1;
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
    const segmentUsage =
      showTokenUsageInChat && usageByAssistantIdx[idx]
        ? formatUsageTiny(usageByAssistantIdx[idx], { currencyMode: usageCurrencyDisplay })
        : undefined;
    const segmentDetail =
      showTokenUsageInChat && usageByAssistantIdx[idx]
        ? formatUsageHoverDetail(usageByAssistantIdx[idx], {
            currencyMode: usageCurrencyDisplay,
            modelPriceReference,
            selectedModelId,
            scope: 'segment',
          })
        : undefined;

    const ccPl = contextCompressPlacement;
    const showCompressOnThisAssistant =
      showTokenUsageInChat &&
      Boolean(conversationId) &&
      contextCompressMessagePercent != null &&
      idx === lastAssistantIdx &&
      !loading &&
      !conversationHistoryLoading;
    const compressUsagePart = showCompressOnThisAssistant
      ? `${contextCompressMessagePercent}%已压缩`
      : '';
    const ccInside = ccPl?.kind === 'insideAssistantBlocks' && ccPl.assistantMessageIndex === idx;
    const assistantBlocks = msg.role === 'assistant' ? msg.blocks : undefined;
    const ccBlockInsert =
      ccInside && Array.isArray(assistantBlocks) && assistantBlocks.length > 0
        ? Math.min(ccPl.insertBeforeBlockIndex, assistantBlocks.length)
        : -1;

    const bubble = (
      <View
        key={`${msg.role}-${idx}`}
        style={[styles.bubbleWrap, isUser ? styles.userBubbleWrap : styles.assistantBubbleWrap]}
      >
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          {!isUser && <Text style={styles.bubbleRole}>{composerAgentLabel}</Text>}
          {!isUser && msg.role === 'assistant' && assistantBlocks && assistantBlocks.length > 0 ? (
            <>
              {assistantBlocks.map((block, bi) => {
                const blocks = assistantBlocks;
                const prevBlock = blocks[bi - 1];
                const compactAbove = prevBlock != null && isToolPackageNavBlock(prevBlock);
                return block.type === 'text' ? (
                  <React.Fragment key={bi}>
                    {ccInside && ccBlockInsert === bi && bi < blocks.length ? (
                      <ContextCompressDividerRow
                        activeSummary={ccPl.activeSummary}
                        rawMessages={serverRawMessages}
                        anchorRef={contextCompressAnchorRef}
                      />
                    ) : null}
                    <View
                      style={[styles.assistantTextBlock, compactAbove && styles.assistantTextBlockCompactAbove]}
                    >
                      <MarkdownContent
                        text={block.content}
                        showCopyButton={isLastAssistant && bi === lastTextBlockIdx}
                        showRegenerateButton={bi === lastTextBlockIdx}
                        onRegenerate={afterUserIndex >= 0 ? () => handleRegenerate(afterUserIndex) : undefined}
                        regenerateDisabled={!conversationId || loading || conversationHistoryLoading}
                        usageHint={bi === lastTextBlockIdx ? segmentUsage : undefined}
                        usageDetail={bi === lastTextBlockIdx ? segmentDetail : undefined}
                        compressHint={
                          bi === lastTextBlockIdx && showCompressOnThisAssistant ? compressUsagePart : undefined
                        }
                        onCompressClick={
                          showCompressOnThisAssistant && bi === lastTextBlockIdx
                            ? scrollToContextCompressAnchor
                            : undefined
                        }
                        compressAriaLabel={
                          showCompressOnThisAssistant && bi === lastTextBlockIdx
                            ? contextCompressScrollToAnchorTitle
                            : undefined
                        }
                      />
                    </View>
                  </React.Fragment>
                ) : (
                  <React.Fragment key={`msg-tool-${idx}-${bi}`}>
                    {ccInside && ccBlockInsert === bi ? (
                      <ContextCompressDividerRow
                        activeSummary={ccPl.activeSummary}
                        rawMessages={serverRawMessages}
                        anchorRef={contextCompressAnchorRef}
                      />
                    ) : null}
                    {renderToolBlock(block, `msg-tool-${idx}-${bi}`)}
                  </React.Fragment>
                );
              })}
              {ccInside &&
              Array.isArray(assistantBlocks) &&
              ccBlockInsert >= assistantBlocks.length ? (
                <ContextCompressDividerRow
                  activeSummary={ccPl.activeSummary}
                  rawMessages={serverRawMessages}
                  anchorRef={contextCompressAnchorRef}
                />
              ) : null}
              {/* 仅有工具块、无 assistant 文本时：与 Web ChatMessageList renderBlocks 一致（有重新生成和/或用量、压缩条） */}
              {lastTextBlockIdx < 0 &&
              msg.role === 'assistant' &&
              (afterUserIndex >= 0 ||
                (showTokenUsageInChat && Boolean(segmentUsage)) ||
                showCompressOnThisAssistant) ? (
                <View style={styles.assistantTextBlock}>
                  <MarkdownContent
                    text=""
                    showRegenerateButton={afterUserIndex >= 0}
                    onRegenerate={
                      afterUserIndex >= 0 ? () => handleRegenerate(afterUserIndex) : undefined
                    }
                    regenerateDisabled={!conversationId || loading || conversationHistoryLoading}
                    usageHint={showTokenUsageInChat ? segmentUsage : undefined}
                    usageDetail={showTokenUsageInChat ? segmentDetail : undefined}
                    compressHint={showCompressOnThisAssistant ? compressUsagePart : undefined}
                    onCompressClick={
                      showCompressOnThisAssistant ? scrollToContextCompressAnchor : undefined
                    }
                    compressAriaLabel={
                      showCompressOnThisAssistant ? contextCompressScrollToAnchorTitle : undefined
                    }
                  />
                </View>
              ) : null}
            </>
          ) : (
            isUser ? (
              <Text style={styles.userText} selectable>
                {msg.content}
              </Text>
            ) : (
              <>
                {ccInside && ccPl.insertBeforeBlockIndex <= 0 ? (
                  <ContextCompressDividerRow
                    activeSummary={ccPl.activeSummary}
                    rawMessages={serverRawMessages}
                    anchorRef={contextCompressAnchorRef}
                  />
                ) : null}
                <MarkdownContent
                  text={msg.content}
                  showCopyButton={isLastAssistant}
                  showRegenerateButton
                  onRegenerate={afterUserIndex >= 0 ? () => handleRegenerate(afterUserIndex) : undefined}
                  regenerateDisabled={!conversationId || loading || conversationHistoryLoading}
                  usageHint={segmentUsage}
                  usageDetail={segmentDetail}
                  compressHint={showCompressOnThisAssistant ? compressUsagePart : undefined}
                  onCompressClick={showCompressOnThisAssistant ? scrollToContextCompressAnchor : undefined}
                  compressAriaLabel={
                    showCompressOnThisAssistant ? contextCompressScrollToAnchorTitle : undefined
                  }
                />
              </>
            )
          )}
        </View>
        {isUser ? (
          <View
            style={{
              flexDirection: 'row',
              marginTop: 3,
              alignSelf: 'flex-end',
              alignItems: 'center',
            }}
          >
            <TouchableOpacity
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => Clipboard.setString(msg.content)}
              accessibilityRole="button"
              accessibilityLabel="复制用户消息"
            >
              <Ionicons name="copy-outline" size={20} color="#60a5fa" />
            </TouchableOpacity>
            <TouchableOpacity
              style={{ marginLeft: 6 }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() =>
                setUserMessageEdit({ afterIndex: userOrdinalIndex, draft: msg.content })
              }
              disabled={!conversationId || conversationHistoryLoading}
              accessibilityRole="button"
              accessibilityLabel="编辑并重新生成"
            >
              <Ionicons
                name="create-outline"
                size={20}
                color={
                  !conversationId || conversationHistoryLoading
                    ? colors.textMuted
                    : '#60a5fa'
                }
              />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );

    if (isUser) {
      return (
        <React.Fragment key={`frag-user-${idx}`}>
          {ccPl?.kind === 'beforeIndex' && ccPl.insertBeforeIndex === idx ? (
            <ContextCompressDividerRow
              activeSummary={ccPl.activeSummary}
              rawMessages={serverRawMessages}
              anchorRef={contextCompressAnchorRef}
            />
          ) : null}
          {bubble}
        </React.Fragment>
      );
    }

    return bubble;
  };

  const showEmpty =
    messages.length === 0 && !loading && !conversationHistoryLoading;
  const streamEmptyPlaceholderResume =
    v2ResumeUiActive &&
    currentAssistantBlocks.length === 0 &&
    !(streamingText && streamingText.trim());
  const streamStatusBracketLabel = streamEmptyPlaceholderResume
    ? 'resuming'
    : streamStatus === 'thinking'
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
  const streamBubblePlaceholderText = streamEmptyPlaceholderResume
    ? 'Resuming...'
    : streamStatusLabel;

  return (
    <>
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
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        {canGoBack ? (
          <TouchableOpacity
            style={styles.circleBtn}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
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
          <Ionicons name="add" size={24} color={colors.textSecondary} />
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
            onLayout={(e) => {
              scrollViewportHeightRef.current = e.nativeEvent.layout.height;
            }}
            contentContainerStyle={[
              styles.scrollContent,
              { paddingTop: headerHeight + 20, paddingBottom: scrollBottomPadding },
            ]}
            keyboardDismissMode="on-drag"
            onContentSizeChange={() => {
              if (shouldScrollToEndRef.current) {
                shouldScrollToEndRef.current = false;
                const animated = scrollToEndAnimatedRef.current;
                scrollToEndAnimatedRef.current = true;
                scrollRef.current?.scrollToEnd({ animated });
              }
            }}
            keyboardShouldPersistTaps="handled"
          >
            <View ref={chatContentWrapRef} style={styles.chatContentWrap} collapsable={false}>
            <FlowDocItemMetaProvider
              conversationId={conversationId}
              serverBaseUrl={session.server_base_url}
              accessToken={session.access_token}
            >
            {showEmpty ? (
              <View style={styles.emptyStage}>
                <Text style={styles.welcomeTitle}>Hi, {session.user_id}</Text>
                <Text style={styles.welcomeSubtitle}>输入第一句话开始对话。</Text>
              </View>
            ) : (
              <>
                {messages.map(renderMessage)}
                {contextCompressPlacement?.kind === 'afterLastVisible' && messages.length > 0 ? (
                  <ContextCompressDividerRow
                    activeSummary={contextCompressPlacement.activeSummary}
                    rawMessages={serverRawMessages}
                    anchorRef={contextCompressAnchorRef}
                  />
                ) : null}
                {/* 与 Web Chat.jsx no-assistant-reply-hint：最后一条是 user 且无流式中时，提示未回复并允许重新生成 */}
                {!conversationHistoryLoading &&
                messages.length > 0 &&
                !loading &&
                (() => {
                  const lastMsg = messages[messages.length - 1];
                  if (lastMsg.role !== 'user') return null;
                  const noReplyAfterUserIndex =
                    messages.filter((m) => m.role === 'user').length - 1;
                  if (noReplyAfterUserIndex < 0) return null;
                  const regenDisabled =
                    !conversationId || loading || conversationHistoryLoading;
                  return (
                    <View
                      key="no-assistant-reply-hint"
                      style={[styles.bubbleWrap, styles.assistantBubbleWrap]}
                    >
                      <View style={[styles.bubble, styles.assistantBubble]}>
                        <Text style={styles.bubbleRole}>{composerAgentLabel}</Text>
                        <View style={styles.assistantTextBlock}>
                          <MarkdownContent
                            text="Flops未回复任何内容"
                            showRegenerateButton
                            contentWrapperStyle={styles.assistantEmptyReplyMarkdownContent}
                            onRegenerate={() => handleRegenerate(noReplyAfterUserIndex)}
                            regenerateDisabled={regenDisabled}
                          />
                        </View>
                      </View>
                    </View>
                  );
                })()}
              </>
            )}
            {loading && !conversationHistoryLoading ? (
              <View style={[styles.bubbleWrap, styles.assistantBubbleWrap]}>
                <View style={[styles.bubble, styles.assistantBubble]}>
                  <Text style={styles.bubbleRole}>
                    {composerAgentLabel} ({streamStatusBracketLabel})
                  </Text>
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
                      <MarkdownContent text={streamingText || streamBubblePlaceholderText} />
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}
            </FlowDocItemMetaProvider>
            </View>
          </ScrollView>
          {conversationHistoryLoading ? (
            <View style={styles.historyLoadingOverlay}>
              <ActivityIndicator size="large" color={colors.textSecondary} />
            </View>
          ) : null}
          {/* 底部整块贴屏底：渐变铺满整块并延伸到底，输入行叠在渐变底部，无单独白底；点渐变区（未点到输入/发送）可滚到底 */}
          <View style={[styles.bottomOverlay, { height: bottomOverlayHeight }]}>
            <LinearGradient
              colors={chatInputOverlayGradient(colors)}
              locations={[0, 0.45, 0.7, 1]}
              style={StyleSheet.absoluteFill}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              pointerEvents="none"
            />
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}
              accessibilityRole="button"
              accessibilityLabel="滚动到对话底部"
            />
            <View style={styles.bottomOverlayInner} pointerEvents="box-none">
              <View style={styles.inputRowInOverlay} pointerEvents="box-none">
                <TextInput
                  key={composerRemountKey}
                  style={styles.composerInput}
                  value={messageInput}
                  onChangeText={setMessageInput}
                  placeholder={showEmpty ? '输入你的第一句话...' : '输入消息'}
                  placeholderTextColor={colors.placeholder}
                  editable={!loading && !conversationHistoryLoading}
                  onSubmitEditing={handleSendMessage}
                  returnKeyType="send"
                />
                <Pressable
                  style={[styles.sendBtn, loading && styles.sendBtnStop]}
                  onPress={loading ? handleStop : handleSendMessage}
                  disabled={!loading && !canSend}
                >
                  {loading ? (
                    <Ionicons name="stop" size={22} color={colors.onPrimary} />
                  ) : (
                    <Ionicons
                      name="send"
                      size={20}
                      color={
                        !canSend
                          ? isDark
                            ? colors.textMuted
                            : colors.border
                          : isDark
                            ? colors.onUserBubble
                            : colors.chatScreenBackground
                      }
                    />
                  )}
                </Pressable>
                {session ? (
                  <View style={styles.composerMetaRowAbsolute}>
                    <View style={styles.composerMetaPills}>
                      <TouchableOpacity
                        style={styles.composerMetaChip}
                        onPress={() => setModelPickerOpen(true)}
                        activeOpacity={0.7}
                        accessibilityLabel="选择模型"
                        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      >
                        <Text
                          style={styles.composerModelTriggerText}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {composerModelTriggerLabel}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                      </TouchableOpacity>
                      {showAgentComposerColumn ? (
                        agentComposerInteractive ? (
                          <TouchableOpacity
                            style={styles.composerMetaChip}
                            onPress={() => setAgentPickerOpen(true)}
                            activeOpacity={0.7}
                            accessibilityLabel="选择助手"
                            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                          >
                            <Text
                              style={styles.composerModelTriggerText}
                              numberOfLines={1}
                              ellipsizeMode="tail"
                            >
                              {composerAgentLabel}
                            </Text>
                            <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                          </TouchableOpacity>
                        ) : (
                          <View style={styles.composerMetaChipReadonly}>
                            <Text
                              style={styles.composerAgentReadonlyText}
                              numberOfLines={1}
                              ellipsizeMode="tail"
                            >
                              {composerAgentLabel}
                            </Text>
                          </View>
                        )
                      ) : null}
                    </View>
                    {showTokenUsageInChat &&
                    usageStats &&
                    conversationId &&
                    !conversationHistoryLoading ? (
                      <TouchableOpacity
                        style={styles.composerUsageInMetaRow}
                        onPress={() =>
                          setUsageDetailModalBody(
                            formatUsageHoverDetail(usageStats, {
                              currencyMode: usageCurrencyDisplay,
                              modelPriceReference,
                              selectedModelId,
                              scope: 'conversation',
                            })
                          )
                        }
                        activeOpacity={0.7}
                        accessibilityLabel="本对话用量详情"
                        hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
                      >
                        <Text
                          style={styles.composerUsageText}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {formatConversationUsageHeaderLine(usageStats, {
                            currencyMode: usageCurrencyDisplay,
                          })}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ) : null}
              </View>
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

    <ModelSelectSheet
      visible={modelPickerOpen}
      onClose={() => setModelPickerOpen(false)}
      options={modelSheetOptions}
      onSelectModel={(id) => void handleSelectModel(id)}
    />
    <ModelSelectSheet
      visible={agentPickerOpen}
      onClose={() => setAgentPickerOpen(false)}
      options={agentSheetOptions}
      sheetTitle="选择助手"
      onSelectModel={(id) => void handleSelectAgent(id)}
    />
    <UsageDetailModal
      visible={usageDetailModalBody != null}
      onClose={() => setUsageDetailModalBody(null)}
      body={usageDetailModalBody ?? ''}
    />
    <Modal
      visible={userMessageEdit != null}
      transparent
      animationType="fade"
      onRequestClose={() => setUserMessageEdit(null)}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: colors.modalBackdrop,
          justifyContent: 'center',
          padding: 20,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 520,
            alignSelf: 'center',
            backgroundColor: colors.surface,
            borderRadius: 12,
            padding: 16,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 8, color: colors.textPrimary }}>
            编辑消息
          </Text>
          <TextInput
            value={userMessageEdit?.draft ?? ''}
            onChangeText={(t) => setUserMessageEdit((prev) => (prev ? { ...prev, draft: t } : null))}
            multiline
            style={{
              alignSelf: 'stretch',
              width: '100%',
              minHeight: 120,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.borderMuted,
              borderRadius: 8,
              padding: 10,
              color: colors.textBody,
              textAlignVertical: 'top',
            }}
          />
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              alignItems: 'center',
              marginTop: 12,
            }}
          >
            <TouchableOpacity onPress={() => setUserMessageEdit(null)} accessibilityRole="button">
              <Text style={{ color: colors.textMuted, fontSize: 16, paddingVertical: 8, paddingHorizontal: 4 }}>
                取消
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ marginLeft: 16 }}
              onPress={() => {
                const st = userMessageEdit;
                if (!st?.draft.trim()) return;
                const ai = st.afterIndex;
                const d = st.draft.trim();
                setUserMessageEdit(null);
                void handleRegenerate(ai, d);
              }}
              accessibilityRole="button"
            >
              <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 16, paddingVertical: 8, paddingHorizontal: 4 }}>
                发送
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </>
  );
}

