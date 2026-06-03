import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ScrollView,
  Keyboard,
  Platform,
  Modal,
  PanResponder,
  ActivityIndicator,
  Animated,
  AppState,
  Alert,
  ActionSheetIOS,
  InteractionManager,
  Dimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import LinearGradient from 'react-native-linear-gradient';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { convProfileLog } from '../debug/conversationLoadProfile';
import { useSession } from '../context/SessionContext';
import { bytesToBase64, getCachedKAgent, getCachedKConv } from '../lib/srp';
import type { RootStackParamList } from '../navigation/types';
import {
  createConversation,
  streamChatV2Loop,
  cancelConversation,
  submitSafetyDecision,
  getConversation,
  getMessagesBefore,
  CHAT_MESSAGES_INITIAL_LIMIT,
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
  type MessageWindow,
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
  getComposerContextRingPercent,
  formatContextComposerHoverDetail,
} from '../utils/formatUsage';
import { resolveContextCompressDividerPlacement } from '../utils/contextCompress';
import { normalizeUsageCurrencyMode, type UsageCurrencyMode } from '../constants/pricingDisplay';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Svg, { Path } from 'react-native-svg';
import Clipboard from '@react-native-clipboard/clipboard';
import { MenuView } from '@react-native-menu/menu';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { MarkdownContent } from '../components/MarkdownContent';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { BouncyGlassCard } from '../components/BouncyGlassCard';
import { HEADER_CIRCLE_BTN_SIZE, bottomInsetTotal } from '../theme/layout';
import { getBottomInsetSync } from '../utils/screenInfo';
import { chatInputOverlayGradient, toolPreviewFadeGradient } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { HamburgerButton } from './shell/HamburgerButton';
import {
  AnimatedCircleButton,
  IS_IOS_LIQUID_GLASS,
} from '../components/AnimatedCircleButton';
import {
  createChatStyles,
  COMPOSER_CARD_RADIUS,
  COMPOSER_TEXT_INSET_SHORT,
  COMPOSER_TEXT_INSET_TALL,
} from './chat/ChatScreen.styles';
import { ThinkingBlockView } from './chat/ThinkingBlockView';
import { TaskEventCardView } from './chat/TaskEventCardView';
import { ComposerContextRing } from './chat/ComposerContextRing';
import { HistoryLoadingOverlay } from './chat/HistoryLoadingOverlay';
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
import { FlowDocSlateAdapter, type SlateDocument } from '../flowdoc-native-input';
import type { FlowDocInputHandle } from '../flowdoc-native-input';
import {
  hydrateUserMessageToSlateDocument,
  serializeSlateDocumentToUserMessage,
  buildFlowDocFullRef,
  type FlopsRef,
} from '../chat/flopsRefs';
import { UserMessageContent } from '../chat/UserMessageContent';
import { FlowDocPickerModal } from '../chat/FlowDocPickerModal';
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

/* 闭合思考块作为前驱：下一段 markdown 文本应贴紧（对齐 FlopsWeb
   .tool-cards-wrap > .thinking-block.closed + .assistant-text-block 的紧凑处理） */
function isClosedThinkingBlock(b: {
  type: string;
  closed?: boolean;
}): boolean {
  return b.type === 'thinking' && b.closed === true;
}

/** lucide Package icon path（与 FlopsWeb ToolPackageNav 用的同一组路径） */
function PackageIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <Path d="M12 22V12" />
      <Path d="m3.3 7 7.703 4.734a2 2 0 0 0 2 0L20.7 7" />
      <Path d="m7.5 4.27 9 5.15" />
    </Svg>
  );
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
    // task_event（后台任务灰条）按边界保留，避免流式时被截掉
    if (messages[i].role === 'user' || messages[i].role === 'task_event') lastUserIdx = i;
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

/** 从 DrawerShell 直接渲染时透传的覆盖参数：
 *  - inDrawer = 顶层页模式，header 左上角换汉堡（开抽屉），不挂左缘 PanResponder（避免与 DrawerShell 左缘手势冲突）。
 *  - conversationIdOverride / conversationTitleOverride 取代 route.params；route.params 在 stack-push 模式下仍是入口。
 */
export type ChatScreenProps = {
  inDrawer?: boolean;
  conversationIdOverride?: string;
  conversationTitleOverride?: string;
  /** true 时：新建对话走加密路径（POST /api/conversations 带 encrypted+k_conv_blob） */
  createEncrypted?: boolean;
};

export function ChatScreen({
  inDrawer = false,
  conversationIdOverride,
  conversationTitleOverride,
  createEncrypted = false,
}: ChatScreenProps = {}) {
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Chat'>>();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createChatStyles(colors), [colors]);
  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  /** 底部渐变条高度（叠在滚动内容上，透明→白） */
  const gradientStripHeight = 48;
  /** 输入行高度（输入框+发送+底部留白，模型/助手条绝对叠在留白内，不把整块顶上去） */
  const inputRowHeight = 92;
  /* 键盘避让（react-native-keyboard-controller frame-perfect 路径）。
   * KAV (lib 版): 跟 RN 原生 KAV 同 API，但走 native frame timing (iOS UIKeyboardLayoutGuide /
   * Android WindowInsetsCompat.Type.ime)。ScrollView (flex:1) 缩小、composer 抬升全程跟键盘
   * 逐帧 sync，不再走 React render cycle，无 RN 0.84 / 新架构那波时序卡顿。
   *
   * useReanimatedKeyboardAnimation: keyboard frame SharedValue（height **负数** offset 语义,
   * -300 = 键盘 300pt 高）。 */
  const { height: kbAnimHeight } = useReanimatedKeyboardAnimation();
  /* JS 端的键盘开/关 boolean：JSX conditional rendering 用（隐藏 meta row + composer card
   * marginBottom 18→8）。SharedValue 在 UI 线程读不到 JSX 条件，所以保留这条 state，但只用
   * Keyboard.addListener 切 boolean，不再驱动 SharedValue。 */
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, () => setKeyboardOpen(true));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardOpen(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  /* 底部 inset：edge-to-edge 下 SafeAreaView 不再吃 bottom（否则导航栏后面糊一条纯白 padding 带、
   * 跟内容割裂）。改成把 inset 让给 bottomOverlay —— 渐变铺到屏幕物理底边、盖在透明导航栏后面，
   * 输入簇 (bottomOverlayInner) 整块抬 navInset 避开三键导航 / 屏底。bottomInsetTotal 按设备安全区
   * inset 自动给出总间距（含无真实安全区设备 —— 安卓无 bar、iOS home 键/方形屏 —— 的兜底下限+间距）。
   * 键盘弹起时 lib KAV 已按 ime 高度抬升、导航栏被键盘盖住，这时 navInset 归零避免叠加偏高。 */
  /* 底部 inset：safe-area-context 首帧上报 0（安卓 edge-to-edge 已知），会让 composer 先贴底再上移。
   * 安卓用 native 同步值兜首帧（render 时窗口已就绪，可靠）；keyed on insets.bottom 重读以跟随导航模式
   * 切换 / 转屏。iOS getBottomInsetSync 返回 null → 用 safe-area（配 initialWindowMetrics 已无首帧闪）。 */
  const bottomInset = useMemo(() => {
    const sync = getBottomInsetSync();
    return sync != null ? sync : insets.bottom;
  }, [insets.bottom]);
  /** 键盘收起时输入簇要抬起的底部间距（导航栏 / 安全区）。不再依赖 keyboardOpen state —— 改由下面
   *  navInsetAnimStyle 在 UI 线程随键盘高度插值，避免长对话页 React 重渲染慢导致"偏移非常延迟"。 */
  const restingNavInset = bottomInsetTotal(bottomInset);
  /** 底部整块高度：渐变 + 输入区 + 导航栏 inset（恒为 resting 值，不随键盘变 → 不触发重渲染） */
  const bottomOverlayHeight = gradientStripHeight + inputRowHeight + restingNavInset;
  /** 列表底部留白，让内容可滚入渐变下方 */
  const scrollBottomPadding = bottomOverlayHeight + 12;
  /* bottomOverlay 的 bottom 偏移：iOS 完全由 lib KAV 缩 scrollAndGradientWrap (flex:1) 自动上浮
   * (base=0)；Android lib KAV 同样接管几何，base=0 即可（之前 RN KAV 在 Android adjustResize
   * 下 absolute children 飘忽，那条手挂 h offset 是兜底）。lib 两端统一 native 接管。 */
  const kbBottomStyle = useAnimatedStyle(() => {
    return { bottom: 0 };
  });
  /* 输入簇 (bottomOverlayInner) 的 bottom 偏移：纯 UI 线程，随键盘高度从 restingNavInset → 0 插值。
   * 键盘抬升由 lib KAV 缩 scrollAndGradientWrap 出（已含键盘高度），这里再叠 max(0, restingNavInset
   * - kbHeight)：键盘没盖住导航栏区时补足 navInset，盖住后归 0，净位置 = max(键盘高, restingNavInset)。
   * 之前用 keyboardOpen state 驱动 navInset(48→0)，长对话页要等慢重渲染才偏移 → 明显延迟；改 worklet
   * 跟 kbAnimHeight 逐帧同步，与重渲染解耦。 */
  const navInsetAnimStyle = useAnimatedStyle(() => {
    const kbHeight = -kbAnimHeight.value; // 0=收起，正值=键盘高度
    return { bottom: Math.max(0, restingNavInset - kbHeight) };
  });
  /* Meta row 的淡出：opacity 跟键盘动画绑，键盘弹起 → 渐淡出消失。lib height 是负数，- 它转正。 */
  const kbMetaRowStyle = useAnimatedStyle(() => {
    const h = -kbAnimHeight.value;
    const ratio = Math.min(h / 50, 1);
    return { opacity: 1 - ratio };
  });
  /** drawer 模式下用 props 覆盖；stack-push 模式下读 route.params */
  const params: ChatRouteParams | undefined = inDrawer
    ? {
        conversationId: conversationIdOverride,
        conversationTitle: conversationTitleOverride,
      }
    : ((route.params ?? undefined) as ChatRouteParams | undefined);
  const [conversationId, setConversationId] = useState(params?.conversationId ?? '');
  const [conversationTitle, setConversationTitle] = useState(params?.conversationTitle ?? '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverRawMessages, setServerRawMessages] = useState<ConversationMessage[]>([]);
  /** 消息窗口元数据（尾窗拉取时由 getConversation/getMessagesBefore 返回）；null = 全量（无窗口）。
   *  contextCompress 坐标变换 / regenerate 全局序号 / 滚到顶加载更旧 都读它。 */
  const [messageWindowMeta, setMessageWindowMeta] = useState<MessageWindow | null>(null);
  /** 最新值镜像 ref：供 handleRegenerate 等 useCallback 读 userCountBefore，不必进依赖。 */
  const messageWindowMetaRef = useRef<MessageWindow | null>(null);
  messageWindowMetaRef.current = messageWindowMeta;
  /** 加载更旧分页用的 refs（滚动锚定 / 防抖）；serverRawMessages 镜像供 prepend 读最新值不进依赖。 */
  const serverRawMessagesRef = useRef<ConversationMessage[]>([]);
  const scrollOffsetYRef = useRef(0);
  const scrollContentHeightRef = useRef(0);
  const loadingOlderRef = useRef(false);
  /** 防抖:顶部触发过一次加载后置 true，直到用户滚离顶部(y>300)才重新武装，避免一次滚动连环触发多批。 */
  const nearTopTriggeredRef = useRef(false);
  /** 加载更旧时顶部转圈（state 驱动渲染；loadingOlderRef 用于防抖，不触发 re-render）。 */
  const [loadingOlder, setLoadingOlder] = useState(false);
  serverRawMessagesRef.current = serverRawMessages;
  /** 已完整 GET 加载过的会话 id：路由 effect 因别的依赖抖动 re-fire 时跳过重拉重解密（对齐 web）。 */
  const loadedConversationIdRef = useRef<string | null>(null);
  const [contextSummaries, setContextSummaries] = useState<ContextSummary[]>([]);
  const [activeContextSummaryId, setActiveContextSummaryId] = useState('');
  /** 后端按需返回的上下文 L1 投影；composer 旁环形进度条算"已用比例"用 */
  const [contextProjectionL1, setContextProjectionL1] = useState<Record<string, unknown> | null>(null);
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
  /** runV2WithHandlers 是 useCallback([session, ...])，里头读 conversationMeta 不稳；
   *  用 ref 把最新 meta 镜像出来给 streamChatV2Loop 的 agentEncryption 选项。 */
  const conversationMetaRef = useRef(conversationMeta);
  useEffect(() => {
    conversationMetaRef.current = conversationMeta;
  }, [conversationMeta]);
  /** Bottom sheet 用量详情：null = 关；对象里 body 必填，title / actionLabel / onAction 可选。
   *  从 stats icon 入口打开时只传 body；从环形进度条入口打开时传 title="上下文用量" +
   *  当存在压缩摘要时再带 actionLabel "跳转到压缩截断位置" + onAction = 滚动到那里。 */
  const [usageDetailModalState, setUsageDetailModalState] = useState<{
    title?: string;
    body: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);
  /** 编辑用户消息后重新生成（与 Web/Desktop 一致） */
  const [userMessageEdit, setUserMessageEdit] = useState<{
    afterIndex: number;
    /** 用 SlateDocument 而不是 string，让 pill 编辑可行 */
    initialDoc: SlateDocument;
    /** 编辑过程中维护的 ref key → 完整记录映射；发送时按此重组 flops_refs */
    refDataByKey: Map<string, FlopsRef>;
  } | null>(null);
  /** 编辑 Modal 内 FlowDocSlateAdapter 的当前 SlateDocument，发送时序列化用 */
  const userMessageEditDocRef = useRef<SlateDocument | null>(null);
  /** 编辑 Modal 内 FlowDocSlateAdapter 的 imperative handle（focus / insertPill 等） */
  const userMessageEditAdapterRef = useRef<FlowDocInputHandle | null>(null);
  /** 主 composer：SlateDocument 状态 + flops_refs 表 */
  const [composerDoc, setComposerDoc] = useState<SlateDocument>([
    { type: 'paragraph', children: [{ text: '' }] },
  ]);
  const composerRefDataByKeyRef = useRef<Map<string, FlopsRef>>(new Map());
  const composerAdapterRef = useRef<FlowDocInputHandle | null>(null);
  /* composer 是原生 FlowDocInputView（UITextView / EditText），不在 RN TextInputState 注册
   * 表里——Keyboard.dismiss() 找不到 first responder，且会另起一条 keyboard-will-hide 通知
   * 流跟 native blur 的键盘动画打架，所以这里只调 native blur。 */
  const dismissComposer = useCallback(() => {
    composerAdapterRef.current?.blur();
  }, []);
  const focusComposer = useCallback(() => {
    composerAdapterRef.current?.focus();
  }, []);
  /* Android composer 卡片按下放大 —— 跟 TodayScreen 搜索框胶囊同款 RNGH LongPress + worklet
   * spring scale。Tap 在 EditText 区域容易被 native gesture 抢 ownership 提前打断，所以
   * 用 LongPress；minDuration(0) 立即 active，maxDistance / shouldCancelWhenOutside
   * 放宽避免微移动触发 cancel。iOS 26 走 BouncyGlassCard 系统接管，不在这里管。 */
  const composerPressScale = useSharedValue(1);
  const composerPressAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: composerPressScale.value }],
  }));
  /* composer 卡片按下放大用 RN raw onTouch* 而不是 RNGH（跟 TodayScreen 搜索框同样
   * 理由：Gesture.Manual 不 activate 在 EditText activate native gesture 后会被
   * cancel → spring 提前 down，按住保持不住放大）。raw onTouch* 独立于 responder
   * system / native gesture ownership，FlowDocInputView 内部 cursor placement /
   * 双击选词 / set selection 不被影响。 */
  const onComposerTouchStart = useCallback(() => {
    composerPressScale.value = withSpring(1.1, { mass: 1, stiffness: 400, damping: 40 });
  }, [composerPressScale]);
  const onComposerTouchEnd = useCallback(() => {
    composerPressScale.value = withSpring(1, { mass: 1, stiffness: 220, damping: 14 });
    focusComposer();
  }, [composerPressScale, focusComposer]);
  const onComposerTouchCancel = useCallback(() => {
    composerPressScale.value = withSpring(1, { mass: 1, stiffness: 220, damping: 14 });
  }, [composerPressScale]);
  const [composerPickerOpen, setComposerPickerOpen] = useState(false);
  /** 编辑 Modal 内是否打开 picker（与主 composer 用同一个 modal 不同 ref 表） */
  const [editPickerOpen, setEditPickerOpen] = useState(false);
  /** picker dismiss 之后是否要把 firstResponder 还给对应 adapter。
   *  在 onPickDoc 里置 true，在 onAfterDismiss 里读 + 触发 focus 后清回 false。 */
  const pendingComposerFocusRef = useRef(false);
  const pendingEditFocusRef = useRef(false);
  /** 回到本页时强制重建输入框，避免多行/高度在其它页编辑后残留 */
  const [composerRemountKey, setComposerRemountKey] = useState(0);
  const [loading, setLoading] = useState(false);
  /** 仅从路由拉取对话历史（GET conversation）期间，与流式 loading 分离 */
  /** 初值 = 有 conversationId 时直接 true：避免页面切换那一帧 useEffect 还没跑、
   *  composer 短暂从渐变里"露脸"再被 loading overlay 盖上。
   *  无 conversationId（新对话）时不需要拉历史，初值 false。 */
  const [conversationHistoryLoading, setConversationHistoryLoading] = useState(
    () => !!params?.conversationId,
  );
  /** 正在执行 resumeV2Stream（含 AppState 恢复），用于空占位文案显示 Resuming... */
  const [v2ResumeUiActive, setV2ResumeUiActive] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  /** server SIGTERM 期间收到 v2_reload_pending：消息流末尾显示「服务器热更新中」banner，
   *  下一次 fetch 收到任意非 reload_pending 事件时清掉。 */
  const [reloadPending, setReloadPending] = useState(false);
  const [currentAssistantBlocks, setCurrentAssistantBlocks] = useState<StreamBlock[]>([]);
  const [error, setError] = useState('');
  const [submittingReviewId, setSubmittingReviewId] = useState('');
  /** 工具卡片展示状态：key -> 'collapsed' | 'preview' | 'full' */
  const [toolCardViewMode, setToolCardViewMode] = useState<Record<string, 'collapsed' | 'preview' | 'full'>>({});
  /** local_exec_command 执行中时每秒 +1，用于刷新耗时显示 */
  const [runningExecTick, setRunningExecTick] = useState(0);
  /** read_page_subagent 点击某条条目后打开的详情 Sheet（与 Task 页筛选同款 BottomSheetModal） */
  const [readPagesModalEntry, setReadPagesModalEntry] = useState<{
    cardKey: string;
    entryKey: string;
    entry: Record<string, unknown>;
  } | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  /** ScrollView 可视区域高度，用于把摘要分界滚到竖直方向居中 */
  const scrollViewportHeightRef = useRef(0);
  /** 摘要分界行原生节点，用于 measureLayout 相对 ScrollView 内容容器得到可 scrollTo 的偏移 */
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

  const applyConversationUsageState = useCallback(
    (conversation: Conversation, messagesWindow?: MessageWindow | null) => {
    const raw =
      conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
    setServerRawMessages(raw);
    /* 窗口元数据：所有"拉会话→应用到 state"的入口（路由打开 + 各 sync/resume）都经此函数，
     * 在这里统一 setMessageWindowMeta，避免 7 处各写一遍。传 undefined 时不动（少数不带窗口的调用）。 */
    if (messagesWindow !== undefined) {
      setMessageWindowMeta(messagesWindow);
    }
    setUsageStats(conversation.usage_stats ?? null);
    setUsageRuns(Array.isArray(conversation.usage_runs) ? conversation.usage_runs : []);
    const sums = conversation.context_summaries;
    setContextSummaries(Array.isArray(sums) ? sums : []);
    const aid = conversation.active_context_summary_id;
    setActiveContextSummaryId(typeof aid === 'string' ? aid.trim() : '');
    const proj = conversation.context_projection_l1;
    setContextProjectionL1(proj && typeof proj === 'object' ? proj : null);
    const nextMeta = {
      bound_agent_id: typeof conversation.bound_agent_id === 'string' ? conversation.bound_agent_id : undefined,
      agent_profile: conversation.agent_profile,
    };
    /* 同步写 ref：路由打开/前台恢复时会在同 microtask 里紧接调 resumeV2Stream → runV2WithHandlers
       同步读 conversationMetaRef，靠 useEffect 镜像太晚——会漏掉 agentEncryption，导致加密 agent
       的 chat_v2 POST 缺 k_agent_wire，server 返 400。 */
    conversationMetaRef.current = nextMeta;
    setConversationMeta(nextMeta);
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
        // 尾窗模式：serverRawMessages 只是窗口，把 covers_exclusive_end 的全局坐标换算到窗口内
        rawViewOffset: messageWindowMeta?.viewStart ?? 0,
        rawTotal: messageWindowMeta?.total ?? serverRawMessages.length,
      }),
    [messages.length, serverRawMessages, contextSummaries, activeContextSummaryId, messageWindowMeta]
  );

  const contextCompressScrollToAnchorTitle = '滚动到「摘要」位置（列表中间）';

  const scrollToContextCompressAnchor = useCallback(() => {
    const divider = contextCompressAnchorRef.current;
    const sv = scrollRef.current;
    // 去掉 chatContentWrap 后，measureLayout 的参照改用 ScrollView 内容容器节点（即 contentContainerStyle
    // 那个 View）。相对它的 top 已含 contentContainer 的 paddingTop，等于该分界在滚动内容里的偏移。
    const innerNode = sv?.getInnerViewNode?.();
    if (!divider || !sv || innerNode == null) return;
    const runMeasure = () => {
      divider.measureLayout(
        innerNode,
        (_left, top, _width, height) => {
          const dividerCenter = top + Math.max(0, height) / 2;
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
  }, []);

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

  /** 草稿页默认选中列表首项（GET agent-ids 顺序，用户可在设置中调整） */
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

  /** 主 composer 状态：可发送 / 是否含 pill / 文本总长度 / CJK 字符数。
   *  发送靠键盘 Return，没有发送按钮；这些 flags 给布局切换用。 */
  const composerStats = useMemo(() => {
    let hasContent = false;
    let hasPill = false;
    let textLen = 0;
    let cjkCount = 0;
    for (const para of composerDoc) {
      for (const node of para.children) {
        const anyN = node as Record<string, unknown>;
        if (anyN.type === 'ref-pill') {
          hasPill = true;
          hasContent = true;
          continue;
        }
        if (typeof anyN.text === 'string') {
          const text = anyN.text;
          textLen += text.length;
          /* CJK：U+3400-9FFF（统一汉字 + 扩展 A）+ U+F900-FAFF（兼容汉字）覆盖
           * 常用中日韩文字。中文一字 ≈ 拉丁两字宽，单独计数用于切 tall 阈值。 */
          for (const ch of text) {
            const code = ch.codePointAt(0) ?? 0;
            if (
              (code >= 0x3400 && code <= 0x9fff) ||
              (code >= 0xf900 && code <= 0xfaff)
            ) {
              cjkCount++;
            }
          }
          if (text.trim().length > 0) hasContent = true;
        }
      }
    }
    return { hasContent, hasPill, textLen, cjkCount };
  }, [composerDoc]);

  /** 切两行布局：有 pill / 多段 / CJK 字符 > 15 / 总长 > 30。CJK 字符宽度 ≈ 拉丁两字,
   *  所以中文阈值收到 15、其它字符放到 30 让两种语境都自然换行。 */
  const composerTall =
    composerStats.hasPill ||
    composerDoc.length > 1 ||
    composerStats.cjkCount > 15 ||
    composerStats.textLen > 30;

  const canSend = Boolean(
    session && composerStats.hasContent && !loading && !conversationHistoryLoading
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

      const appendThinkingChunk = (chunk: string) => {
        if (!chunk) return;
        const last = localBlocks[localBlocks.length - 1];
        if (last && last.type === 'thinking' && !last.closed) {
          last.content += chunk;
        } else {
          localBlocks.push({
            type: 'thinking',
            content: chunk,
            closed: false,
            startedAt: Date.now(),
          });
        }
        syncBlocks();
      };

      const closeOpenThinking = () => {
        const last = localBlocks[localBlocks.length - 1];
        if (last && last.type === 'thinking' && !last.closed) {
          last.closed = true;
          syncBlocks();
        }
      };

      const onEvent = (event: ChatStreamEvent) => {
        /* Phase 4 reload-pending：必须在所有 early return（v2_run / 错误 / etc）之前处理。
           reload reconnect 后 buffer replay 第一条往往是 v2_run，会被下面 early return 吞掉，
           如果 setReloadPending(false) 放后面就永远清不掉 banner。 */
        if ('type' in event && event.type === 'v2_reload_pending') {
          setReloadPending(true);
          return;
        }
        setReloadPending(false);
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
          /* Phase 4 reload-pending：server SIGTERM 时主动通知；UI 显示「服务器热更新中」banner，
             API 层自动断开 reader 进入 reconnect 等 server 起来。任何后续 chunk（包括 v2_step_rollback
             或新内容）来时把 banner 清掉。 */
          if (event.type === 'v2_reload_pending') {
            setReloadPending(true);
            return;
          }
          if (reloadPending) setReloadPending(false);
          if (event.type === 'thinking') setStreamStatus('thinking');
          if (event.type === 'thinking_delta') {
            setStreamStatus('thinking');
            const ev = event as { content?: string };
            appendThinkingChunk(typeof ev.content === 'string' ? ev.content : '');
          }
          if (event.type === 'checking_tools') setStreamStatus('checking_tools');
          if (event.type === 'tool_call_start') {
            closeOpenThinking();
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
                pages_by_url: event.pages_by_url,
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
                  const { conversation, messagesWindow } = await getConversation(session, cid, CHAT_MESSAGES_INITIAL_LIMIT);
                  applyConversationUsageState(conversation, messagesWindow);
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
            // 优先按 index 精准命中，避免并行多工具时落到错的卡上；老服务端不带 index 时回退按 tool_name 找
            let attachedIdx = -1;
            if (typeof event.index === 'number') {
              const ix = findLastToolBlockByIndex(event.index);
              if (ix >= 0) attachedIdx = ix;
            }
            if (attachedIdx < 0) {
              for (let i = localBlocks.length - 1; i >= 0; i--) {
                const b = localBlocks[i];
                if (b.type === 'tool' && b.tool_name === name) {
                  attachedIdx = i;
                  break;
                }
              }
            }
            if (attachedIdx >= 0) {
              const b = localBlocks[attachedIdx];
              if (b.type === 'tool') {
                const merged = mergeToolBlockResultForSafetyEvent(b.result, event);
                localBlocks[attachedIdx] = {
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
        /* 兜底「OpenAI 风格无 type 字段的原始 chunk = 正文 text」路径；
           有 type 的事件（thinking_delta / tool_* / 等）已在上面的 if ('type' in event) 分支处理完，
           不能落到这里——否则 thinking_delta 会被当成正文，正文流被 closeOpenThinking 打散成
           每个 delta 一段的鬼畜版式（且 thinking 块立刻被关闭 → 短思考默认隐藏 → 看不见）。 */
        if (!('type' in event) && 'content' in event && typeof event.content === 'string' && event.content.length > 0) {
          setStreamStatus('streaming_text');
          closeOpenThinking();
          const last = localBlocks[localBlocks.length - 1];
          if (last && last.type === 'text') {
            last.content += event.content;
          } else {
            localBlocks.push({ type: 'text', content: event.content });
          }
          syncBlocks();
        }
        if ('done' in event && event.done === true) {
          streamDone = true;
          closeOpenThinking();
        }
      };

      /** 与 FlopsWeb Chat.jsx 一致：用本轮固定的 convId 判断存活；勿与 streamTargetRef 比（首包前 ref 可能尚未随 setState 同步） */
      const streamSessionConvId = opts.convId;
      /** 加密 agent 时，把 bound_agent_id + k_agent_blob 喂给 streamChatV2Loop，
       *  让它自动派生 K_agent 并拼 k_agent_wire（server 强制 400 兜底）。 */
      const _meta = conversationMetaRef.current;
      const _aid = String(_meta?.bound_agent_id || _meta?.agent_profile?.agent_id || '').trim();
      const _agentEnc =
        _aid && _meta?.agent_profile?.encrypted
          ? {
              agentId: _aid,
              kAgentBlobB64: _meta.agent_profile.k_agent_blob ?? null,
            }
          : undefined;
      await streamChatV2Loop(session, streamTargetRef.current, opts.start, onEvent, opts.signal, {
        isAlive: () => conversationIdRef.current === streamSessionConvId && !opts.signal.aborted,
        agentEncryption: _agentEnc,
      });

      return { streamDone, finalText, localBlocks, lastConvId: streamTargetRef.current };
    },
    [session, applyConversationUsageState]
  );

  const handleSendMessage = useCallback(async () => {
    if (!session || !composerStats.hasContent || loading || conversationHistoryLoading) return;
    /* 序列化 composerDoc → content（pill 还原为 mention_text）+ flops_refs（按 pill 出现顺序） */
    const { content: rawContent, flops_refs } = serializeSlateDocumentToUserMessage(
      composerDoc,
      composerRefDataByKeyRef.current,
    );
    const nextMessage = rawContent.trim();
    if (!nextMessage && flops_refs.length === 0) return;
    /* 清空 composer：把 SlateDocument 重置为单段空 paragraph，refDataByKey 清空，再 bump key 强制 remount native */
    setComposerDoc([{ type: 'paragraph', children: [{ text: '' }] }]);
    composerRefDataByKeyRef.current = new Map();
    setComposerRemountKey((n) => n + 1);
    setError('');
    setLoading(true);
    setStreamingText('');
    setCurrentAssistantBlocks([]);
    setStreamStatus('thinking');
    setMessages((prev) => [
      ...prev,
      flops_refs.length > 0
        ? { role: 'user', content: nextMessage, flops_refs }
        : { role: 'user', content: nextMessage },
    ]);
    shouldScrollToEndRef.current = true;

    let convId = conversationId;
    if (!convId) {
      try {
        const bid = String(draftAgentId || '').trim();
        const opts: { bound_agent_id?: string; encrypted?: boolean } = {};
        if (bid) opts.bound_agent_id = bid;
        if (createEncrypted) opts.encrypted = true;
        const { id } = await createConversation(session, Object.keys(opts).length ? opts : undefined);
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
        start: { tag: 'new_message', message: nextMessage, flops_refs },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const syncId = lastConvId;
      try {
        if (session) {
          const { conversation, messagesWindow } = await getConversation(session, syncId, CHAT_MESSAGES_INITIAL_LIMIT);
          applyConversationUsageState(conversation, messagesWindow);
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
    composerDoc,
    composerStats.hasContent,
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
  /** 用户气泡长按 → 弹出系统 ActionSheet（iOS 原生 / Android Alert 化）：复制 / 编辑并重新生成 */
  const presentUserMessageActions = useCallback(
    (content: string, userOrdinalIndex: number, refs?: FlopsRef[]) => {
      const canEdit = !!conversationId && !conversationHistoryLoading;
      const onCopy = () => Clipboard.setString(content);
      const onEdit = () => {
        const refList = refs ?? [];
        const refMap = new Map<string, FlopsRef>();
        for (const r of refList) refMap.set(r.key, r);
        setUserMessageEdit({
          afterIndex: userOrdinalIndex,
          initialDoc: hydrateUserMessageToSlateDocument(content, refList),
          refDataByKey: refMap,
        });
        userMessageEditDocRef.current = null;
      };
      if (Platform.OS === 'ios') {
        const options = canEdit ? ['取消', '复制', '编辑消息'] : ['取消', '复制'];
        ActionSheetIOS.showActionSheetWithOptions(
          { options, cancelButtonIndex: 0 },
          (i) => {
            if (i === 1) onCopy();
            else if (i === 2 && canEdit) onEdit();
          }
        );
      } else {
        const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'default' }[] = [
          { text: '取消', style: 'cancel' },
          { text: '复制', onPress: onCopy },
        ];
        if (canEdit) buttons.push({ text: '编辑消息', onPress: onEdit });
        Alert.alert('消息操作', undefined, buttons);
      }
    },
    [conversationId, conversationHistoryLoading]
  );

  const handleRegenerate = useCallback(
    async (
      afterUserIndex: number | null,
      editedMessage?: string,
      editedFlopsRefs?: FlopsRef[],
      reprocessTaskId?: string,
    ) => {
      const reprocTid = typeof reprocessTaskId === 'string' ? reprocessTaskId.trim() : '';
      if (
        !session ||
        !conversationId ||
        conversationHistoryLoading ||
        (afterUserIndex == null && !reprocTid)
      )
        return;
      if (editedMessage === undefined && loading) return;
      if (editedMessage !== undefined && loading) {
        await handleStop();
      }
      setMessages((prev) => {
        let keepThroughIdx = -1;
        if (reprocTid) {
          for (let i = 0; i < prev.length; i++) {
            const m = prev[i] as { role?: string; task_event?: { task_id?: string } };
            if (m?.role === 'task_event' && m?.task_event && m.task_event.task_id === reprocTid) {
              keepThroughIdx = i;
              break;
            }
          }
        } else {
          let userCount = 0;
          for (let i = 0; i < prev.length; i++) {
            if (prev[i].role === 'user') {
              userCount++;
              if (userCount === (afterUserIndex as number) + 1) {
                keepThroughIdx = i;
                break;
              }
            }
          }
        }
        if (keepThroughIdx < 0) return prev;
        const sliced = prev.slice(0, keepThroughIdx + 1);
        if (editedMessage === undefined) return sliced;
        return sliced.map((m, i) => {
          if (i !== keepThroughIdx || m.role !== 'user') return m;
          const next: typeof m = { role: 'user', content: editedMessage };
          if (editedFlopsRefs && editedFlopsRefs.length > 0) {
            next.flops_refs = editedFlopsRefs;
          }
          return next;
        });
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
      /* server 的 after_user_index 按全量会话的非-meta user 序号算；本地 afterUserIndex 是在
       * 当前窗口(尾窗)上数的，要把窗口前缀里的 user 数(userCountBefore)补回去还原成全局序号。
       * 非尾窗(全量)时 userCountBefore=0，等价旧行为。 */
      const globalAfterUserIndex =
        (afterUserIndex as number) + (messageWindowMetaRef.current?.userCountBefore ?? 0);
      const regenStart: ChatV2StreamStart = reprocTid
        ? { tag: 'regenerate', regenerate_after_task_id: reprocTid }
        : editedMessage !== undefined
          ? {
              tag: 'regenerate',
              after_user_index: globalAfterUserIndex,
              message: editedMessage,
              ...(editedFlopsRefs && editedFlopsRefs.length > 0
                ? { flops_refs: editedFlopsRefs }
                : {}),
            }
          : { tag: 'regenerate', after_user_index: globalAfterUserIndex };
      const { streamDone, finalText, localBlocks, lastConvId } = await runV2WithHandlers({
        convId: conversationId,
        start: regenStart,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const syncId = lastConvId;
      try {
        if (session) {
          const { conversation, messagesWindow } = await getConversation(session, syncId, CHAT_MESSAGES_INITIAL_LIMIT);
          applyConversationUsageState(conversation, messagesWindow);
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

  /** 对话头部 ⋯ 菜单各 item 的处理逻辑。
   *  iOS 走 MenuView（UIMenu 原生毛玻璃 + 系统动画）；Android 走自绘 Modal popover
   *  （Material PopupMenu 渲染 SF Symbol image 跟我们其它视觉对不齐，所以自己画）。 */
  const handleConvInfo = useCallback(() => {
    if (!conversationId) return;
    const meta = conversationMetaRef.current;
    const isEncrypted = Boolean(getCachedKConv(conversationId));
    const boundAgentId = String(meta?.bound_agent_id || meta?.agent_profile?.agent_id || '').trim();
    const lines: string[] = [];
    lines.push(`对话 ID：${conversationId}`);
    lines.push(`加密状态：${isEncrypted ? '端到端加密' : '明文'}`);
    if (boundAgentId) {
      const dn = (meta?.agent_profile?.display_name || '').trim();
      lines.push(`绑定 Agent：${dn ? `${dn}（${boundAgentId}）` : boundAgentId}`);
      if (meta?.agent_profile?.encrypted) lines.push('Agent 印象段：端到端加密');
    }
    Alert.alert('对话信息', lines.join('\n'));
  }, [conversationId]);

  const handleConvDiagCopy = useCallback(() => {
    if (!conversationId) return;
    const meta = conversationMetaRef.current;
    const boundAgentId = String(meta?.bound_agent_id || meta?.agent_profile?.agent_id || '').trim();
    const payload: Record<string, unknown> = {
      schema_version: 1,
      conv_id: conversationId,
      user_id: session?.user_id || null,
      bound_agent_id: boundAgentId || null,
      exported_at: new Date().toISOString(),
    };
    try {
      const kc = getCachedKConv(conversationId);
      if (kc) payload.k_conv_b64 = bytesToBase64(kc);
      if (boundAgentId) {
        const ka = getCachedKAgent(boundAgentId);
        if (ka) payload.k_agent_b64 = bytesToBase64(ka);
      }
    } catch {
      /* 缓存里没就不带 K_*，至少 conv_id / user_id 指针还能给开发者用 */
    }
    const jsonStr = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(jsonStr);
    const blob = 'flops-diag:v1:' + bytesToBase64(bytes);
    Clipboard.setString(blob);
    Alert.alert('诊断资料已复制', '请发给开发者（含本对话标识与本机持有的密钥；非加密对话不含密钥）');
  }, [conversationId, session]);

  /** iOS MenuView 的 actions（SF Symbol image），id → handler 分发 */
  const convMenuActions = useMemo(
    () => [
      { id: 'info', title: '对话信息', image: 'info.circle' },
      { id: 'diag', title: '复制诊断资料', image: 'doc.on.clipboard' },
    ],
    [],
  );
  const onConvMenuPressAction = useCallback(
    (e: { nativeEvent: { event: string } }) => {
      const id = e.nativeEvent.event;
      if (id === 'info') handleConvInfo();
      else if (id === 'diag') handleConvDiagCopy();
    },
    [handleConvInfo, handleConvDiagCopy],
  );

  /** iOS MenuView 是 native UIButton.menu，press 事件抢不到，只能拿
   *  onOpenMenu / onCloseMenu 当 down/up 信号。spring 参数跟 AnimatedCircleButton
   *  对齐：按下放大到 1.12（紧、无 overshoot），关闭时回 1（一次 overshoot 再静下来）。 */
  const convMenuBtnScale = useRef(new Animated.Value(1)).current;
  const animateConvMenuPressDown = useCallback(() => {
    try {
      ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
    } catch {
      /* ignore */
    }
    Animated.spring(convMenuBtnScale, {
      toValue: 1.12,
      useNativeDriver: true,
      friction: 14,
      tension: 220,
    }).start();
  }, [convMenuBtnScale]);
  const animateConvMenuPressUp = useCallback(() => {
    Animated.spring(convMenuBtnScale, {
      toValue: 1,
      useNativeDriver: true,
      friction: 5.5,
      tension: 200,
    }).start();
  }, [convMenuBtnScale]);

  /** Android ⋯ 菜单：常驻 mount + SharedValue 驱动 opacity/scale/pointerEvents，跟
   *  TodayScreen FAB 菜单同款实现，消除 conditional mount / Modal 启动延迟。 */
  const [convMenuOpen, setConvMenuOpen] = useState(false);
  const convMenuShow = useSharedValue(0);
  const convMenuCardAnimStyle = useAnimatedStyle(() => ({
    opacity: convMenuShow.value,
    transform: [{ scale: 0.1 + convMenuShow.value * 0.9 }],
    /* 菜单从右上角"长出来"——锚点 = ⋯ 圆按钮位置（右上） */
    transformOrigin: 'right top',
    pointerEvents: convMenuShow.value > 0.5 ? 'auto' : 'none',
  }));
  const convMenuBackdropAnimStyle = useAnimatedStyle(() => ({
    pointerEvents: convMenuShow.value > 0.5 ? 'auto' : 'none',
  }));
  /* ⋯ 圆按钮：菜单打开时缩小 + 淡出，视觉"被菜单吸收"。 */
  const convMenuTriggerAnimStyle = useAnimatedStyle(() => ({
    opacity: 1 - convMenuShow.value,
    transform: [{ scale: 1 - convMenuShow.value * 0.2 }],
  }));
  /** 关键时序：SharedValue 先设（UI 线程立即动画），setState 后设（主线程 re-render
   *  在后），open 80ms / close 100ms 用户感受瞬间。 */
  const openConvMenu = useCallback(() => {
    if (!conversationId) return;
    convMenuShow.value = withTiming(1, { duration: 80 });
    setConvMenuOpen(true);
  }, [conversationId, convMenuShow]);
  const closeConvMenu = useCallback(() => {
    convMenuShow.value = withTiming(0, { duration: 100 });
    setConvMenuOpen(false);
  }, [convMenuShow]);

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
    conversationMetaRef.current = null;
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
          const { conversation, messagesWindow } = await getConversation(session, lastConvId, CHAT_MESSAGES_INITIAL_LIMIT);
          applyConversationUsageState(conversation, messagesWindow);
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
          const { conversation, messagesWindow } = await getConversation(session, cid, CHAT_MESSAGES_INITIAL_LIMIT);
          applyConversationUsageState(conversation, messagesWindow);
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
      getConversation(sess, cid, CHAT_MESSAGES_INITIAL_LIMIT)
        .then(({ conversation, messagesWindow }) => {
          const rid = conversation?.active_chat_v2_run_id;
          const s = typeof rid === 'string' ? rid.trim() : '';
          if (!s) return;
          applyConversationUsageState(conversation, messagesWindow);
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

  /* 滚到顶加载更旧（尾窗分页）：getMessagesBefore → prepend 到 serverRawMessages/messages → 更新窗口。
   * 全程读 ref 取最新值（防 stale），不进依赖。prepend 前记录内容高度+偏移，onContentSizeChange 里
   * 按高度增量把视口锚回原位（见那处）。loading（流式中）不分页，避免与 truncate/流式追加打架。 */
  const loadOlderMessages = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const meta = messageWindowMetaRef.current;
    if (!meta || !meta.hasOlder) return;
    const cid = conversationIdRef.current;
    if (!session || !cid) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true); // 顶部转圈（绝对定位 overlay，不占内容高度→不影响锚定）
    try {
      const { messages: older, messagesWindow: newWindow } = await getMessagesBefore(
        session,
        cid,
        meta.viewStart
      );
      if (conversationIdRef.current !== cid) return;
      if (older.length === 0) {
        if (newWindow) setMessageWindowMeta(newWindow);
        return;
      }
      const combined = [...older, ...serverRawMessagesRef.current];
      /* prepend 后保持可见位置交给 ScrollView 的 maintainVisibleContentPosition（原生帧级维持），
       * 无需手动 scrollTo —— 顶部插入更早消息时，当前可见消息自动稳在原位。 */
      setServerRawMessages(combined);
      setMessages(rawMessagesToLocal(combined));
      setMessageWindowMeta(newWindow ?? meta);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[chat] load older failed:', (e as Error)?.message || e);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [session]);

  // 从历史对话列表进入时，根据路由参数加载对话
  useEffect(() => {
    const id = params?.conversationId;
    if (!id || !session) {
      loadedConversationIdRef.current = null;
      setConversationHistoryLoading(false);
      return;
    }
    // 同一会话已加载过：effect 因别的依赖抖动 re-fire 时不重拉重解密、保留现有(可能已分页的)消息
    if (loadedConversationIdRef.current === id) {
      setConversationHistoryLoading(false);
      return;
    }
    let cancelled = false;
    const gen = ++conversationRouteFetchGenRef.current;
    setConversationHistoryLoading(true);
    getConversation(session, id, CHAT_MESSAGES_INITIAL_LIMIT)
      .then(({ conversation, messagesWindow }) => {
        if (cancelled || gen !== conversationRouteFetchGenRef.current) return;
        const tUi0 = perfNowMs();
        setConversationHistoryLoading(false);
        const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
        shouldScrollToEndRef.current = true;
        scrollToEndAnimatedRef.current = false;
        const rid = conversation?.active_chat_v2_run_id;
        const runId = typeof rid === 'string' ? rid.trim() : '';
        const tMap0 = perfNowMs();
        applyConversationUsageState(conversation, messagesWindow);
        let localMsgs = rawMessagesToLocal(raw);
        if (runId) {
          localMsgs = truncateMessagesAfterLastUser(localMsgs);
        }
        const tMap1 = perfNowMs();
        setMessages(localMsgs);
        setConversationId(id);
        conversationIdRef.current = id;
        loadedConversationIdRef.current = id; // 标记已完整加载，后续 dep 抖动跳过重拉
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

  /** 按 review_id 在 currentAssistantBlocks 与 messages 中同步打补丁，避免点完按钮要等命令跑完才有反馈 */
  const patchToolBlocksByReviewId = useCallback(
    (reviewId: string, patch: Partial<ToolBlock>) => {
      if (!reviewId) return;
      setCurrentAssistantBlocks((prev) =>
        prev.map((b) =>
          b?.type === 'tool' && (b as ToolBlock).review_id === reviewId ? { ...(b as ToolBlock), ...patch } : b,
        ),
      );
      setMessages((prev) =>
        prev.map((msg) => {
          if (!msg?.blocks || !Array.isArray(msg.blocks)) return msg;
          return {
            ...msg,
            blocks: msg.blocks.map((b) =>
              b?.type === 'tool' && (b as ToolBlock).review_id === reviewId
                ? { ...(b as ToolBlock), ...patch }
                : b,
            ),
          };
        }),
      );
    },
    []
  );

  const handleSafetyDecision = useCallback(
    async (reviewId: string, decision: 'approve' | 'reject') => {
      if (!session || !conversationId) return;
      const optimisticStatus: ToolBlock['status'] =
        decision === 'approve' ? 'confirming' : 'rejected_by_user';
      setSubmittingReviewId(reviewId);
      patchToolBlocksByReviewId(reviewId, { status: optimisticStatus });
      try {
        await submitSafetyDecision(session, conversationId, reviewId, decision);
        if (decision === 'approve') setStreamStatus('tool_running');
      } catch (e) {
        // 回滚乐观更新，让安全卡片再出现一次让用户重试
        patchToolBlocksByReviewId(reviewId, { status: 'awaiting_confirmation' });
        setError(e instanceof Error ? e.message : '提交确认失败');
      } finally {
        setSubmittingReviewId('');
      }
    },
    [session, conversationId, patchToolBlocksByReviewId]
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

  /** 与 Web/Desktop 一致：read_page_subagent、文件卡片、exec、FlowDoc 写/编/树 默认半展开；doc_read、search_engine 等默认折叠 */
  function getDefaultToolCardViewMode(toolName: string): 'collapsed' | 'preview' {
    if (
      toolName === 'read_page_subagent' ||
      toolName === 'read_page_raw' ||
      toolName === 'local_write_file' ||
      toolName === 'local_edit_file' ||
      toolName === 'local_exec_command' ||
      toolName === 'local_delete' ||
      toolName === 'doc_get_tree' ||
      toolName === 'doc_edit_as_md' ||
      toolName === 'doc_patch_as_md' ||
      toolName === 'doc_write_as_md'
    )
      return 'preview';
    if (toolName === 'doc_read') return 'collapsed';
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

  /** drawer 模式下不渲染返回，由 HamburgerButton 顶替；同时左缘 PanResponder 不挂，避免与 DrawerShell 左缘手势重叠 */
  const canGoBack = !inDrawer && navigation.canGoBack();
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
          <PackageIcon size={13} color={colors.textMuted} />
          <Text style={styles.toolPackageNavLineText}>
            {getToolPackageNavLabel(block.tool_name, block.arguments)}
          </Text>
        </View>
      );
    }

    if (block.tool_name === 'read_page_subagent') {
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
    if (block.tool_name === 'doc_edit_as_md') {
      return renderFlowDocEditToolCard(block, key);
    }
    if (block.tool_name === 'doc_patch_as_md') {
      return renderFlowDocPatchToolCard(block, key);
    }
    if (block.tool_name === 'doc_write_as_md') {
      return renderFlowDocWriteToolCard(block, key);
    }
    if (block.tool_name === 'doc_read') {
      return renderFlowDocReadToolCard(block, key);
    }
    if (block.tool_name === 'doc_get_tree') {
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

  /* 单趟预计算每条消息的 user 序号信息，替代 renderMessage 里对每条消息 messages.slice(0,idx).filter()
   * 的 O(n²) 扫描（大对话每次重渲染都会跑 → 卡）。语义与原逻辑一致：
   *  - userOrdinalIndex（仅 user 行）：本条是第几个 user（0-based）
   *  - afterUserIndex（仅 assistant 行）：本条之前最近一个 user 的 0-based 序号 */
  const ordinalInfo = useMemo(() => {
    let userSeen = 0;
    return messages.map((m) => {
      const afterUserIndex = userSeen - 1;
      let userOrdinalIndex = -1;
      if (m.role === 'user') {
        userOrdinalIndex = userSeen;
        userSeen += 1;
      }
      return { userOrdinalIndex, afterUserIndex };
    });
  }, [messages]);

  const renderMessage = (msg: ChatMessage, idx: number) => {
    /* 稳定全局 key：viewStart + 该消息窗口内起始 raw 下标 = 不随 prepend/append 漂移的全局位置。
     * 让 maintainVisibleContentPosition 能跨「加载更旧」认出同一条视图、把它钉在原位。
     * （无 _key 的流式/乐观消息退回下标 key —— 它们在最底部，不参与顶部锚定。） */
    const stableKey =
      msg._key != null
        ? `m${(messageWindowMeta?.viewStart ?? 0) + msg._key}`
        : `${msg.role}-${idx}`;
    if (msg.role === 'error') {
      return (
        <View key={stableKey} style={styles.errorWrap}>
          <Text style={styles.errorText}>{msg.content}</Text>
        </View>
      );
    }
    if (msg.role === 'task_event') {
      // 触发：对话流里独立全宽灰条卡（穿插事件走 assistant blocks 内联，不带"重新处理"）
      const tEvTid = msg.task_event && msg.task_event.task_id ? String(msg.task_event.task_id) : '';
      return (
        <TaskEventCardView
          key={stableKey}
          taskEvent={msg.task_event}
          content={msg.content}
          variant="trigger"
          onReprocess={
            tEvTid ? () => handleRegenerate(null, undefined, undefined, tEvTid) : undefined
          }
          reprocessDisabled={!conversationId || loading || conversationHistoryLoading}
        />
      );
    }
    const isUser = msg.role === 'user';
    const userOrdinalIndex = isUser ? (ordinalInfo[idx]?.userOrdinalIndex ?? -1) : -1;
    const isLastAssistant = !isUser && msg.role === 'assistant' && idx === lastAssistantIdx;
    const afterUserIndex =
      !isUser && msg.role === 'assistant' ? (ordinalInfo[idx]?.afterUserIndex ?? -1) : -1;
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
        key={stableKey}
        style={[styles.bubbleWrap, isUser ? styles.userBubbleWrap : styles.assistantBubbleWrap]}
      >
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          {!isUser && <Text style={styles.bubbleRole}>{composerAgentLabel}</Text>}
          {!isUser && msg.role === 'assistant' && assistantBlocks && assistantBlocks.length > 0 ? (
            <>
              {assistantBlocks.map((block, bi) => {
                const blocks = assistantBlocks;
                const prevBlock = blocks[bi - 1];
                const nextBlock = blocks[bi + 1];
                const compactAbove = prevBlock != null && isToolPackageNavBlock(prevBlock);
                const tightAfterThinking = prevBlock != null && isClosedThinkingBlock(prevBlock);
                if (block.type === 'thinking') {
                  return (
                    <ThinkingBlockView
                      block={block}
                      key={`msg-think-${idx}-${bi}`}
                      prevIsToolPackage={prevBlock != null && isToolPackageNavBlock(prevBlock)}
                      nextIsToolPackage={nextBlock != null && isToolPackageNavBlock(nextBlock)}
                    />
                  );
                }
                if (block.type === 'task_event') {
                  return (
                    <TaskEventCardView
                      key={`msg-taskevent-${idx}-${bi}`}
                      taskEvent={block.task_event}
                      content={block.content}
                      variant="injection"
                    />
                  );
                }
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
                      style={[
                        styles.assistantTextBlock,
                        compactAbove && styles.assistantTextBlockCompactAbove,
                        tightAfterThinking && styles.assistantTextBlockTightAfterThinking,
                      ]}
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
              <Pressable
                onLongPress={() =>
                  presentUserMessageActions(
                    msg.content,
                    userOrdinalIndex,
                    msg.role === 'user' ? msg.flops_refs : undefined,
                  )
                }
                delayLongPress={320}
              >
                <UserMessageContent
                  content={msg.content}
                  flopsRefs={msg.role === 'user' ? msg.flops_refs : undefined}
                  textStyle={styles.userText}
                />
              </Pressable>
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
        {/* 用户气泡操作改为长按弹 ActionSheet（参见 presentUserMessageActions），不再常态显示按钮行 */}
      </View>
    );

    if (isUser) {
      return (
        <React.Fragment key={`frag-${stableKey}`}>
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
    {/* edges 不含 'bottom'：bottom inset 交给 bottomOverlay 处理（见 navInset），
        避免 SafeAreaView 在透明导航栏后面糊一条白 padding 带。 */}
    <SafeAreaView style={styles.container} edges={[]}>
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
        {inDrawer ? (
          <HamburgerButton />
        ) : canGoBack ? (
          <AnimatedCircleButton
            style={styles.circleBtn}
            onPress={() => navigation.goBack()}
            iosSfSymbol={{ name: 'chevron.backward', size: 16, color: colors.textSecondary }}
          >
            <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
          </AnimatedCircleButton>
        ) : (
          <View style={styles.circleBtn} />
        )}
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
            {conversationId ? (conversationTitle || '新对话') : 'Flops'}
          </Text>
        </View>
        {/* 右上角 ⋯ 菜单 三条路：
         *  - iOS 26+ (Liquid Glass)：AnimatedCircleButton 透传 menuActions 给 BouncyButton，
         *    底下 UIButton 直接挂原生 UIMenu（glass material + 系统 scale + UIMenu 弹层 全套
         *    系统接管）。
         *  - iOS 15..25：保留 MenuView（也是原生 UIMenu，但没玻璃 material，配手挂 scale）。
         *  - Android：AnimatedCircleButton + 自绘 Modal popover。 */}
        {IS_IOS_LIQUID_GLASS ? (
          <AnimatedCircleButton
            style={[styles.circleBtn, !conversationId ? styles.circleBtnDisabled : null]}
            disabled={!conversationId}
            menuActions={convMenuActions.map((a) => ({ id: a.id, title: a.title }))}
            iosSfSymbol={{ name: 'ellipsis', size: 16, color: colors.textSecondary }}
            onMenuAction={(id) => {
              if (id === 'info') handleConvInfo();
              else if (id === 'diag') handleConvDiagCopy();
            }}
          >
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
          </AnimatedCircleButton>
        ) : Platform.OS === 'ios' ? (
          <MenuView
            title=""
            actions={convMenuActions}
            onPressAction={onConvMenuPressAction}
            onOpenMenu={animateConvMenuPressDown}
            onCloseMenu={animateConvMenuPressUp}
            shouldOpenOnLongPress={false}
          >
            <Animated.View
              style={[
                styles.circleBtn,
                !conversationId && styles.circleBtnDisabled,
                { transform: [{ scale: convMenuBtnScale }] },
              ]}
              pointerEvents={conversationId ? 'auto' : 'none'}
            >
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
            </Animated.View>
          </MenuView>
        ) : (
          <Reanimated.View style={convMenuTriggerAnimStyle}>
            <AnimatedCircleButton
              style={[styles.circleBtn, !conversationId && styles.circleBtnDisabled]}
              onPress={openConvMenu}
              disabled={!conversationId}
            >
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
            </AnimatedCircleButton>
          </Reanimated.View>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardView}
        /* lib KAV 两端都用 'padding'：lib 内部用 WindowInsets.ime / UIKeyboardLayoutGuide 拿
         *  键盘 frame，paddingBottom 由 lib worklet 直接驱动。Android 不再走 adjustResize
         *  那条路（lib 不依赖它，传 undefined 会走 default no-op，content 完全不动），且
         *  edge-to-edge 模式下 adjustResize 行为已被 fitsSystemWindows=false 改变。 */
        behavior="padding"
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
            /* 点击触发：touchStart capture，绕过消息子组件（TouchableOpacity / RNGH）
             * 抢 responder 导致 ScrollView 自身 onTouchStart 不 fire 的情形。
             * 滚动触发：iOS 用 keyboardDismissMode='on-drag'（native interactive），
             * Android 用 JS onScrollBeginDrag。
             *
             * [已知边缘 bug] iOS 上滚动 dismiss 时消息区会抖（持续到键盘动画结束）；
             * 点击 dismiss 不抖。怀疑根因是 lib KAV behavior='padding' 在 dismiss 期间
             * 缩 ScrollView frame，触底状态下 contentOffset 被强制修正引发跳动。
             * 排除过：
             *   - JS 侧重复调 Keyboard.dismiss()（去掉只留 native blur — 不改善）
             *   - on-drag 跟 onScrollBeginDrag 显式 blur 并发（iOS 改 onScrollEndDrag — 不改善）
             *   - UIScrollView 自动 keyboard contentInset（关 automaticallyAdjustKeyboardInsets
             *     + contentInsetAdjustmentBehavior='never' — 不改善）
             * 未来方向：把 KAV 的 padding 模式换成 ScrollView contentInset.bottom 动态跟键盘，
             * 或者 bottomOverlay 改用 transform translateY 直接跟 kbAnimHeight 走、彻底不让
             * KAV 缩 ScrollView frame。当前评估边缘 bug、性价比不高，先搁置。 */
            onTouchStartCapture={dismissComposer}
            onScrollBeginDrag={Platform.OS === 'android' ? dismissComposer : undefined}
            keyboardDismissMode="on-drag"
            onContentSizeChange={(_w, h) => {
              scrollContentHeightRef.current = h;
              /* 加载更旧的锚定已交给 maintainVisibleContentPosition（原生帧级维持），这里只管触底滚动。 */
              if (shouldScrollToEndRef.current) {
                shouldScrollToEndRef.current = false;
                const animated = scrollToEndAnimatedRef.current;
                scrollToEndAnimatedRef.current = true;
                scrollRef.current?.scrollToEnd({ animated });
                /* Android：onContentSizeChange 经常在内容真正布局完前先 fire 一次（中间高度），
                   单次 scrollToEnd 只滚到那个中间位置。再补两次延迟滚动盖住后续布局抖动。
                   iOS 同步布局基本一次到位，不需要。 */
                if (Platform.OS === 'android') {
                  requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
                  setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 200);
                }
              }
            }}
            /* 滚到顶附近(<160)且还有更旧 → 触发分页加载。同时记录 offset 供 prepend 锚定。 */
            onScroll={(e) => {
              const y = e.nativeEvent.contentOffset.y;
              scrollOffsetYRef.current = y;
              // 离开顶部 → 重新武装（下次滚到顶才再触发，避免一次滚动在顶部附近连环触发多批）
              if (y > 300) nearTopTriggeredRef.current = false;
              if (
                y <= 160 &&
                !nearTopTriggeredRef.current &&
                messageWindowMetaRef.current?.hasOlder &&
                !loadingOlderRef.current &&
                !loading
              ) {
                nearTopTriggeredRef.current = true;
                void loadOlderMessages();
              }
            }}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled"
            /* 加载更旧消息时，原生维持当前可见消息的位置（帧级、绘制前调好 offset）→ 顶部插入更早内容
             * 时可见内容稳在原位、不抖不跳。要求消息是本 ScrollView 内容的直接子节点（已去掉 chatContentWrap）。
             * minIndexForVisible:1 以首个可见消息的下一条为锚，避开最顶一条在边缘时的抖动。 */
            maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
          >
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
                      const nextBlock = currentAssistantBlocks[bi + 1];
                      const compactAbove = prevBlock != null && isToolPackageNavBlock(prevBlock);
                      const tightAfterThinking = prevBlock != null && isClosedThinkingBlock(prevBlock);
                      if (block.type === 'thinking') {
                        return (
                          <ThinkingBlockView
                            block={block}
                            key={`stream-think-${bi}`}
                            prevIsToolPackage={prevBlock != null && isToolPackageNavBlock(prevBlock)}
                            nextIsToolPackage={nextBlock != null && isToolPackageNavBlock(nextBlock)}
                          />
                        );
                      }
                      if (block.type === 'task_event') {
                        return (
                          <TaskEventCardView
                            key={`stream-taskevent-${bi}`}
                            taskEvent={block.task_event}
                            content={block.content}
                            variant="injection"
                          />
                        );
                      }
                      return block.type === 'text' ? (
                        <View
                          key={bi}
                          style={[
                        styles.assistantTextBlock,
                        compactAbove && styles.assistantTextBlockCompactAbove,
                        tightAfterThinking && styles.assistantTextBlockTightAfterThinking,
                      ]}
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
            {reloadPending ? (
              <View style={styles.reloadPendingBanner}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.reloadPendingText}>服务器热更新中，稍后将继续…</Text>
              </View>
            ) : null}
          </ScrollView>
          <HistoryLoadingOverlay
            visible={conversationHistoryLoading}
            bottomOverflow={insets.bottom + 32}
            topOffset={headerHeight}
            overlayStyle={styles.historyLoadingOverlay}
            spinnerColor={colors.textSecondary}
          />
          {/* 加载更旧消息的顶部转圈：绝对定位 overlay（不占内容高度，不影响 prepend 锚定）。 */}
          {loadingOlder ? (
            <View
              style={{
                position: 'absolute',
                top: headerHeight + 8,
                left: 0,
                right: 0,
                alignItems: 'center',
                zIndex: 20,
              }}
              pointerEvents="none"
            >
              <ActivityIndicator size="small" color={colors.textSecondary} />
            </View>
          ) : null}
          {/* 底部整块贴屏底：渐变铺满整块并延伸到底，输入行叠在渐变底部，无单独白底；点渐变区（未点到输入/发送）可滚到底。
              用 Reanimated.View + kbBottomStyle 让 bottom 在键盘动画中逐帧跟随。 */}
          <Reanimated.View style={[styles.bottomOverlay, { height: bottomOverlayHeight }, kbBottomStyle]}>
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
              onPress={() => {
                /* 渐变带 = 非 composer 区域，点这里也应该失焦（语义上跟点消息区一致）。 */
                dismissComposer();
                scrollRef.current?.scrollToEnd({ animated: true });
              }}
              accessibilityRole="button"
              accessibilityLabel="滚动到对话底部"
            />
            <Reanimated.View style={[styles.bottomOverlayInner, navInsetAnimStyle]} pointerEvents="box-none">
              {/* 输入区。short 模式：圆角胶囊一行，+ 内嵌左侧 + 输入填满；模型 / 助手 chips
                  走绝对定位的 meta row 贴在 composer 下面留白里。
                  tall 模式：圆角卡片两行，上面纯输入区，下面一行 [+ 按钮][model][agent]
                  全部 inline 在卡片底部 — 不再走绝对 meta row（避免位置错位）。
                  发送统一靠键盘 Return（FlowDocSlateAdapter.onSubmitOnEnter） — 没有发送按钮。
                  loading 时把 + 换成 ⏹ 停止键。 */}
              {(() => {
                const renderPlusBtn = (
                  <TouchableOpacity
                    style={styles.composerPlusBtnAbsolute}
                    onPress={loading ? handleStop : () => setComposerPickerOpen(true)}
                    disabled={!loading && (!session || conversationHistoryLoading)}
                    accessibilityLabel={loading ? '停止' : '引用 FlowDoc 文档'}
                    activeOpacity={0.7}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Ionicons
                      name={loading ? 'stop' : 'add'}
                      size={22}
                      color={loading ? colors.danger : colors.textSecondary}
                    />
                  </TouchableOpacity>
                );
                const renderChips = session ? (
                  <>
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
                      <Ionicons name="chevron-down" size={14} color={colors.placeholder} />
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
                          <Ionicons name="chevron-down" size={14} color={colors.placeholder} />
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
                  </>
                ) : null;
                /* 右下角不再是长串"共 N tok · ~¥X.XXX"，改成：环形上下文进度 + 统计图 icon；
                   icon 点击弹原来的本对话用量详情。跟 web 版 ComposerContextRing 对齐。 */
                const ringPct =
                  showTokenUsageInChat && conversationId && !conversationHistoryLoading
                    ? getComposerContextRingPercent({
                        messages: serverRawMessages,
                        context_summaries: contextSummaries,
                        active_context_summary_id: activeContextSummaryId,
                        context_projection_l1: contextProjectionL1,
                      })
                    : null;
                const showStatsIcon =
                  showTokenUsageInChat &&
                  usageStats &&
                  conversationId &&
                  !conversationHistoryLoading;
                const renderUsage =
                  ringPct != null || showStatsIcon ? (
                    <View style={styles.composerUsageInMetaRow}>
                      {ringPct != null ? (
                        <TouchableOpacity
                          activeOpacity={0.7}
                          accessibilityLabel="本对话上下文已用比例"
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          onPress={() => {
                            const detail =
                              formatContextComposerHoverDetail({
                                messages: serverRawMessages,
                                context_summaries: contextSummaries,
                                active_context_summary_id: activeContextSummaryId,
                                context_projection_l1: contextProjectionL1,
                              }) || `约 ${Math.round(ringPct)}%`;
                            /* 有压缩摘要分界时才提供"跳转到压缩截断位置"按钮 */
                            const canJump = contextCompressMessagePercent != null;
                            setUsageDetailModalState({
                              title: '上下文用量',
                              body: detail,
                              ...(canJump
                                ? {
                                    actionLabel: contextCompressScrollToAnchorTitle,
                                    onAction: scrollToContextCompressAnchor,
                                  }
                                : {}),
                            });
                          }}
                        >
                          <ComposerContextRing percent={ringPct} size={12} />
                        </TouchableOpacity>
                      ) : null}
                      {showStatsIcon ? (
                        <TouchableOpacity
                          style={styles.composerUsageIconBtn}
                          activeOpacity={0.7}
                          accessibilityLabel="本对话用量与计费详情"
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          onPress={() =>
                            setUsageDetailModalState({
                              title: '本对话用量详情',
                              body: formatUsageHoverDetail(usageStats, {
                                currencyMode: usageCurrencyDisplay,
                                modelPriceReference,
                                selectedModelId,
                                scope: 'conversation',
                              }),
                            })
                          }
                        >
                          <Ionicons
                            name="stats-chart-outline"
                            size={12}
                            color={colors.placeholder}
                          />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ) : null;
                /* FlowDocSlateAdapter 跨 short ↔ tall 切换保持在同一个 JSX 位置：
                   [card > inputArea > inputWrapper > FlowDocSlateAdapter]，
                   两模式只改外层 style；+ 按钮抽成 card 的 absolute child，screen 位置不动；
                   model / agent chips 永远在 card 外的绝对 meta row。 */
                /* adapter 直接 mount 到 card 里，flex:1 alignSelf:stretch 让 native UITextView
                 *  / EditText frame 撑满整张 card；文字视觉留白用 textContainerInset 给（不再
                 *  靠外层 wrapper View 套 padding 把 textView 框小）。
                 *  好处：UITextView / EditText 自己的 tap recognizer 覆盖整片可点区域,
                 *  "卡片其它区域 = 输入框延伸"是原生 cursor placement 语义，不是 JS hack。
                 *  + 按钮还是 card 的 absolute child；native gesture delegate 会自动 filter
                 *  掉 UIControl 子树的 touch，不抢 + 按钮的 tap。 */
                const adapter = (
                  <FlowDocSlateAdapter
                    key={composerRemountKey}
                    ref={composerAdapterRef}
                    initialDocument={composerDoc}
                    onChange={setComposerDoc}
                    onSubmitOnEnter={handleSendMessage}
                    placeholder={showEmpty ? '输入你的第一句话...' : '输入消息'}
                    placeholderColor={colors.placeholder}
                    textColor={colors.textPrimary}
                    pillBackgroundColor={colors.surfaceMuted}
                    pillTextColor={colors.textMuted}
                    fontSize={16}
                    /** 跟用户消息气泡 styles.userText 对齐：16 / 22 */
                    lineHeight={22}
                    pillMaxLabelTextWidth={100}
                    editable={!loading && !conversationHistoryLoading}
                    textContainerInset={
                      composerTall ? COMPOSER_TEXT_INSET_TALL : COMPOSER_TEXT_INSET_SHORT
                    }
                    style={styles.composerAdapterFill}
                  />
                );
                const innerCardContent = (
                  <>
                    {adapter}
                    {/* + 按钮：card 的 absolute child；bottom:10 left:8 在 short / tall 都一样 */}
                    {renderPlusBtn}
                  </>
                );
                return (
                  <>
                    {/* composer card 直接渲染——不能用 Reanimated.View wrapper，会干扰内部
                     * FlowDocSlateAdapter 的 autoHeight 测量（中文/换行时 card 不变高、文本叠层
                     * 渲染）。card 上移到键盘上方的过渡靠 kbBottomStyle 在 bottomOverlay 整体
                     * 下移 6pt 实现，card 的 marginBottom: 18 保持静态。 */}
                    {IS_IOS_LIQUID_GLASS ? (
                      <BouncyGlassCard
                        style={
                          composerTall
                            ? styles.composerCardTallGlass
                            : styles.composerCardShortGlass
                        }
                        cornerRadius={COMPOSER_CARD_RADIUS}
                        interactive
                      >
                        {innerCardContent}
                      </BouncyGlassCard>
                    ) : (
                      /* Reanimated.View 只做 transform wrapper（不持有 card 视觉 styles）,
                       * inner View 保留 card 身份（bg / radius / shadow / margins）。
                       * raw onTouch* 挂在 Reanimated.View 上：独立于 responder system 跟
                       * native gesture ownership，native FlowDocInputView cursor placement /
                       * 双击选词不被影响。 */
                      <Reanimated.View
                        collapsable={false}
                        style={composerPressAnimStyle}
                        pointerEvents="box-none"
                        onTouchStart={onComposerTouchStart}
                        onTouchEnd={onComposerTouchEnd}
                        onTouchCancel={onComposerTouchCancel}
                      >
                        <View
                          style={composerTall ? styles.composerCardTall : styles.composerCardShort}
                          pointerEvents="box-none"
                        >
                          {innerCardContent}
                        </View>
                      </Reanimated.View>
                    )}
                    {/* 模型 / 助手 chips：永远在 card 外的绝对 meta row。键盘弹起时由 kbMetaRowStyle
                     * 平滑淡出（opacity 1→0），pointerEvents 由 keyboardOpen JS state 控制（不可见
                     * 时不接收 touch）。原本 `&& !keyboardOpen ? ... : null` 的瞬间 unmount 会跟
                     * composer marginBottom 切换一起造成抖动，所以这里改成 always-render + 透明度。 */}
                    {session ? (
                      <Reanimated.View
                        style={[styles.composerMetaRowAbsolute, kbMetaRowStyle]}
                        pointerEvents={keyboardOpen ? 'none' : 'auto'}
                      >
                        <View style={styles.composerMetaPills}>{renderChips}</View>
                        {renderUsage}
                      </Reanimated.View>
                    ) : null}
                  </>
                );
              })()}
            </Reanimated.View>
          </Reanimated.View>
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
      visible={usageDetailModalState != null}
      onClose={() => setUsageDetailModalState(null)}
      title={usageDetailModalState?.title}
      body={usageDetailModalState?.body ?? ''}
      actionLabel={usageDetailModalState?.actionLabel}
      onAction={usageDetailModalState?.onAction}
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
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: colors.textPrimary }}>
              编辑消息
            </Text>
            <TouchableOpacity
              onPress={() => setEditPickerOpen(true)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="引用 FlowDoc 文档"
            >
              <Ionicons name="add-circle-outline" size={22} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <View
            style={{
              alignSelf: 'stretch',
              width: '100%',
              minHeight: 120,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.borderMuted,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }}
          >
            {userMessageEdit ? (
              <FlowDocSlateAdapter
                ref={userMessageEditAdapterRef}
                initialDocument={userMessageEdit.initialDoc}
                onChange={(doc) => {
                  userMessageEditDocRef.current = doc;
                }}
                textColor={colors.textBody}
                pillBackgroundColor={colors.surfaceMuted}
                pillTextColor={colors.textMuted}
                fontSize={16}
                lineHeight={22}
                pillMaxLabelTextWidth={100}
                editable
              />
            ) : null}
          </View>
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
                if (!st) return;
                const finalDoc = userMessageEditDocRef.current ?? st.initialDoc;
                const { content, flops_refs } = serializeSlateDocumentToUserMessage(
                  finalDoc,
                  st.refDataByKey,
                );
                const trimmed = content.trim();
                if (!trimmed && flops_refs.length === 0) return;
                const ai = st.afterIndex;
                setUserMessageEdit(null);
                userMessageEditDocRef.current = null;
                void handleRegenerate(ai, trimmed, flops_refs);
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
    <FlowDocPickerModal
      visible={composerPickerOpen}
      onClose={() => setComposerPickerOpen(false)}
      onPickDoc={(docId, name) => {
        const ref = buildFlowDocFullRef(docId, name);
        composerRefDataByKeyRef.current.set(ref.key, ref);
        const mention = ref.mention_text || `@${ref.title || ''}`;
        composerAdapterRef.current?.insertPill(ref.key, mention, ref.title || '', true);
        /* 等模态彻底 dismiss 动画结束之后再 focus，否则 modal 还盖着 textView，
           focus 调用会被忽略 → 光标视觉上消失。native insertPill 已经把 selectedRange
           设到了 pill 之后那个位置，所以 focus() 即可，不需要 focusAtOffset。 */
        pendingComposerFocusRef.current = true;
      }}
      onAfterDismiss={() => {
        if (pendingComposerFocusRef.current) {
          pendingComposerFocusRef.current = false;
          composerAdapterRef.current?.focus();
        }
      }}
    />
    <FlowDocPickerModal
      visible={editPickerOpen}
      onClose={() => setEditPickerOpen(false)}
      onPickDoc={(docId, name) => {
        const ref = buildFlowDocFullRef(docId, name);
        setUserMessageEdit((prev) => {
          if (!prev) return prev;
          const next = new Map(prev.refDataByKey);
          next.set(ref.key, ref);
          return { ...prev, refDataByKey: next };
        });
        const mention = ref.mention_text || `@${ref.title || ''}`;
        userMessageEditAdapterRef.current?.insertPill(ref.key, mention, ref.title || '', true);
        pendingEditFocusRef.current = true;
      }}
      onAfterDismiss={() => {
        if (pendingEditFocusRef.current) {
          pendingEditFocusRef.current = false;
          userMessageEditAdapterRef.current?.focus();
        }
      }}
    />

    {/* Android：⋯ 菜单。设计跟 TodayScreen FAB 菜单同款：
     *  - 不用 Modal（消除 native dialog 启动延迟）
     *  - 常驻 mount + SharedValue 驱动 opacity/scale/pointerEvents（不依赖 React re-render）
     *  - 菜单卡片 transformOrigin: right top，从 ⋯ 按钮位置"向左向下长出来"
     *  - backdrop 透明（不变暗），靠 shadowMenu 跟背景区分
     *  - ⋯ 按钮在菜单打开时缩小 + 淡出，视觉"被菜单吸收" */}
    {Platform.OS === 'android' ? (
      <>
        <Reanimated.View
          style={[StyleSheet.absoluteFill, styles.convMenuBackdrop, convMenuBackdropAnimStyle]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeConvMenu} />
        </Reanimated.View>
        <Reanimated.View
          style={[
            styles.convMenuCard,
            {
              /* 跟 ⋯ 圆按钮同位置 + 略向下错开（按钮 top=insets.top+8，菜单 +4 偏移）,
               * 菜单覆盖原按钮位置但向下露出一点点，配合 ⋯ 按钮淡出 + 菜单从右上长出来,
               * 视觉是"按钮变成菜单"。 */
              top: insets.top + 8 + 4,
              right: 16,
            },
            convMenuCardAnimStyle,
          ]}
        >
          <TouchableOpacity
            style={styles.convMenuItem}
            activeOpacity={0.6}
            onPress={() => {
              closeConvMenu();
              handleConvInfo();
            }}
          >
            <Ionicons name="information-circle-outline" size={20} color={colors.textPrimary} />
            <Text style={styles.convMenuItemText}>对话信息</Text>
          </TouchableOpacity>
          <View style={styles.convMenuDivider} />
          <TouchableOpacity
            style={styles.convMenuItem}
            activeOpacity={0.6}
            onPress={() => {
              closeConvMenu();
              handleConvDiagCopy();
            }}
          >
            <Ionicons name="copy-outline" size={20} color={colors.textPrimary} />
            <Text style={styles.convMenuItemText}>复制诊断资料</Text>
          </TouchableOpacity>
        </Reanimated.View>
      </>
    ) : null}
    </>
  );
}

