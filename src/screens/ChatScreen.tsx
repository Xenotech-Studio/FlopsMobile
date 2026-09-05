import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ScrollView,
  Image,
  Platform,
  Modal,
  PanResponder,
  ActivityIndicator,
  Animated,
  AppState,
  Alert,
  ActionSheetIOS,
  Keyboard,
  Dimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { AudioManager } from 'react-native-audio-api';
import BottomSheet, {
  useGestureEventsHandlersDefault,
  type GestureEventsHandlersHookType,
} from '@gorhom/bottom-sheet';
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import LinearGradient from 'react-native-linear-gradient';
import Reanimated, {
  Easing,
  interpolateColor,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { convProfileLog } from '../debug/conversationLoadProfile';
import { PRESS_SPRING_CONFIG } from '../constants/animation';
import { useSession } from '../context/SessionContext';
import { useSetActiveConversation, useUnreadConvMap } from '../context/ConversationContext';
import { useTtsPlayback, togglePlayback, isTtsPlaybackSupported } from '../audio/ttsPlayer';
import {
  setActiveConversation as setRealtimeActiveConversation,
  clearActiveConversation as clearRealtimeActiveConversation,
  setRealtimeEnabled,
  setBroadcastMode,
} from '../audio/ttsRealtime';
import { bytesToBase64, getCachedKAgent, getCachedKConv } from '../lib/srp';
import type { RootStackParamList } from '../navigation/types';
import {
  createConversation,
  streamChatV2Loop,
  cancelConversation,
  NonLatestRegenerateConfirmError,
  enqueueSendQueue,
  getSendQueue,
  deleteSendQueueItem,
  injectSendQueueItem,
  submitSafetyDecision,
  submitConversationAccessDecision,
  submitConversationTitlesDecision,
  answerAskUserQuestion,
  getConversation,
  getConversationMeta,
  getMessagesBefore,
  CHAT_MESSAGES_INITIAL_LIMIT,
  getLayoutPreferences,
  setLayoutPreferences,
  getModelsConfig,
  selectModel,
  marketIdOf,
  getAgentIds,
  getAgentProfile,
  type ModelsConfigResponse,
  type ChatStreamEvent,
  type ChatStreamFrameMeta,
  type ChatV2StreamStart,
  type ConversationMessage,
  type Conversation,
  type ConversationAttachment,
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
  type TaskEventPayload,
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
import { pick, types, errorCodes, isErrorWithCode } from '@react-native-documents/picker';
import {
  launchImageLibrary,
  launchCamera,
  type ImagePickerResponse,
} from 'react-native-image-picker';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { MarkdownContent } from '../components/MarkdownContent';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { AnimatedBouncyGlassCard, BouncyGlassCard } from '../components/BouncyGlassCard';
import { HEADER_CIRCLE_BTN_SIZE, bottomInsetTotal } from '../theme/layout';
import { getBottomInsetSync } from '../utils/screenInfo';
import {
  chatInputOverlayGradient,
  collabSheetTopFadeGradient,
  toolPreviewFadeGradient,
} from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { HamburgerButton } from './shell/HamburgerButton';
import {
  AnimatedCircleButton,
  IS_IOS_LIQUID_GLASS,
  type AnimatedCircleButtonMenuAction,
} from '../components/AnimatedCircleButton';
import {
  createChatStyles,
  COMPOSER_CARD_RADIUS,
  COMPOSER_TEXT_INSET_SHORT,
  COMPOSER_TEXT_INSET_TALL,
} from './chat/ChatScreen.styles';
import { ChatMessageArea, type ChatMessageAreaHandle } from './chat/ChatMessageArea';
import { createBottomPinState } from '../utils/chatBottomPin';
import { WorkspaceBody } from './chat/WorkspaceBody';
import {
  applyCollabLayoutPayload,
  collabLayoutActive,
  collabLayoutEqual,
  collabLayoutFromConversationMeta,
  collabTabs,
  EMPTY_COLLAB_LAYOUT,
  type CollabLayoutState,
} from '../utils/collabLayout';
import { ThinkingBlockView } from './chat/ThinkingBlockView';
import { TaskEventCardView, UserInjectionInline } from './chat/TaskEventCardView';
import { ComposerContextRing } from './chat/ComposerContextRing';
import { isClosedThinkingBlock, isToolPackageNavBlock } from '../utils/chatStreamBlockKinds';
import { mergeToolResultChunk } from '../utils/toolResultPatch';
import { truncateMessagesAfterLastUser } from '../utils/chatMessageWindow';
import {
  clearResumeSnapshot,
  saveResumeSnapshot,
  takeResumeSnapshot,
} from '../utils/chatResumeCache';
import { usageRunEqual } from '../utils/usageRuns';
import { ansiToSegments } from '../utils/ansiToSegments';
import {
  parseFileToolArgs,
  parseReadPagesBlockArgs,
  isFetchUrlRenderedSummarize,
  readPagesResultEntryCount,
  readPagesFinishedCount,
  readPagesSuccessStats,
  readPagesReadingEntries,
  decodeUrlPctForDisplay,
  getReadPagesListSortBucket,
  tryParsePartialReadingStream,
  parseVisualWidget,
  formatWidgetEcho,
} from '../utils/toolCardParsers';
import { ReadPagesDetailSheet } from '../components/ReadPagesDetailSheet';
import { ModelSelectSheet } from '../components/ModelSelectSheet';
import type { ModelSelectOption } from '../components/ModelSelectSheet';
import { BlurSelectSheet } from '../components/BlurSelectSheet';
import { IOSStyleSwitch } from '../components/IOSStyleSwitch';
import { resolveAgentDisplayLabel } from '../utils/agentDisplay';
import { VoiceDictationSession } from '../utils/voiceDictationMobile';
import { UsageDetailModal } from '../components/UsageDetailModal';
import { SubagentViewOverlay } from '../components/SubagentViewOverlay';
import { ContextCompressDividerRow } from '../components/ContextCompressDividerRow';
import { SearchEngineCard } from './chat-cards/SearchEngineCard';
import { FileWriteCard } from './chat-cards/FileWriteCard';
import { FileEditCard } from './chat-cards/FileEditCard';
import { ExecCommandCard } from './chat-cards/ExecCommandCard';
import { DefaultToolCard } from './chat-cards/DefaultToolCard';
import { SubagentCard } from './chat-cards/SubagentCard';
import { SubagentMetaCard } from './chat-cards/SubagentMetaCard';
import { AskUserQuestionCard } from './chat-cards/AskUserQuestionCard';
import { ReadPagesCard } from './chat-cards/ReadPagesCard';
import { VisualWidgetCard } from './chat-cards/VisualWidgetCard';
import {
  FlowDocSlateAdapter,
  slateDocumentToContent,
  type SlateDocument,
} from '../flowdoc-native-input';
import type { FlowDocInputHandle } from '../flowdoc-native-input';
import {
  hydrateUserMessageToSlateDocument,
  serializeSlateDocumentToUserMessage,
  buildFlowDocFullRef,
  type FlopsRef,
} from '../chat/flopsRefs';
import { UserMessageContent } from '../chat/UserMessageContent';
import { FlowDocPickerModal } from '../chat/FlowDocPickerModal';
import {
  uploadComposerFile,
  buildOutboundChatMessage,
  readyAttachmentsToFlops,
  formatFileSize,
  fileTypeMeta,
  type PendingAttachment,
} from '../chat/composerAttachments';
import { FlowDocEditCard } from './chat-cards/FlowDocEditCard';
import { FlowDocPatchCard } from './chat-cards/FlowDocPatchCard';
import { FlowDocWriteCard } from './chat-cards/FlowDocWriteCard';
import { FlowDocReadCard } from './chat-cards/FlowDocReadCard';
import { FlowDocGetTreeCard } from './chat-cards/FlowDocGetTreeCard';
import { useResponsive } from '../hooks/useResponsive';

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

/** 忙态时允许排队的图卡回注条数软上限（与 Web WIDGET_ECHO_QUEUE_SOFT_MAX 一致），超出直接丢弃 */
const WIDGET_ECHO_QUEUE_SOFT_MAX = 3;

/** worklet 里要用的平台判断：hoist 成模块常量，避免在 worklet 闭包里捕获整个 Platform 对象。 */
const IS_ANDROID = Platform.OS === 'android';

/** 协同模式 sheet 的中/高两档（占 sheet 容器高度的比例）。
 *  聊天区高度就是「当前档高 - 把手高」（见 collabSheetSnapHeights / collabSheetChatHeight），
 *  所以档位必须是我们自己定的像素、两处同源；分家一次，视口就整体差一截。 */
const COLLAB_SHEET_MID_RATIO = 0.58;
const COLLAB_SHEET_MAX_RATIO = 0.92;
/** sheet 顶部把手那一条的高度。与 gorhom 默认握把等高（padding 10 + 指示条 4 + padding 10），
 *  同时用 handleStyle 把它钉死 —— 聊天区高度要拿「当前档高 - 把手高」算，这个数不能是猜的。 */
const COLLAB_SHEET_HANDLE_H = 24;
/** 「sheet 位置还没报上来」的哨兵：任何真实屏高都够不着，钳制会把它按到最低档那一端。 */
const COLLAB_SHEET_POSITION_UNSET = 1e6;
/**
 * 过顶多少（**sheet 位移**）算「溶解完毕」。这不是一个阈值判定，而是**进度的分母**：
 * 过顶量 / 它 = 0→1 的溶解进度，拖到哪就化到哪，到 1 才真正切状态。
 * 过顶带阻尼（最高档 - sqrt(1+手指超出量)*2.5），20pt 位移 ≈ 手指再上滑 50pt。
 */
const COLLAB_SHEET_DISMISS_TRAVEL = 20;
/**
 * **松手那一刻**进度到这儿才算「要关」，不到就交回 gorhom 回弹。手指还在时无论化到多少
 * 都不切状态 —— 取消权全程在手里，往回拖就原样化回去。0.5 = 化过一半，判定跟眼睛看到的一致。
 */
const COLLAB_SHEET_DISMISS_COMMIT = 0.5;


/** High-resolution time when available (e.g. Hermes), else `Date.now()`. Avoids bare `performance` (not in RN TS libs). */
function perfNowMs(): number {
  const w = globalThis as typeof globalThis & { performance?: { now?: () => number } };
  const n = w.performance?.now;
  return typeof n === 'function' ? n.call(w.performance) : Date.now();
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
  const priceRef = modelPriceReference[marketIdOf(modelId)];
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
  /** iPad 主区嵌套栈模式：用 conversationIdOverride（同 inDrawer），但 header 左上角按"能否返回"决定
   *  显示返回箭头还是汉堡——push 进来的对话显示返回箭头（pop 回今日/上一页），栈底则汉堡（开合侧栏）。 */
  mainPane?: boolean;
};

/* ── 与组件状态无关的纯函数：提到模块作用域，标识恒定 ──────────────────────────
 * 它们以前是 ChatScreen 组件体内的裸函数，每次 render 都是新标识，往下传给十几张
 * 工具卡时会打穿任何按引用做的 memo。提上来之后标识天然恒定，工具卡的比较器不必
 * 再为它们破例。行为逐字不变。 */
// 统一子 agent 卡：agent_type → 标签；复用同一张卡渲染 claude / cursor / subagent_start / subagent_continue
function subagentAgentLabel(block: Extract<StreamBlock, { type: 'tool' }>): string {
  if (block.tool_name === 'local_claude_agent') return 'Claude Code';
  if (block.tool_name === 'local_cursor_agent') return 'Cursor';
  try {
    const obj = JSON.parse(block.arguments || '{}') as { agent_type?: string };
    const at = String(obj.agent_type || '').trim().toLowerCase();
    if (at === 'claude') return 'Claude Code';
    if (at === 'cursor') return 'Cursor';
  } catch {
    /* ignore */
  }
  return 'Subagent';
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

/** 与 Web/Desktop 一致：读页/取回、文件卡片、exec、FlowDoc 写/编/树 默认半展开；doc_read、search_engine 等默认折叠 */
function getDefaultToolCardViewMode(toolName: string): 'collapsed' | 'preview' {
  if (
    toolName === 'fetch_url_rendered' ||
    toolName === 'fetch_url' ||
    // 旧名：历史消息沿用原默认展开度
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

export function ChatScreen({
  inDrawer = false,
  conversationIdOverride,
  conversationTitleOverride,
  createEncrypted = false,
  mainPane = false,
}: ChatScreenProps = {}) {
  const { session } = useSession();
  const ttsPlayback = useTtsPlayback();
  const insets = useSafeAreaInsets();
  /** 宽屏（iPad）下消息列限宽放大到桌面级（READING_MAX_WIDTH），而非手机的窄列（styles.scrollContent 写死 380）。 */
  const { expanded: wideChat } = useResponsive();
  const route = useRoute();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Chat'>>();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createChatStyles(colors), [colors]);
  /**
   * S9 加密子对话锁定态。K_conv 存在**父对话 meta 的加密字段**里（服务器也解不开），
   * getConversation 会自动去父对话捞一次 —— 捞到就没这个态。捞不到（父对话被删 /
   * 不在当前账号下）才置位，此时消息仍是密文哨兵，得跟用户说清楚原因而不是显示成空对话。
   */
  const [convLockedReason, setConvLockedReason] = useState<'need_parent' | null>(null);
  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  /* ── 协同模式 sheet 的几何输入（都要在下面算档位时用上，故提到这里）── */
  /** containerInner 实测高度（= BottomSheet 那个 hosting container 的父盒）。用实测而不是
   *  useWindowDimensions：sheet 档位和消息区可视高度补偿是同一组数做减法，差一点就露馅。 */
  const [collabHostHeight, setCollabHostHeight] = useState(0);
  /** sheet 当前停在第几档（onAnimate 给目标档、onChange 收尾确认）。 */
  const [collabSheetIndex, setCollabSheetIndex] = useState(1);
  /** 键盘是否弹起 + 弹起高度：协同模式下聊天区高度要按键盘上沿截断（见 collabSheetChatHeight）。 */
  const [collabKeyboardShown, setCollabKeyboardShown] = useState(false);
  const [collabKeyboardHeight, setCollabKeyboardHeight] = useState(0);
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
  /* 键盘开/关不再走 React state：唯一的消费点（meta row 淡出 + pointerEvents）已改由 kbAnimHeight
   * SharedValue 在 UI 线程驱动（见 kbMetaRowStyle）。去掉 keyboardOpen state + Keyboard 监听后，
   * 键盘每次开合不再触发 composer 重渲染 —— 这正是「+」菜单弹出/关闭时 glass card 圆角闪烁的根因
   * （菜单弹出令键盘收起→setKeyboardOpen(false)、关闭令其弹回→(true)，两次重渲染各闪一帧方角）。 */
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
    return Math.max(sync ?? 0, insets.bottom);
  }, [insets.bottom]);
  /** 键盘收起时输入簇要抬起的底部间距（导航栏 / 安全区）。不再依赖 keyboardOpen state —— 改由下面
   *  navInsetAnimStyle 在 UI 线程随键盘高度插值，避免长对话页 React 重渲染慢导致"偏移非常延迟"。 */
  const restingNavInset = bottomInsetTotal(bottomInset);
  /** 底部整块高度：渐变 + 输入区 + 导航栏 inset（恒为 resting 值，不随键盘变 → 不触发重渲染） */
  const bottomOverlayHeight = gradientStripHeight + inputRowHeight + restingNavInset;
  /** 列表底部留白，让内容可滚入渐变下方 */
  const scrollBottomPadding = bottomOverlayHeight + 12;
  /* 协同模式 sheet 的三档高度。sheet 容器是整页高（bottom 贴屏底），composer 那一簇
   * 正好压在它最下面 bottomOverlayHeight 那段上，所以最矮一档 = composer 高度 + 一点 handle
   * 余量 —— 折叠后 sheet 只在 composer 上方露出一条把手，文档区几乎整屏可读。 */
  const collabSheetPeekHeight = bottomOverlayHeight + 56;
  /** sheet 容器高度 = containerInner 实测高 - topInset(headerHeight)，与 gorhom 给
   *  hosting container 的 `top: topInset, bottom: 0` 是同一个盒子。还没量到时为 0，
   *  下面的档位有兜底、补偿也会归零，onLayout 一到就回到真实值。 */
  const collabSheetContainerHeight = Math.max(0, collabHostHeight - headerHeight);
  /** 三档的**像素**高度。刻意不用 '58%' 这种百分比字符串：下面的可视高度补偿要拿这几个数
   *  做减法，只有两边同源才不会差一截（百分比由 lib 按它自己量到的容器高解析，我们看不见）。 */
  const collabSheetSnapHeights = useMemo(() => {
    /* 逐档取 max 保证严格递增：容器还没量到（首帧 / 极窄屏）时三档会算成 0 而撞在一起，
       gorhom 对重复或非递增的 snapPoints 会直接告警。量到之后自然回到真实比例。 */
    const mid = Math.max(
      collabSheetPeekHeight + 1,
      Math.round(collabSheetContainerHeight * COLLAB_SHEET_MID_RATIO),
    );
    const max = Math.max(mid + 1, Math.round(collabSheetContainerHeight * COLLAB_SHEET_MAX_RATIO));
    return [collabSheetPeekHeight, mid, max];
  }, [collabSheetPeekHeight, collabSheetContainerHeight]);
  const collabSheetSnapPoints = collabSheetSnapHeights;
  /* 【聊天区高度】直接给死像素高，不再靠「flex:1 撑满 + paddingBottom 补掉多余」那套。
   *
   * 起因：gorhom 恒按**最高档**给 sheet body 布局（BottomSheetContent 的高度 =
   * animatedSheetHeight = 容器高 - 最高档顶沿，与当前停在哪档无关），停在低档时整个 body
   * 连同里面的 ScrollView 一起被 translateY 推下去，垂到屏幕外那截照样是可滚动视口。
   * 前两版都想把这个差值补成 paddingBottom 压回去，实测都没生效 —— 补偿值本身算得没错
   * （见 collabSheetSnapHeights），问题出在它依赖「BottomSheetContent 的动画高度 → 我们
   * flex:1 的包装层 → ScrollView」这条高度传递链，链子上任一环没把高度定下来，flex:1 就
   * 退化成「按内容撑开」，ScrollView 视口直接变成内容高 —— 于是 offset 尽头 ≈ 0，
   * 「一打开就在底部、底下的内容却露不出来、稍微上滑就触顶拉更旧」三个现象同时成立。
   *
   * 所以这版不再参与那条链：包装层不用 flex，直接写死 height = 当前档高 - 把手高。
   * 父级怎么布局都不影响 ScrollView 拿到确定高度，视口恒等于 sheet 此刻真正露出来的那块。
   * 档高是我们自己定的像素（collabSheetSnapHeights），把手高用 handleStyle 钉死。 */
  const collabSheetVisibleHeight =
    collabSheetSnapHeights[collabSheetIndex] ?? collabSheetSnapHeights[collabSheetSnapHeights.length - 1];
  const collabSheetChatHeight = useMemo(() => {
    if (collabSheetContainerHeight <= 0) return 0;
    const maxH = collabSheetSnapHeights[collabSheetSnapHeights.length - 1];
    /* 键盘弹起时 interactive 会把 sheet 顶到「最高档 - 键盘高」：可视区涨到最高档，
       再被键盘上沿截断。没弹键盘就是当前档。 */
    const visible = collabKeyboardShown
      ? Math.min(maxH, collabSheetContainerHeight - collabKeyboardHeight)
      : collabSheetVisibleHeight;
    return Math.max(0, visible - COLLAB_SHEET_HANDLE_H);
  }, [
    collabSheetContainerHeight,
    collabSheetSnapHeights,
    collabSheetVisibleHeight,
    collabKeyboardShown,
    collabKeyboardHeight,
  ]);
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
  /* Meta row 的淡出：opacity 跟键盘动画绑，键盘弹起 → 渐淡出消失。lib height 是负数，- 它转正。
     pointerEvents 也一并由 SharedValue 驱动（键盘弹起淡出时不接收 touch）：以前靠 keyboardOpen
     React state 控制，会在键盘每次开合触发整棵 composer 重渲染 —— 「+」菜单弹出使键盘收起、关闭又
     使其弹回，两次 setState 重渲染那一帧原生 glass card 会闪一下方角（圆角"消失→恢复"）。改成纯
     worklet 驱动、与重渲染解耦后，菜单开合不再触发 composer 重渲染，圆角不再闪。 */
  const kbMetaRowStyle = useAnimatedStyle(() => {
    const h = -kbAnimHeight.value;
    const ratio = Math.min(h / 50, 1);
    return {
      opacity: 1 - ratio,
      pointerEvents: h > 4 ? ('none' as const) : ('auto' as const),
    };
  });
  /** drawer / mainPane 模式下用 props 覆盖；stack-push 模式下读 route.params */
  const params: ChatRouteParams | undefined =
    inDrawer || mainPane
      ? {
          conversationId: conversationIdOverride,
          conversationTitle: conversationTitleOverride,
        }
      : ((route.params ?? undefined) as ChatRouteParams | undefined);
  const [conversationId, setConversationId] = useState(params?.conversationId ?? '');
  const [conversationTitle, setConversationTitle] = useState(params?.conversationTitle ?? '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** 档 B 对话访问 / 批量标题解密授权：授权按钮已内嵌进触发它的工具卡（handleAuthorizationDecision +
   *  DefaultToolCard 的 awaiting_authorization 分支）。live 走 stream 的 tool_authorization_required 标记
   *  工具 block；刷新/重启走 GET 投影（applyConversationUsageState 记下 pendingAuthProjection）→ 下面的
   *  effect 按 tool_call_id 幂等标记该 block。提交决策时清 pendingAuthProjection，避免又把 block 翻回待授权。 */
  const [submittingAuthorizationId, setSubmittingAuthorizationId] = useState('');
  const [pendingAuthProjection, setPendingAuthProjection] = useState<{
    tcid: string;
    authReq: NonNullable<ToolBlock['auth_request']>;
  } | null>(null);
  useEffect(() => {
    if (!pendingAuthProjection) return;
    const { tcid, authReq } = pendingAuthProjection;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((msg) => {
        const blocks = (msg as { blocks?: ToolBlock[] }).blocks;
        if (!Array.isArray(blocks)) return msg;
        const nb = blocks.map((b) => {
          if (b?.type === 'tool' && String(b.tool_call_id || '') === tcid && b.status !== 'awaiting_authorization') {
            changed = true;
            return { ...b, status: 'awaiting_authorization', auth_request: authReq, authorization_error: '' };
          }
          return b;
        });
        return changed ? { ...msg, blocks: nb } : msg;
      });
      return changed ? next : prev;
    });
  }, [pendingAuthProjection, messages]);
  const [serverRawMessages, setServerRawMessages] = useState<ConversationMessage[]>([]);
  /** 消息窗口元数据（尾窗拉取时由 getConversation/getMessagesBefore 返回）；null = 全量（无窗口）。
   *  contextCompress 坐标变换 / regenerate 全局序号 / 滚到顶加载更旧 都读它。 */
  const [messageWindowMeta, setMessageWindowMeta] = useState<MessageWindow | null>(null);
  /** 最新值镜像 ref：供 handleRegenerate 等 useCallback 读 userCountBefore，不必进依赖。 */
  const messageWindowMetaRef = useRef<MessageWindow | null>(null);
  messageWindowMetaRef.current = messageWindowMeta;
  /** serverRawMessages 镜像供 prepend 读最新值不进依赖。 */
  const serverRawMessagesRef = useRef<ConversationMessage[]>([]);
  const loadingOlderRef = useRef(false);
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
  /** 会话级附件（助手/任务产出文件）：assistant markdown 里指向这些 url 的链接段落会渲染成文件卡片。 */
  const [conversationAttachments, setConversationAttachments] = useState<ConversationAttachment[]>([]);
  const [showTokenUsageInChat, setShowTokenUsageInChat] = useState(true);
  /** 语音「自动播报」(tts_autoplay) 当前值：⋯ 菜单里那行开关的勾选态（iOS UIMenu state / Android Switch）。
   *  播报模式(tts_broadcast_mode) 是全局态、由 ttsRealtime 单例 + BroadcastModeOverlay 管，这里不本地镜像。 */
  const [ttsAutoplay, setTtsAutoplay] = useState(false);
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
    /** 对话级所选模型（conv meta 的 model 字段）；effectiveSelectedModel 优先用它 */
    model?: string;
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
  /** flops 子agent「查看对话」→ 打开子对话内容 Overlay（target = 子对话 id）。 */
  const [subagentViewVisible, setSubagentViewVisible] = useState(false);
  const [subagentViewTarget, setSubagentViewTarget] = useState('');
  const [subagentViewTitle, setSubagentViewTitle] = useState<string | undefined>(undefined);
  const [subagentViewAgentType, setSubagentViewAgentType] = useState<'flops' | 'claude' | 'cursor'>('flops');
  const [subagentViewDeviceId, setSubagentViewDeviceId] = useState('');
  const [subagentViewCwd, setSubagentViewCwd] = useState('');
  const openSubagentView = useCallback(
    (args: { sessionId: string; title?: string; agentType?: 'flops' | 'claude' | 'cursor'; deviceId?: string; cwd?: string }) => {
      const sid = String(args?.sessionId || '').trim();
      if (!sid) return;
      setSubagentViewTarget(sid);
      setSubagentViewTitle(args?.title);
      setSubagentViewAgentType(args?.agentType || 'flops');
      setSubagentViewDeviceId(String(args?.deviceId || ''));
      setSubagentViewCwd(String(args?.cwd || ''));
      setSubagentViewVisible(true);
    },
    []
  );
  /** flops 子对话「打开原对话」：导航到该对话（作为独立会话打开）。 */
  const openConversationById = useCallback(
    (cid: string) => {
      const id = String(cid || '').trim();
      if (!id) return;
      navigation.navigate('Chat', { conversationId: id });
    },
    [navigation]
  );
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
  /* 切页回来重对齐 native 用：在稳定的 useFocusEffect 回调里读最新 composerDoc，
     不把 composerDoc 进 effect deps（否则每次输入都触发 re-sync）。 */
  const composerDocRef = useRef<SlateDocument>(composerDoc);
  useEffect(() => {
    composerDocRef.current = composerDoc;
  }, [composerDoc]);
  /* composer 是原生 FlowDocInputView（UITextView / EditText），不在 RN TextInputState 注册
   * 表里——Keyboard.dismiss() 找不到 first responder，且会另起一条 keyboard-will-hide 通知
   * 流跟 native blur 的键盘动画打架，所以这里只调 native blur。 */
  const dismissComposer = useCallback(() => {
    composerAdapterRef.current?.blur();
  }, []);
  /* Android composer 卡片按下放大 —— 跟 TodayScreen 搜索框胶囊同款 RNGH LongPress + worklet
   * spring scale。Tap 在 EditText 区域容易被 native gesture 抢 ownership 提前打断，所以
   * 用 LongPress；minDuration(0) 立即 active，maxDistance / shouldCancelWhenOutside
   * 放宽避免微移动触发 cancel。iOS 26 走 BouncyGlassCard 系统接管，不在这里管。 */
  const composerPressScale = useSharedValue(1);
  /** 「+」附件菜单开合：iOS 走 MenuView（打开时图标淡），Android 走自绘 popover。
   *  纯 SharedValue 驱动可见性 / 整卡淡出 / pointerEvents，不需要额外 boolean state。
   *  （声明提前到这里：下面 composerPressAnimStyle 的 worklet 要读它做整卡淡出。） */
  const composerAttachMenuShow = useSharedValue(0);
  /** backdrop pointerEvents 不走 Reanimated（Android 上 shared-value 驱动字符串
   *  prop 不可靠，会导致触摸穿透），改用 React state 直控。两平台共用：Android 是自绘
   *  popover 的关闭层；iOS 借同一层吞掉原生 UIMenu 收起时的穿透 touch——UIKit pull-down
   *  菜单对 platter 外的点按不拦 hit-test，outside tap 在触发 dismiss 的同时会照常命中
   *  底下的 app 视图（mic / 发送键被误触）。 */
  const [attachBackdropActive, setAttachBackdropActive] = useState(false);
  /** iOS：onCloseMenu 后 backdrop 延迟放开的 timer（防 UIKit 把穿透 touch 投递在
   *  onCloseMenu 之后；reopen 时要清掉，否则旧 timer 会把开着的菜单的 backdrop 关掉）。 */
  const attachBackdropOffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Android 附件菜单打开时整张 composer 卡片淡出 + 微缩（对齐 iOS「菜单出现时 composer
   * 让位」观感），菜单卡片在 composer 原位左下对齐长出来 = 「composer 变菜单」。
   * 跟按下 spring scale 乘进同一个 transform：同一 view 不能拆两条 useAnimatedStyle
   * （style 数组合并时 transform 数组整体后者覆盖前者）。旧 iOS 15-25 也走这个 wrapper,
   * 但那边 UIMenu 是系统渲染，不做整卡淡出。 */
  const composerPressAnimStyle = useAnimatedStyle(() => ({
    transform: [
      {
        scale:
          composerPressScale.value * (IS_ANDROID ? 1 - composerAttachMenuShow.value * 0.04 : 1),
      },
    ],
    opacity: IS_ANDROID ? 1 - composerAttachMenuShow.value : 1,
  }));
  /* composer 卡片按下放大用 RN raw onTouch* 而不是 RNGH（跟 TodayScreen 搜索框同样
   * 理由：Gesture.Manual 不 activate 在 EditText activate native gesture 后会被
   * cancel → spring 提前 down，按住保持不住放大）。raw onTouch* 独立于 responder
   * system / native gesture ownership，FlowDocInputView 内部 cursor placement /
   * 双击选词 / set selection 不被影响。
   * 这里只做 scale 动画，不 focus：raw onTouchEnd 对卡片子树内**任何** touch 都触发,
   * 包括 + / mic / 发送键——在这里 focus 会让点 + 弹键盘。输入框本体撑满整张 card
   * （composerAdapterFill），用户 tap 到它时 native EditText / UITextView 自己会
   * focus + 弹 IME，不需要 JS 补 focus。 */
  /** Android + 按钮按下期间压掉整卡放大的 guard（onPressIn/Out 开合，见下）。 */
  const composerAttachPressGuardRef = useRef(false);
  const onComposerTouchStart = useCallback(() => {
    /* Android + 按钮按下期间不做整卡放大（guard 由 + 的 onPressIn/Out 开合）：
     * 菜单定位靠 onPress 时 measureInWindow 卡片，而 Android 的 getLocationInWindow
     * 会把祖先 scale 矩阵算进坐标——按压 spring 到 ~1.06-1.1 时卡片左边线测偏左
     * 8-15dp，菜单跟静止卡片左下角对不齐。压掉放大也顺带消除「卡片先放大又立刻
     * 淡出让位」的动画打架。 */
    if (composerAttachPressGuardRef.current) return;
    composerPressScale.value = withSpring(1.01, PRESS_SPRING_CONFIG);
  }, [composerPressScale]);
  /** + 按钮 pressIn：挂 guard + 立刻 snap 按压 scale 回 1（raw onTouchStart 与 onPressIn
   *  同一 touch batch 内先后顺序无保证，两个方向都要拦：先 touchStart 后 pressIn → snap
   *  取消已启动的 spring；先 pressIn 后 touchStart → guard 拦住不启动）。pressIn 比
   *  onPress（measure 时机）早一整个 tap 时长，scale=1 有充足帧数落到 native 矩阵。 */
  const onComposerAttachPressIn = useCallback(() => {
    composerAttachPressGuardRef.current = true;
    composerPressScale.value = 1;
  }, [composerPressScale]);
  const onComposerAttachPressOut = useCallback(() => {
    composerAttachPressGuardRef.current = false;
  }, []);
  const onComposerTouchEnd = useCallback(() => {
    composerPressScale.value = withSpring(1, { mass: 1, stiffness: 220, damping: 14 });
  }, [composerPressScale]);
  const onComposerTouchCancel = useCallback(() => {
    composerPressScale.value = withSpring(1, { mass: 1, stiffness: 220, damping: 14 });
  }, [composerPressScale]);
  const [composerPickerOpen, setComposerPickerOpen] = useState(false);
  /** 「发送文件」待发附件（上传中 / 就绪 / 失败）；发送时就绪项进 flops_attachment 数组消息。 */
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);
  /** Android popover 锚点：composer 卡片本体（菜单在卡片原位左下对齐长出，见
   *  openAndroidComposerAttachMenu）。composerAttachMenuShow 声明提前到 composerPressAnimStyle
   *  上方（worklet 依赖顺序）。 */
  const composerCardRef = useRef<View>(null);
  /** popover 落点：left（对齐卡片左边线）+ bottom（距屏底偏移，菜单底边贴卡片底边）。
   *  垂直用 bottom 而非 top —— composer 是被 lib KAV 的键盘 padding 托着的：菜单开着时键盘
   *  一收（BACK / blur），composer 会落回屏底 ~360dp，top 钉死在 measure 瞬间的高位就悬空
   *  「严重偏上」。bottom 基准配合 composerAttachCardAnimStyle 里的键盘跟随项（kbAnimHeight
   *  worklet 逐帧补偿 max(键盘高, restingNavInset) 相对 open 时刻的变化量），菜单跟 composer
   *  一起骑键盘升降，底边任何时刻都贴卡片底边。
   *  用 SharedValue 而非 state：open 时坐标跟 show 动画同批落到 UI 线程，没有
   *  setState → re-render 慢半拍导致的首帧跳位（旧实现动画卡顿的来源）。 */
  const composerAttachMenuLeft = useSharedValue(16);
  /** open 时刻的基准 bottom = winH − (卡片底 Y)，见 openAndroidComposerAttachMenu。 */
  const composerAttachMenuBottom = useSharedValue(0);
  /** open 时刻的键盘基准 max(键盘高, restingNavInset)：worklet 里对着它算键盘位移增量。 */
  const composerAttachMenuKbBase = useSharedValue(0);
  /** bottom 上限（= 菜单顶不越过 insets.top+8），open 时按当时 menuH 算好快照。 */
  const composerAttachMenuBottomMax = useSharedValue(9999);
  /** popover 卡片实测高度（常驻 mount 后 onLayout 写入）：用于算 bottom 上限快照。 */
  const composerAttachMenuHeightRef = useRef(0);
  /** 编辑 Modal 内是否打开 picker（与主 composer 用同一个 modal 不同 ref 表） */
  const [editPickerOpen, setEditPickerOpen] = useState(false);
  /** picker dismiss 之后是否要把 firstResponder 还给对应 adapter。
   *  在 onPickDoc 里置 true，在 onAfterDismiss 里读 + 触发 focus 后清回 false。 */
  const pendingComposerFocusRef = useRef(false);
  const pendingEditFocusRef = useRef(false);
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
  /** bgPauseRecoveringRef 的渲染镜像：为 true 时不显示「Flops未回复任何内容」，
   *  否则回前台 resync/resume 落地前会闪一下这条误报。 */
  const [bgPauseRecovering, setBgPauseRecovering] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  /** P2 待发队列（agent 在跑时用户发的消息排这里，服务端存、多端可见）+ 立刻穿插乐观钉 */
  const [sendQueue, setSendQueue] = useState<Array<{ id: string; text: string; pending?: boolean }>>(
    [],
  );
  /** sendQueue 最新镜像：injectQueueItem 同步取被点项文本（不能靠 setSendQueue updater 副作用，那是异步的） */
  const sendQueueRef = useRef<Array<{ id: string; text: string; pending?: boolean }>>([]);
  sendQueueRef.current = sendQueue;
  const [liveInjections, setLiveInjections] = useState<Array<{ id: string; text: string }>>([]);
  /** server SIGTERM 期间收到 v2_reload_pending：消息流末尾显示「服务器热更新中」banner，
   *  下一次 fetch 收到任意非 reload_pending 事件时清掉。 */
  const [reloadPending, setReloadPending] = useState(false);
  /** reloadPending 的同步镜像。onEvent 是流式帧的入口（subagent 跑起来时每秒几十上百帧），
   *  必须能在**不触发状态写入**的前提下判断 banner 当前是不是亮着：
   *  - 直接 `setReloadPending(false)` 即使值没变也会让 React 重新渲染本组件（bail out 不保证
   *    跳过自身渲染），一帧一次，ChatScreen 这么大的树扛不住，提交首尾相接就撞
   *    "Maximum update depth exceeded"；
   *  - 读 `reloadPending` 又不行：onEvent 挂在 runV2WithHandlers 的闭包里，那个 useCallback
   *    只依赖 [session, applyConversationUsageState]，整条流期间闭包不刷新，读到的是陈旧值。 */
  const reloadPendingRef = useRef(false);
  const [currentAssistantBlocks, setCurrentAssistantBlocks] = useState<StreamBlock[]>([]);
  /** 渲染期镜像：resumeV2Stream 是 useCallback（依赖只有 session 那几个），闭包里读不到最新的
   *  currentAssistantBlocks，而它要靠「本地还有没有半截内容」决定能不能增量续流。 */
  const currentAssistantBlocksRef = useRef<StreamBlock[]>([]);
  currentAssistantBlocksRef.current = currentAssistantBlocks;
  /* 同款镜像：卸载的 cleanup 里要把这两个一起落进续流快照，而 cleanup 读不到最新 state。 */
  const streamingTextRef = useRef('');
  const streamStatusRef = useRef('');
  streamingTextRef.current = streamingText;
  streamStatusRef.current = streamStatus;
  const [error, setError] = useState('');
  const [submittingReviewId, setSubmittingReviewId] = useState('');
  /** 工具卡片展示状态：key -> 'collapsed' | 'preview' | 'full' */
  const [toolCardViewMode, setToolCardViewMode] = useState<Record<string, 'collapsed' | 'preview' | 'full'>>({});
  /** local_exec_command 执行中时每秒 +1，用于刷新耗时显示 */
  const [runningExecTick, setRunningExecTick] = useState(0);
  /** 概括读页（fetch_url_rendered summarize / 旧名 read_page_subagent）点击某条条目后打开的详情 Sheet（与 Task 页筛选同款 BottomSheetModal） */
  const [readPagesModalEntry, setReadPagesModalEntry] = useState<{
    cardKey: string;
    entryKey: string;
    entry: Record<string, unknown>;
  } | null>(null);
  /** 消息区（ScrollView + 全套钉底/贴底机制）的命令句柄，见 ChatMessageArea。 */
  const messageAreaRef = useRef<ChatMessageAreaHandle>(null);
  /** 消息区的钉底状态机（utils/chatBottomPin）。**刻意挂在这一层**：协同模式的布局分叉会把
   *  ChatMessageArea 换到 BottomSheet 下（跨父节点 = 整个实例重挂），状态若归它自己所有，
   *  路由 open 时武装的那个窗口会跟旧实例一起消失，新实例带着全量内容挂出来又不会再有
   *  内容变高事件，窗口就永远没人消费 → 列表停在最顶部。放这里能穿过重挂活下来。
   *  ChatScreen 本身按 conversationId 上 key，所以换会话时它自然是新的。 */
  const chatBottomPinRef = useRef(createBottomPinState());
  /** 摘要分界行原生节点，用于 measureLayout 相对 ScrollView 内容容器得到可 scrollTo 的偏移 */
  const contextCompressAnchorRef = useRef<View>(null);
  /** 流式文件卡片(半折叠)内部 ScrollView 引用，保持视图跟随最后几行 */
  const fileToolPreviewScrollRefs = useRef<Record<string, ScrollView | null>>({});
  /** key -> { startMs, completedSec }，用于 exec 卡片耗时与自动折叠 */
  const execCardTimeRef = useRef<Record<string, { startMs: number; completedSec?: number }>>({});
  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);
  /** 上一次流收到哪儿了：{这轮 run 的 id, 服务端口径的绝对游标}。
   *  切后台会 abort 流，streamChatV2Loop 的闭包（游标就在里面）随之消失；靠这个 ref 把位置
   *  留在组件上，回前台 resume 时接着往下收，而不是从 run 开头整轮重放。
   *  只在 runId 对得上时才用它，否则一律退回 0（新一轮 run 的游标空间与上一轮无关）。 */
  const resumeCursorRef = useRef<{ runId: string; cursor: number } | null>(null);
  const conversationIdRef = useRef(conversationId);
  const sessionRef = useRef(session);
  const pausedByBackgroundRef = useRef(false);
  /** 本实例是否还挂着。卸载后仍可能有在途的 promise 收尾（abort 是异步生效的），
   *  那些收尾不许再去动模块级的续流快照——否则会把「用户已经切回来、新实例正在用」的那份抹掉。 */
  const mountedRef = useRef(true);
  /**
   * 「这一轮是被切后台掐断的吗」——消费式判定（true 只返回一次）。
   *
   * 不能只在 catch 里判：abort **不一定抛异常**。consumeReader 的循环条件是
   * `while (alive() && !signal?.aborted)`，abort 若落在两次 read 之间（流式中处理帧的时候，
   * 也就是绝大多数时候），下一轮条件不成立就**正常返回**；streamChatV2Loop 那边同样有
   * `if (streamCompleted || signal?.aborted || !alive()) return;` 正常收尾。于是调用方的
   * try 顺利走完、catch 根本不执行，silentBackgroundAbort 一直是 false，finally 就把本地
   * 那半截流式内容清掉了 —— 回前台没有底可续，只能整轮重放。
   * 真机上「App Switcher（只 inactive、不 abort）好、真切后台（abort）坏」正是这个差别。
   */
  const consumeBackgroundAbortFlag = useCallback((): boolean => {
    if (!pausedByBackgroundRef.current) return false;
    pausedByBackgroundRef.current = false;
    return true;
  }, []);
  const hadBackgroundPauseRef = useRef(false);
  /** 本轮流是被「进后台」掐断的、还没定论（回前台后要么 resume 要么 resync）。
   *  ref 供 AppState 异步回调同步读，state 供渲染门控「未回复」提示。 */
  const bgPauseRecoveringRef = useRef(false);
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

  /* ───────────── 协同工作模式（四模态走马灯）布局感知 ─────────────
   * 服务端把「这个会话此刻开着哪篇文档 / 哪个项目」存在会话 meta 的 cowriter_layout 桶里，
   * 两条到达路径：初始 GET 带整桶快照、run 内工具驱动经 SSE 下发单槽 delta（见 utils/collabLayout）。
   * 这里只做感知 + 归一化；要不要分叉成 sheet 布局由下面的 collabActive 决定。 */
  const [collabLayout, setCollabLayout] = useState<CollabLayoutState>(EMPTY_COLLAB_LAYOUT);
  /** 布局态镜像：seq 守卫要在 setState 之外先算完（updater 必须是纯函数），
   *  且流式期间每秒几十帧都要读最新值，进不了 onEvent 那个长寿闭包的依赖。 */
  const collabLayoutRef = useRef<CollabLayoutState>(EMPTY_COLLAB_LAYOUT);
  /** SSE 布局帧 → 归一化 → 只有「可见形状真的变了」才写 state。
   *  seq 光往前走（同一篇文档被连改十次）不该把这棵 5000 行的聊天页推着重渲染。 */
  const applyCollabLayoutEvent = useCallback((payload: unknown) => {
    const prev = collabLayoutRef.current;
    const next = applyCollabLayoutPayload(prev, payload);
    if (!next) return;
    collabLayoutRef.current = next;
    if (!collabLayoutEqual(prev, next)) setCollabLayout(next);
  }, []);
  /** 会话 meta 里的整桶快照 → 布局态。会话没有该字段 = 非协同，归零。 */
  const hydrateCollabLayout = useCallback((conversation: Conversation) => {
    const seq = Math.floor(Number(conversation.cowriter_layout_seq)) || 0;
    const prev = collabLayoutRef.current;
    /* 同一会话内会反复 hydrate（history_revision、回前台 resync 都走同一个 funnel），
       快照可能比已应用的 SSE delta 旧：seq 落后就丢，别把 agent 刚打开的文档抹回去。 */
    if (seq < prev.seq) return;
    const next = collabLayoutFromConversationMeta(conversation.cowriter_layout, seq);
    collabLayoutRef.current = next;
    if (!collabLayoutEqual(prev, next)) setCollabLayout(next);
  }, []);
  /** 换会话 → 布局归零，等新会话自己 hydrate。 */
  /** 协同布局「溶解」进度 0→1（设计见下面 useAnimatedReaction 那段）。声明提到这儿是因为
   *  换会话的复位 effect 要把它列进依赖 —— 依赖数组在渲染期求值，声明晚了会踩 TDZ。 */
  const collabDismissProgress = useSharedValue(0);
  /** 松手已判定为「要关」：补完动画接管进度，逐帧那条 reaction 不再插手。 */
  const collabDismissCommitted = useSharedValue(false);
  /**
   * 开/关协同布局：**先武装钉底窗口，再切状态**。
   *
   * 切状态会把消息区在 sheet 与平铺容器之间搬家 = 整个实例重挂，新 ScrollView 第一帧停在
   * offset 0（对话最顶上的远古历史），要等布局事件回来才被钉到底 —— 那一两帧就是「关掉时
   * 闪一下」。窗口归 ChatScreen 持有（chatBottomPinRef），能穿过重挂活下来，所以**在切之前**
   * 武装好，新实例首帧就知道自己还没落位、先不画（见 ChatMessageArea 的 pinSettling）。
   * 放进 effect 里补是来不及的：useEffect 排在提交之后，那时首帧多半已经画出去了。
   *
   * 【已知行为，接受的设计】开/关的落点**一律是底部**：用户正在翻历史时切换，会被带回最新
   * 消息，原来的阅读位置不保留。
   *
   * 试过「离底距离锚点」（切换前记 contentHeight - viewportHeight - scrollY，新实例照这个
   * 距离还原）——放弃了。换容器会引发一连串异步落位：armForOpen 的三连补滚（立即 / rAF /
   * 200ms）、新实例的 onLayout（sheet 进场是动画量，每帧都 fire）、onContentSizeChange、
   * Android 那两发延迟补滚。它们跨了两百多毫秒、彼此没有先后保证，只要有一发绕开锚点就会把
   * 位置拽回底部；而这期间内容高度本身还在变（图片/附件量高），锚点算出来的 y 又不稳。
   * 逐个堵（让每处落位都走锚点、锚点改带有效期而不是用一次即弃）之后仍会在真机上偶发跳到
   * 顶部或跳回底部，性价比不划算。
   *
   * 未来若要重做，方向不是「事后 scrollTo 补偿」，而是**别让容器换**：像普通聊天页 header
   * 那样，视口上探到把手底下、用 contentContainer 的 paddingTop/Bottom 把内容压回来，让内容
   * 真正延伸进把手区。视口尺寸不变、实例不重挂，滚动位置天然就守住了。
   */
  const setCollabDismissedSettled = useCallback((next: boolean) => {
    messageAreaRef.current?.armForOpen();
    setCollabDismissed(next);
  }, []);
  const prevCollabConvIdRef = useRef(conversationId);
  useEffect(() => {
    const prev = prevCollabConvIdRef.current;
    prevCollabConvIdRef.current = conversationId;
    /* 「空 → 有 id」是本次发送刚把会话建出来，不是换会话：这一轮 run 里已经到达的布局帧要留着。 */
    if (prev === conversationId || !prev) return;
    collabLayoutRef.current = EMPTY_COLLAB_LAYOUT;
    setCollabLayout(EMPTY_COLLAB_LAYOUT);
    /* 换会话回到默认展开：关掉是「这次看这个会话时不想被挡着」，不该跟着人跑到下一个会话。 */
    setCollabDismissed(false);
    collabDismissProgress.value = 0;
    collabDismissCommitted.value = false;
  }, [conversationId, collabDismissProgress, collabDismissCommitted]);
  /** 这个会话有没有协同内容（数据侧判定）。要不要真画 sheet 还要看用户有没有把它关掉。 */
  const collabAvailable = useMemo(() => collabLayoutActive(collabLayout), [collabLayout]);
  /**
   * 用户把 sheet 往上拖过头关掉了 —— **纯本地视图状态**：不回写 /cowriter_layout、不动会话
   * 里的协同数据，桌面端毫无感知。关掉后 header 上留一个带角标的入口，点一下再开回来。
   * SSE 后续再来布局帧也**不自动弹回**：桌面端在那边翻文档，不该反复弹开手机这边的聊天。
   */
  const [collabDismissed, setCollabDismissed] = useState(false);
  /** 手机端此刻要不要进协同布局；false = 普通聊天页原样。停在哪个 tab 归 WorkspaceBody 管。 */
  const collabActive = collabAvailable && !collabDismissed;
  /** 关闭态入口上的角标 = 走马灯里有多少项（文档 + 项目 + 两个 mode 占位）。 */
  const collabTabCount = useMemo(() => collabTabs(collabLayout).length, [collabLayout]);
  /** 协同模式下装聊天消息区的 sheet，留在这里供程序化展开 / 折叠。 */
  const collabSheetRef = useRef<BottomSheet>(null);
  /** sheet 顶沿此刻的 y —— 走马灯指示器贴着它上方浮动（见 WorkspaceBody 的 sheetTopY）。
   *  gorhom 往外抛这个值时已经加过 topInset（lib 内 useAnimatedReaction: `内部位置 + topInset`），
   *  于是它与 collabWorkspaceLayer（containerInner 里的 absoluteFill）同一套坐标，可以直接用。
   *  起手给个远大于屏高的哨兵：lib 的 INITIAL_POSITION 就是 SCREEN_HEIGHT（sheet 从屏底升起），
   *  钳制会把指示器按在最低档上方，随 sheet 入场一起升上来，而不是先在 header 底下闪一帧。 */
  const collabSheetPosition = useSharedValue(COLLAB_SHEET_POSITION_UNSET);
  /** sheet 停在最低档（peek）时顶沿的 y = 指示器能落到的最低处。首帧还没量到高度时退化成
   *  header 下沿，onLayout 一到就回到真实值。 */
  const collabSheetLowestTopY = Math.max(headerHeight, collabHostHeight - collabSheetPeekHeight);
  /** 最高档顶沿的 y —— 过顶量从这儿量起。几何还没量到时给 -1（下面的判定恒不成立）。 */
  const collabSheetHighestTopY =
    collabHostHeight > 0
      ? collabHostHeight - collabSheetSnapHeights[collabSheetSnapHeights.length - 1]
      : -1;
  /**
   * 【协同布局的「溶解」进度】0 = 正常，1 = 已经化干净（此刻才真正切状态）。
   *
   * 关掉不是一次瞬切，而是一段**跟手的连续过渡**：从最高档继续往上拖，过顶量除以
   * COLLAB_SHEET_DISMISS_TRAVEL 就是进度 —— 拖到哪化到哪，往回拖就原样化回去。
   *
   * **手指按着的时候永远不切状态**（哪怕进度已经到 1）：切不切只在松手那一刻判一次，见下面
   * useCollabSheetGestureHandlers。所以取消权全程在用户手里 —— 化了一半后悔了，拖回去即可。
   * 松手不够 COMMIT 就交回 gorhom 那条回弹弹簧，进度跟着位置连续退回 0（不用我们再写一遍
   * 回弹动画）；够了就补完剩下那截再切 collabDismissed，接缝落在「已经化干净」那一帧上。
   *
   * 全程只有这一个量（collabDismissProgress，声明在上面换会话复位那段旁边）：sheet 的
   * 面/把手/顶部淡出带一起淡出，工作区内容淡出并微微后退，底色顺势插值成聊天页画布色 ——
   * 化完的那一帧就已经长得跟普通聊天页一样了。
   */
  /* gorhom 没有「拖拽结束」回调，档位类回调（onAnimate/onChange）又只报 snap 到哪一档、
     看不见过冲量；所以直接盯 animatedPosition，在 UI 线程上逐帧算进度。 */
  useAnimatedReaction(
    () => collabSheetPosition.value,
    (y) => {
      if (!collabActive || collabSheetHighestTopY < 0) return;
      /* 松手已判定关闭：进度交给补完动画，别再被位置带跑。 */
      if (collabDismissCommitted.value) return;
      /* 键盘弹起时 interactive 会把 sheet 抬到「最高档 - 键盘高」，那不是用户在拖。
         用键盘的动画量而不是 React 那份 state：后者在 Android 上落后一两帧，够误判一次。 */
      if (kbAnimHeight.value !== 0) {
        collabDismissProgress.value = 0;
        return;
      }
      const over = collabSheetHighestTopY - y;
      /* 只更新进度，**不切状态** —— 切与不切归松手那一刻判。 */
      collabDismissProgress.value = Math.min(1, Math.max(0, over / COLLAB_SHEET_DISMISS_TRAVEL));
    },
    [collabActive, collabSheetHighestTopY],
  );
  /**
   * sheet 手势：只截「松手」这一下，其余原样交回 gorhom 默认实现。
   *
   * 为什么走 gestureEventsHandlersHook 这个扩展点：v5.2.8 没有拖拽结束回调；onAnimate 又在
   * 「回弹到同一档」时直接 return（handleOnAnimate 里 `targetIndex === currentIndex` 就不发），
   * 而过顶松手恰好就是回到原档这一路 —— 拿不到信号。这个 hook 是官方导出的口子
   * （useGestureEventsHandlersDefault 也从包入口导出），provider 直接调用它取四个 handler。
   */
  const useCollabSheetGestureHandlers: GestureEventsHandlersHookType = () => {
    const defaults = useGestureEventsHandlersDefault();
    return useMemo(
      () => ({
        ...defaults,
        handleOnEnd: (source, payload) => {
          'worklet';
          if (
            !collabDismissCommitted.value &&
            collabDismissProgress.value >= COLLAB_SHEET_DISMISS_COMMIT
          ) {
            collabDismissCommitted.value = true;
            /* 补完剩下那截再切状态。这里**不**交回默认处理 —— sheet 不必回弹，
               它下一刻就要卸载了，让它停在手指松开的位置上化完即可。 */
            collabDismissProgress.value = withTiming(1, { duration: 140 }, (finished) => {
              'worklet';
              if (finished) runOnJS(setCollabDismissedSettled)(true);
            });
            return;
          }
          /* 不够 COMMIT：交回默认 —— 它会把 sheet 弹回档位，进度随位置连续退回 0。 */
          defaults.handleOnEnd(source, payload);
        },
      }),
      /* setCollabDismissedSettled 是 useCallback([])，恒定；linter 认不出 worklet 闭包里的
         引用，列进来反被判成多余依赖，故不列。 */
      [defaults],
    );
  };
  /** 工作区画布：底色从抽屉色插值到聊天页画布色，化完时已经是普通聊天页那块底。 */
  const collabWorkspaceCanvasStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      collabDismissProgress.value,
      [0, 1],
      [colors.drawerBackground, colors.chatScreenBackground],
    ),
  }));
  /** 工作区内容：淡出 + 轻微后退，像是被让开而不是被抹掉。 */
  const collabWorkspaceContentStyle = useAnimatedStyle(() => ({
    opacity: 1 - collabDismissProgress.value,
    transform: [{ scale: 1 - collabDismissProgress.value * 0.02 }],
  }));
  /** sheet 的「壳」（面 + 把手 + 顶部淡出带）一起淡出；**消息本身不淡** ——
   *  它要原地留到状态切换之后，这样交接时人眼盯着的那块内容是连续的。 */
  const collabSheetChromeStyle = useAnimatedStyle(() => ({
    opacity: 1 - collabDismissProgress.value,
  }));
  /** sheet 的面：把 gorhom 传进来的 backgroundStyle 原样接住，只额外挂上溶解透明度。 */
  const renderCollabSheetBackground = useCallback(
    ({ style }: { style?: StyleProp<ViewStyle> }) => (
      <Reanimated.View pointerEvents="none" style={[style, collabSheetChromeStyle]} />
    ),
    [collabSheetChromeStyle],
  );
  /** 把手：只自渲染握把本体（**不要**在这层铺任何不透明的面 —— 会盖掉 sheet 圆角，
   *  6ab8591 已经实测翻过一次车），外层容器高度仍是 collabSheetHandleBar 钉死的那份。 */
  const renderCollabSheetHandle = useCallback(
    () => (
      <View style={styles.collabSheetHandleBar}>
        <Reanimated.View style={[styles.collabSheetHandle, collabSheetChromeStyle]} />
      </View>
    ),
    [styles, collabSheetChromeStyle],
  );
  /** 关闭态 header 入口的淡入：跟溶解首尾相接，不要凭空蹦出来。 */
  const collabEntryOpacity = useSharedValue(0);
  useEffect(() => {
    collabEntryOpacity.value = withTiming(collabDismissed ? 1 : 0, { duration: 180 });
  }, [collabDismissed, collabEntryOpacity]);
  const collabEntryStyle = useAnimatedStyle(() => ({ opacity: collabEntryOpacity.value }));
  /* 键盘开合：协同模式下聊天区高度要按键盘上沿截断（见 collabSheetChatHeight）。
     只在协同模式挂监听，普通聊天页不用为此多两个订阅。 */
  useEffect(() => {
    if (!collabActive) {
      setCollabKeyboardShown(false);
      return;
    }
    const showEvt = IS_ANDROID ? 'keyboardDidShow' : 'keyboardWillShow';
    const hideEvt = IS_ANDROID ? 'keyboardDidHide' : 'keyboardWillHide';
    const subShow = Keyboard.addListener(showEvt, (e) => {
      setCollabKeyboardHeight(Math.round(e?.endCoordinates?.height ?? 0));
      setCollabKeyboardShown(true);
    });
    const subHide = Keyboard.addListener(hideEvt, () => setCollabKeyboardShown(false));
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, [collabActive]);
  /* 进/出协同模式时消息区换了容器 → React 必然重挂一次（跨父节点没法保留实例），
     滚动位置随之回到顶部。重新武装钉底窗口，让内容量完高度后自己贴回底部
     （armForOpen 是时间窗口式的，图片/附件慢慢量出高度也能跟上）。 */
  useEffect(() => {
    messageAreaRef.current?.armForOpen();
  }, [collabActive]);

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
    setConvLockedReason(conversation.locked_reason === 'need_parent' ? 'need_parent' : null);
    /* 档 B 对话访问 / 批量标题解密授权（刷新/重启续恢复）：GET 附带 pending_conversation_access /
     * pending_titles_authorization（含 tool_call_id）→ 记下投影，由 effect 按 tool_call_id 把触发它的
     * list_conversations / request_conversation_access 工具 block 标成 awaiting_authorization（按钮内嵌进该卡）。 */
    const pca = (conversation as { pending_conversation_access?: Record<string, unknown> }).pending_conversation_access;
    const pta = (conversation as { pending_titles_authorization?: Record<string, unknown> }).pending_titles_authorization;
    const authP = pca && pca.request_id ? { kind: 'access' as const, p: pca } : pta && pta.request_id ? { kind: 'titles' as const, p: pta } : null;
    if (authP && authP.p.tool_call_id) {
      const p = authP.p;
      const tids = Array.isArray(p.target_ids) ? (p.target_ids as unknown[]).map(String) : [];
      setPendingAuthProjection({
        tcid: String(p.tool_call_id),
        authReq: {
          kind: authP.kind,
          // 重载后从 pending_conversation_access.action 还原 send/read 文案（决策路径不变）。
          action: ((p as { action?: string }).action === 'send' ? 'send' : 'read') as 'send' | 'read',
          request_id: String(p.request_id),
          requester_conversation_id: String(p.requester_conversation_id || conversation.id || ''),
          count: Number(p.count || tids.length),
          target_ids: tids,
          target_conversation_id: String(p.target_conversation_id || ''),
          reason: String(p.reason || ''),
        },
      });
    }
    /* 协同布局：所有「拉会话 → 应用到 state」的入口都经这里，hydrate 也就只挂这一处。 */
    hydrateCollabLayout(conversation);
    setUsageStats(conversation.usage_stats ?? null);
    setUsageRuns(Array.isArray(conversation.usage_runs) ? conversation.usage_runs : []);
    setConversationAttachments(
      Array.isArray(conversation.attachments) ? conversation.attachments : [],
    );
    const sums = conversation.context_summaries;
    setContextSummaries(Array.isArray(sums) ? sums : []);
    const aid = conversation.active_context_summary_id;
    setActiveContextSummaryId(typeof aid === 'string' ? aid.trim() : '');
    const proj = conversation.context_projection_l1;
    setContextProjectionL1(proj && typeof proj === 'object' ? proj : null);
    const nextMeta = {
      bound_agent_id: typeof conversation.bound_agent_id === 'string' ? conversation.bound_agent_id : undefined,
      agent_profile: conversation.agent_profile,
      model: typeof conversation.model === 'string' ? conversation.model : undefined,
    };
    /* 同步写 ref：路由打开/前台恢复时会在同 microtask 里紧接调 resumeV2Stream → runV2WithHandlers
       同步读 conversationMetaRef，靠 useEffect 镜像太晚——会漏掉 agentEncryption，导致加密 agent
       的 chat_v2 POST 缺 k_agent_wire，server 返 400。 */
    conversationMetaRef.current = nextMeta;
    setConversationMeta(nextMeta);
  }, [hydrateCollabLayout]);

  const rawToLocalAssistantIndex = useMemo(
    () => rawMessagesToLocalWithUsageMap(serverRawMessages).rawToLocalAssistantIndex,
    [serverRawMessages]
  );

  /** 会话附件 url→attachment Map（对齐 web conversationAttachmentsMap）：MarkdownContent 段级识别用。 */
  const conversationAttachmentsMap = useMemo(() => {
    if (!Array.isArray(conversationAttachments) || conversationAttachments.length === 0) return null;
    const m = new Map<string, ConversationAttachment>();
    for (const att of conversationAttachments) {
      const url = typeof att?.url === 'string' ? att.url.trim() : '';
      if (!url) continue;
      if (!m.has(url)) m.set(url, att);
      // markdown-it 会 percent-encode 链接 href；原始 url 常含中文/空格。同时存一份 decode 后的 key，
      // 与 MarkdownContent 侧比较时的 decode 兜底构成双向归一，保证两种形态都能命中。
      let decoded = url;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        // 非法编码序列：退回原值，不额外存 key
      }
      if (decoded !== url && !m.has(decoded)) m.set(decoded, att);
    }
    return m.size > 0 ? m : null;
  }, [conversationAttachments]);

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
    const area = messageAreaRef.current;
    // 去掉 chatContentWrap 后，measureLayout 的参照改用 ScrollView 内容容器节点（即 contentContainerStyle
    // 那个 View）。相对它的 top 已含 contentContainer 的 paddingTop，等于该分界在滚动内容里的偏移。
    const innerNode = area?.getInnerViewNode();
    if (!divider || !area || innerNode == null) return;
    const runMeasure = () => {
      divider.measureLayout(
        innerNode,
        (_left, top, _width, height) => {
          const dividerCenter = top + Math.max(0, height) / 2;
          let viewportH = area.getViewportHeight();
          if (!(viewportH > 0)) {
            viewportH = Dimensions.get('window').height * 0.45;
          }
          const scrollY = Math.max(0, dividerCenter - viewportH / 2);
          area.scrollToPosition(scrollY, true);
        },
        () => {
          /* measureLayout 失败时忽略 */
        }
      );
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(runMeasure);
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

  /** 当前生效的模型（对话级）：开了对话用该对话的 model；草稿（无对话）用用户默认模型。
   *  对话的 model 已不在可切换列表（如供应商被移出 allowlist）时回退用户默认——与后端
   *  get_conversation_model / Web effectiveSelectedModel 一致。 */
  const effectiveSelectedModel = useMemo(() => {
    const userDefault = selectedModelId;
    if (!conversationId) return userDefault;
    const convModel = String(conversationMeta?.model || '').trim();
    if (convModel && modelOptions.some((o) => o.value === convModel)) return convModel;
    return userDefault;
  }, [conversationId, conversationMeta?.model, selectedModelId, modelOptions]);

  const composerModelTriggerLabel = useMemo(() => {
    const sel = effectiveSelectedModel;
    if (!sel) return '模型';
    const found = modelOptions.find((o) => o.value === sel);
    if (found) return found.label;
    return modelConfigLabel || sel;
  }, [effectiveSelectedModel, modelOptions, modelConfigLabel]);

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      const model = String(modelId || '').trim();
      if (!session || !model) return;
      setModelPickerOpen(false);
      const cid = String(conversationId || '').trim();
      /* 开了对话：只改这个对话的模型（对话级覆盖，可中途切换），不动用户默认。
         必须带 conversation_id —— 服务端跑对话时优先读对话 meta 的 model，只写用户默认
         压不过对话级覆盖（对话一旦在任意端切过模型就被钉死 = "切了不生效"的根因）。 */
      if (cid) {
        const prevModel = String(conversationMeta?.model || '').trim();
        if (model === prevModel) return;
        const patchConvModel = (m: string) =>
          setConversationMeta((c) => ({ ...(c ?? {}), model: m }));
        patchConvModel(model);
        try {
          const data = await selectModel(session, model, cid);
          patchConvModel(
            typeof data.conversation_model === 'string' ? data.conversation_model : model
          );
          // 价格表等全局映射顺带刷新（若返回）；其余对话级状态不动
          if (data.model_price_reference && typeof data.model_price_reference === 'object') {
            setModelPriceReference(data.model_price_reference as Record<string, unknown>);
          }
        } catch (e) {
          patchConvModel(prevModel);
          const msg = e instanceof Error ? e.message : String(e);
          Alert.alert('切换模型失败', msg);
        }
        return;
      }
      // 草稿（无对话）：改用户级默认模型——它会成为新对话创建时的种子
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
      conversationId,
      conversationMeta?.model,
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
        if (typeof prefs.tts_autoplay === 'boolean') {
          setTtsAutoplay(prefs.tts_autoplay);
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

  /* 报告"当前活跃对话"给 app 级实时 TTS 单例（它据此连 /api/ws/audio 朗读本对话）。
     获焦时报告；**失焦时清除 → 单对话流断连**：退回列表 / 切页 = 离开该对话，不该让 Mobile 的
     MOBILE_SINGLE(P2) 渠道滞留、把 Desktop/Web 一直压成"被手机播报"。播报模式(P1)全局、不受影响。 */
  useFocusEffect(
    useCallback(() => {
      setRealtimeActiveConversation(conversationId, session);
      return () => {
        clearRealtimeActiveConversation();
      };
    }, [conversationId, session])
  );

  /* 向 ConversationContext 上报「当前正打开着的对话」→ 未读闪点守卫：正看着的对话完成时收到的
     unread=true 被就地吞掉，不再「蓝点亮一下又被 mark-read 灭掉」。失焦（返回列表/切页）清 null，
     该对话恢复正常未读语义。新对话首发拿到 id 后 conversationId 变化会重跑、补登记。 */
  const setActiveConversation = useSetActiveConversation();
  useFocusEffect(
    useCallback(() => {
      setActiveConversation(conversationId || null);
      return () => {
        setActiveConversation(null);
      };
    }, [conversationId, setActiveConversation])
  );

  /* 打开 / 离开对话都向服务端真正标记已读——清 chat_v2_unread，而非仅本地压蓝点。
     服务端无独立 mark-read 接口：GET /api/conversations/:id 默认 mark_read=true 即会 pop
     chat_v2_unread + 广播 unread=False（对齐 FlopsDesktop index.js 的「活动会话即已读」收口，
     它同样用一次轻量 getConversation(id,{messagesLimit:1}) 触发）。路由首开的 mark-read 已由
     上面的 getConversation 承担，这里只补它漏掉的两个入口：
     - 聚焦：仅当服务端确有未读时发一次轻量 GET。覆盖「已加载会话被重新聚焦」——路由 effect 因
       loadedConversationIdRef 命中而跳过重拉、不再自带 mark-read（如离开去别的对话、期间本会话被
       别端点亮未读，再切回来）。
     - 失焦（离开会话）：无条件补发一次。聚焦期间本端/别端跑完时服务端会重新点亮 chat_v2_unread，
       本地蓝点被「活动会话守卫」吞掉不闪，但服务端仍是 unread=true，下拉刷新 loadConvs 会回灌。
       离开时清一次收口，避免蓝点复活。
     用 ref 读 unreadMap 只为聚焦时的判空，不进依赖——否则聚焦期间未读态每变一次就会重跑、
     误触发失焦分支的 GET。GET 结果丢弃（messagesLimit=1，纯为服务端副作用，不动本页 state）。 */
  const unreadMap = useUnreadConvMap();
  const unreadMapRef = useRef(unreadMap);
  unreadMapRef.current = unreadMap;
  /** 微信式左上角未读数：排除当前正打开的对话，统计其余仍未读的对话条数（>99 显 99+）。 */
  const otherUnreadCount = useMemo(() => {
    const curId = String(conversationId || '').trim();
    let n = 0;
    for (const id in unreadMap) {
      if (unreadMap[id] && id !== curId) n += 1;
    }
    return n;
  }, [unreadMap, conversationId]);
  useFocusEffect(
    useCallback(() => {
      const id = String(conversationId || '').trim();
      if (!id || !session) return;
      if (unreadMapRef.current[id]) {
        void getConversation(session, id, 1).catch(() => {});
      }
      return () => {
        void getConversation(session, id, 1).catch(() => {});
      };
    }, [conversationId, session])
  );

  /* 切页回来（如看完文档返回对话）重对齐 composer。
     以前这里 bump composerRemountKey 强制 keyed-remount——在原生 FlowDocInputView + Fabric
     view 回收下不可靠：空 composer remount 出来的 native view 可能是池子里复用的、刚才文档首块
     那张（textStorage 残留首行文本），而空 composer 的 initialContent="[]" 跟回收 view 的
     default prop 相等，updateProps 会跳过 setInitialContent，于是文档首行泄漏进输入框。
     改用 imperative setContent 把 native 重新对齐到 JS 真相（composerDoc）——同 view、可靠路径，
     跟发送后清空用的是同一套（见 sendMessage 注释）。空 doc → setContent('[]') → 清空。 */
  const composerResyncSkipFirstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (composerResyncSkipFirstFocusRef.current) {
        composerResyncSkipFirstFocusRef.current = false;
        return;
      }
      composerAdapterRef.current?.setContent(
        slateDocumentToContent(composerDocRef.current)
      );
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
  /** 语音听写当前的 pending 灰字（只在原生层渲染，不进 composerDoc）。RN 侧留一份镜像，
   *  用于让 composer 布局实时感知 pending 的存在并切到展开模式（见 composerTall）。
   *  刻意不并进 composerStats.hasContent —— 那会误开 Send，而发送会先取消听写、丢掉 pending。 */
  const [dictationPendingText, setDictationPendingText] = useState('');
  /** commit 已发给 native、但 committed 内容还没随 onChange 回进 composerDoc 的窗口标记。
   *  Android 上 UIManager 命令→事件要跨帧：这窗口里若清 pending 镜像，composerTall 的两个
   *  支撑（pending 镜像 / doc 内容）会同时为空一两帧，布局闪回 short 再弹回 tall。
   *  镜像改由 handleComposerDocChange 在新 doc 到达的同一渲染批里清。 */
  const dictationCommitInFlightRef = useRef(false);

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
    composerStats.textLen > 30 ||
    /* 语音听写有 pending 灰字时立即展开：让用户实时看到「文本在上、按钮一排在下」的编辑态。 */
    dictationPendingText.trim().length > 0;

  /** 是否有可发送内容：composerDoc 有内容，或语音听写 pending 有文字（pending 只在原生层，
   *  发送时由 handleSendMessage 打断听写并把它并进消息）。用于发送键的 enable / 停止态判定。 */
  /** 至少一个附件上传就绪 → 即便正文为空也可发送。 */
  const hasReadyAttachment = pendingAttachments.some((a) => a.status === 'ready' && a.url);
  const composerHasSendableContent =
    composerStats.hasContent || dictationPendingText.trim().length > 0 || hasReadyAttachment;

  const canSend = Boolean(
    session && composerStats.hasContent && !loading && !conversationHistoryLoading
  );

  const runV2WithHandlers = useCallback(
    async (opts: {
      convId: string;
      start: ChatV2StreamStart;
      signal: AbortSignal;
      /** resume 续流的起始游标；省略 = 从这轮 run 开头全量回放 */
      initialReplayFrom?: number;
      /** 续流时把本地已有的半截 blocks 垫进来，后续增量在它之上追加。
       *  不垫的话第一帧 syncBlocks 就会用「只含增量」的数组覆盖掉本地已有内容，
       *  界面上表现为前半段凭空消失、只剩尾巴。 */
      seedBlocks?: StreamBlock[];
    }): Promise<{
      streamDone: boolean;
      finalText: string;
      localBlocks: StreamBlock[];
      lastConvId: string;
    }> => {
      if (!session) throw new Error('未登录');
      const streamTargetRef = { current: opts.convId };
      // 续流时以本地已有内容为底，增量在其上继续（见 seedBlocks 注释）
      const localBlocks: StreamBlock[] = opts.seedBlocks ? [...opts.seedBlocks] : [];
      let finalText = localBlocks
        .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
        .map((b) => b.content)
        .join('');
      let streamDone = false;
      streamCaptureRef.current = { text: finalText, blocks: [...localBlocks] };

      /* ── 回放段批量应用 ──────────────────────────────────────────────────
       * 打开一个还在跑的对话时，服务端先补全部历史（回放段）再追实时。回放帧和实时帧
       * 以前走同一条路：每帧一次 syncBlocks → 两次 setState → 整棵 ChatScreen 重渲染，
       * 于是几百帧的回放变成肉眼可见的「重新打一遍字」。
       * 现在回放帧只改 localBlocks（内存），攒到交界处一次性 flush —— 已有进展瞬间出现，
       * 之后的实时帧恢复逐帧（流式的顺滑感来自那个逐帧）。
       * 判据是服务端契约给的 meta.replayed，不做任何内容比对。 */
      let currentFrameIsReplay = false; // 由 onEvent 每帧按 meta.replayed 置位
      let replayPending = false; // 有攒着没画的回放内容
      let replayPendingCount = 0;
      let replayQuietTimer: ReturnType<typeof setTimeout> | null = null;
      /** 回放期间攒够这么多帧就先画一次，免得超长回放（几千帧）期间界面长时间没反应 */
      const REPLAY_FLUSH_FRAMES = 60;
      /**
       * 「安静期」——距上一帧回放这么久还没有新帧，就把攒着的画出来。
       *
       * 必须是**防抖**（每来一帧重置）而不是从第一帧起算的固定窗口：回放帧是成串到达的，
       * 固定窗口会在串到一半时踩点触发，画出个位数帧的内容 —— 真机上就是「先冒一小段思考、
       * 卡一下、再瞬间全出来」。防抖则整串期间一次不画，串结束（或流真的停住）才画一次。
       *
       * 取 1000ms 而不是更短：SSE 是一块一块到的，蜂窝网下相邻网络分块之间隔上几百毫秒很正常，
       * 阈值短了会被这种正常间隙打中，表现为回放期间「小步更新好几次」再啪一下全出来。
       * 这个阀只为「流真的停住了」兜底，不需要灵敏；真·超长回放由下面的帧数上限管。
       */
      const REPLAY_QUIET_MS = 1000;

      /* ── 实时段合帧 ────────────────────────────────────────────────────────
       * 回放段（上面）攒的是「几百帧一次性出来」，实时段攒的是另一回事：**限制绘制频率**。
       * subagent 是唯一一个每 250ms 重发全量累积 agent_blocks 的工具，叠上 20ms 一批的文本流，
       * 实时帧能到每秒几十次；而每帧一次 paintBlocks = 一次整棵消息区重渲染（几十条历史消息
       * 连同全部工具卡一起 reconcile），于是 live 段直接卡死。
       * 这里把**绘制**合到 100ms 一次，**记账（captureBlocks）仍然逐帧** —— 见 captureBlocks 注释。
       * 首帧走 leading edge（空闲后第一帧立刻画），不给第一个 token 添延迟。 */
      const LIVE_PAINT_MS = 100;
      let livePaintTimer: ReturnType<typeof setTimeout> | null = null;
      let livePaintPending = false; // 冷却窗口内有攒着没画的实时内容

      /**
       * 每帧都要跑的记账：重算 finalText + 刷新中断/续流快照。
       *
       * **不能跟着绘制一起节流**：streamCaptureRef 是「点停止 / 切后台 / 卸载」时定格已有内容的
       * 唯一来源（见 handleStop、AppState handler、takeResumeSnapshot 的读取点），落后一个合帧
       * 窗口就会按「少一截」的版本落库；finalText 同理，它是本轮 run 的返回值。
       * 逐帧成本只有一次 filter/map/join + 一次数组浅拷贝，不碰 React。
       */
      const captureBlocks = () => {
        finalText = localBlocks
          .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
          .map((b) => b.content)
          .join('');
        streamCaptureRef.current = { text: finalText, blocks: [...localBlocks] };
      };

      /** 真正推给 React 的那两个 setState（React 19 自动合批 → 一次重渲染）。 */
      const paintBlocks = () => {
        setCurrentAssistantBlocks([...localBlocks]);
        setStreamingText(finalText);
      };

      const clearLivePaintTimer = () => {
        if (livePaintTimer) {
          clearTimeout(livePaintTimer);
          livePaintTimer = null;
        }
      };

      /** 立刻画 + 重置合帧窗口。用于「不能等」的帧（见 syncBlocks(immediate) 的调用点）。 */
      const paintNow = () => {
        clearLivePaintTimer();
        livePaintPending = false;
        paintBlocks();
      };

      /** 把合帧窗口里攒着没画的内容补画出来（没攒东西 = 空操作）。出口兜底用。 */
      const flushLivePending = () => {
        clearLivePaintTimer();
        if (!livePaintPending) return;
        livePaintPending = false;
        paintBlocks();
      };

      /** 实时帧的绘制调度：冷却窗口内只记账，窗口到点再画。 */
      const scheduleLivePaint = () => {
        if (livePaintTimer) {
          livePaintPending = true;
          return;
        }
        // leading edge：空闲后的第一帧立刻出，随后进入 100ms 冷却
        livePaintPending = false;
        paintBlocks();
        const tick = () => {
          if (!livePaintPending) {
            livePaintTimer = null; // 窗口内没有新帧 → 回到空闲，下一帧又走 leading edge
            return;
          }
          livePaintPending = false;
          paintBlocks();
          livePaintTimer = setTimeout(tick, LIVE_PAINT_MS);
        };
        livePaintTimer = setTimeout(tick, LIVE_PAINT_MS);
      };

      const applyBlocksToState = () => {
        captureBlocks();
        paintNow();
      };

      const clearReplayQuietTimer = () => {
        if (replayQuietTimer) {
          clearTimeout(replayQuietTimer);
          replayQuietTimer = null;
        }
      };

      /** 把攒着的回放内容画出来（没攒东西就是空操作）。 */
      const flushReplayPending = () => {
        clearReplayQuietTimer();
        if (!replayPending) return;
        replayPending = false;
        replayPendingCount = 0;
        applyBlocksToState();
      };

      /**
       * 事件处理器统一调它。回放帧只记账不渲染；实时帧逐帧记账、绘制按 100ms 合帧。
       *
       * `immediate`：绕过合帧窗口立刻画。只给「等不了」的帧用 —— 判据是**这一帧改的不是内容
       * 而是结构或用户可操作性**（定格当前回合、弹安全确认、整轮结束）。纯内容增长一律走合帧。
       */
      const syncBlocks = (immediate = false) => {
        if (!currentFrameIsReplay) {
          // 实时帧：记账逐帧，绘制合帧（攒着的回放内容已在 localBlocks 里，这一次就一起出来了）
          clearReplayQuietTimer();
          replayPending = false;
          replayPendingCount = 0;
          captureBlocks();
          if (immediate) paintNow();
          else scheduleLivePaint();
          return;
        }
        replayPending = true;
        replayPendingCount += 1;
        if (replayPendingCount >= REPLAY_FLUSH_FRAMES) {
          flushReplayPending();
          return;
        }
        // 防抖：每来一帧就把「安静期」推后，整串回放期间一次都不画
        clearReplayQuietTimer();
        replayQuietTimer = setTimeout(flushReplayPending, REPLAY_QUIET_MS);
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
        const lastIdx = localBlocks.length - 1;
        const last = localBlocks[lastIdx];
        if (last && last.type === 'thinking' && !last.closed) {
          // 必须替换成新对象（而非原地 += content）：ThinkingBlockView 是 React.memo，
          // 同引用会被 shallow compare 跳过 → 只显示第一个 token。
          localBlocks[lastIdx] = { ...last, content: last.content + chunk };
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
        const lastIdx = localBlocks.length - 1;
        const last = localBlocks[lastIdx];
        if (last && last.type === 'thinking' && !last.closed) {
          localBlocks[lastIdx] = { ...last, closed: true };
          syncBlocks();
        }
      };

      const onEvent = (event: ChatStreamEvent, meta?: ChatStreamFrameMeta) => {
        /* 本帧是不是回放段：syncBlocks 据此决定「攒着」还是「立刻画」。
           缺省当实时处理 —— 老行为，宁可多渲染也不会漏画。 */
        currentFrameIsReplay = meta?.replayed === true;
        /* 回放→实时的交界：在这里就把攒着的画出来，不能等某个实时帧恰好调 syncBlocks。
           像 usage / v2_run 这类帧不碰 blocks，若只在 syncBlocks 里 flush，回放内容会一直
           挂着不显示，直到下一个内容帧或流结束。 */
        if (!currentFrameIsReplay) flushReplayPending();
        /* Phase 4 reload-pending：必须在所有 early return（v2_run / 错误 / etc）之前处理。
           reload reconnect 后 buffer replay 第一条往往是 v2_run，会被下面 early return 吞掉，
           如果 setReloadPending(false) 放后面就永远清不掉 banner。 */
        if ('type' in event && event.type === 'v2_reload_pending') {
          reloadPendingRef.current = true;
          setReloadPending(true);
          return;
        }
        /* 只在 banner 真亮着时才写状态。这里每帧都跑，无条件 setState 会把整棵 ChatScreen
           推着一帧重渲染一次（见 reloadPendingRef 声明处）。判定读 ref 不读 state：闭包里的
           reloadPending 是陈旧的。 */
        if (reloadPendingRef.current) {
          reloadPendingRef.current = false;
          setReloadPending(false);
        }
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
              const ix = prev.findIndex((x) => x.run_id === run.run_id);
              // 同一条 run 的 usage 会被反复推送；内容没变就返回 prev 让 React bail out，
              // 否则每个 usage 帧都新建数组 → 必然重渲染整棵 ChatScreen。
              if (ix >= 0 && usageRunEqual(prev[ix], run)) return prev;
              const ur = [...prev];
              if (ix >= 0) ur[ix] = run;
              else ur.push(run);
              return ur;
            });
          }
        }
        /* 协同布局帧（agent 刚读/写了文档或任务 → 服务端开对应工作区）。
           线上两种 mode 的 delta **都**是 type='cowriter_layout'，具体看 layout.layout_mode；
           coplanner_layout 一并认，是为防服务端哪天按 ProductEvent 的 kind 命名下发。 */
        if (e.type === 'cowriter_layout' || e.type === 'coplanner_layout') {
          applyCollabLayoutEvent(event);
        }
        if ('error' in event && event.error) throw new Error(String(event.error));
        if ('type' in event) {
          /* Phase 4 reload-pending：server SIGTERM 时主动通知；UI 显示「服务器热更新中」banner，
             API 层自动断开 reader 进入 reconnect 等 server 起来。任何后续 chunk（包括 v2_step_rollback
             或新内容）来时把 banner 清掉。 */
          if (event.type === 'v2_reload_pending') {
            reloadPendingRef.current = true;
            setReloadPending(true);
            return;
          }
          /* 到这里 banner 其实已被上面那处清掉了，留着兜「上面提前 return 的路径」；
             同样读 ref——闭包里的 reloadPending 是陈旧值，会漏清或空写。 */
          if (reloadPendingRef.current) {
            reloadPendingRef.current = false;
            setReloadPending(false);
          }
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
            // 同 index 的上一块已完成（跨 step 复用 0 基 index）→ 新建块而非覆盖；
            // 自动桥接的合成 tool_call 无前置 tool_call_start，仅发 ready，正需此分支（否则会盖掉上一步的卡）。
            const existingCompleted = i >= 0 && localBlocks[i].type === 'tool' && localBlocks[i].status === 'completed';
            if (i >= 0 && localBlocks[i].type === 'tool' && !existingCompleted) {
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
            // 续起完成信号：apply_resume 注入挂起工具结果后发的 tool_result 带 resumed+tool_call_id。据此把
            // messages 里「那条挂起/提交中的工具卡」按 tool_call_id 精确置 completed（挂起工具卡在 messages 里、
            // 不在本 stream 的 localBlocks，故直接 setMessages），修「点允许后一直卡在提交中」。
            if (event.resumed && event.tool_call_id) {
              const tcid = String(event.tool_call_id);
              const isSuspended = (s: string) =>
                s === 'awaiting_authorization' || s === 'awaiting_confirmation' || s === 'confirming';
              const patchB = (b: ToolBlock): ToolBlock =>
                b?.type === 'tool' && String(b.tool_call_id || '') === tcid && isSuspended(b.status)
                  ? { ...b, status: 'completed', result: event.result as ToolBlock['result'], auth_request: undefined }
                  : b;
              setCurrentAssistantBlocks((prev) => prev.map((b) => patchB(b as ToolBlock)));
              setMessages((prev) =>
                prev.map((msg) => {
                  const blocks = (msg as { blocks?: ToolBlock[] }).blocks;
                  if (!Array.isArray(blocks)) return msg;
                  return { ...msg, blocks: blocks.map(patchB) };
                }),
              );
            }
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
          if ((event as { type?: string }).type === 'user_injection') {
            // P2 用户「立刻穿插」流式推来 → 内联进当前工作块
            const ev = event as { content?: string };
            const injContent = typeof ev.content === 'string' ? ev.content : '';
            localBlocks.push({
              type: 'user_injection',
              content: injContent,
              arrival: 'injection',
            });
            syncBlocks();
            // 收到服务端推送 → 撤掉对应乐观钉，避免重复
            setLiveInjections((p) => p.filter((it) => it.text !== injContent));
          }
          if ((event as { type?: string }).type === 'task_event') {
            // 活跃 run 期间穿插进来的后台任务事件（成功/失败一视同仁）→ 实时内联卡片
            const ev = event as { content?: string; task_event?: TaskEventPayload; arrival?: string };
            localBlocks.push({
              type: 'task_event',
              task_event: ev.task_event ?? null,
              content: typeof ev.content === 'string' ? ev.content : '',
              arrival: ev.arrival === 'trigger' ? 'trigger' : 'injection',
            });
            syncBlocks();
          }
          if ((event as { type?: string }).type === 'send_queue_trigger') {
            // P2：流式中途消费待发队首作为 trigger 用户回合 → 定格当前 assistant 回合 + 加 user 气泡
            //      + 重置流式累积块（done 再 reload 纠正）+ 移除已消费待发条
            const ev = event as { content?: string; metadata?: Record<string, unknown> };
            const tc = typeof ev.content === 'string' ? ev.content : '';
            const assistantBlocks = [...localBlocks];
            const assistantText = finalText;
            if (assistantBlocks.length > 0 || assistantText.trim()) {
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content: assistantText.trim() || '(empty response)',
                  blocks: assistantBlocks.length ? assistantBlocks : undefined,
                },
              ]);
            }
            const _refs = ev.metadata && Array.isArray((ev.metadata as { flops_refs?: unknown }).flops_refs)
              ? ((ev.metadata as { flops_refs?: FlopsRef[] }).flops_refs as FlopsRef[])
              : undefined;
            setMessages((prev) => [
              ...prev,
              _refs && _refs.length ? { role: 'user', content: tc, flops_refs: _refs } : { role: 'user', content: tc },
            ]);
            localBlocks.length = 0;
            /* immediate：这一帧把当前回合定格成一条 assistant 消息 + 清空流式气泡。两件事必须
               同一次提交里生效，否则合帧窗口内会出现「消息里一份、气泡里还留着一份」的重影。 */
            syncBlocks(true);
            setSendQueue((q) => q.filter((it) => it.text !== tc));
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
                    messageAreaRef.current?.armOnce();
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
            /* immediate：安全确认卡是要用户点的，整轮 run 就阻塞在这儿等，不进合帧队列排队。 */
            syncBlocks(true);
          }
          if (event.type === 'tool_authorization_required') {
            // 批量标题解密 / 档B对话访问授权：把授权请求挂到触发它的工具 block（list_conversations /
            // request_conversation_access），置 status=awaiting_authorization + auth_request，按钮内嵌进该卡。
            const authReq = {
              kind: (event.authorization_kind === 'access' ? 'access' : 'titles') as 'access' | 'titles',
              // send=写授权（subagent_continue 向无钥加密对话发消息）/ read=读授权：只切文案，决策仍走 access。
              action: (event.authorization_action === 'send' ? 'send' : 'read') as 'send' | 'read',
              request_id: String(event.request_id || ''),
              requester_conversation_id: String(event.requester_conversation_id || ''),
              count: Number(event.count || 0),
              target_ids: Array.isArray(event.target_ids) ? event.target_ids.map(String) : [],
              target_conversation_id: String(event.target_conversation_id || ''),
              reason: String(event.reason || ''),
            };
            if (authReq.request_id) {
              let attachedIdx = -1;
              if (typeof event.index === 'number') {
                const ix = findLastToolBlockByIndex(event.index);
                if (ix >= 0) attachedIdx = ix;
              }
              if (attachedIdx < 0) {
                for (let i = localBlocks.length - 1; i >= 0; i--) {
                  const b = localBlocks[i];
                  if (b.type === 'tool' && b.tool_name === event.tool_name) {
                    attachedIdx = i;
                    break;
                  }
                }
              }
              if (attachedIdx >= 0) {
                const b = localBlocks[attachedIdx];
                if (b.type === 'tool') {
                  localBlocks[attachedIdx] = { ...b, status: 'awaiting_authorization', auth_request: authReq, authorization_error: '' };
                  syncBlocks(true);
                }
              }
            }
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
          /* 整轮结束：把合帧窗口里最后那点内容立刻落地。等 100ms 到点也能出来，但 done 之后
             紧跟着就是 setMessages 定格 + setLoading(false)，晚一拍会让气泡先短一截再补上。
             回放段的 done 不在这儿画 —— 那是「整轮都是回放」的情形，照旧由 finally 里的
             flushReplayPending 一次性出，免得把攒好的回放拆成两次绘制。 */
          if (!currentFrameIsReplay) paintNow();
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
      try {
        await streamChatV2Loop(session, streamTargetRef.current, opts.start, onEvent, opts.signal, {
          isAlive: () => conversationIdRef.current === streamSessionConvId && !opts.signal.aborted,
          agentEncryption: _agentEnc,
          initialReplayFrom: opts.initialReplayFrom,
          /* 记住「这轮 run 收到哪儿了」，供切后台 / 切页面再回来时续流。每帧都调，只写 ref
             不 setState。卸载时再由 cleanup 把它连同 blocks 一起落进模块级快照。 */
          onCursorAdvance: (runId, cursor) => {
            resumeCursorRef.current = { runId, cursor };
          },
        });
      } finally {
        /* 兜底 flush：整轮全是回放（run 已跑完、末尾直接 done）时永远等不到「实时帧」那个
           交界，攒着的内容就画不出来。done / cancelled / reader 结束 / abort / 抛错 —— 所有
           出口都会走到这里，统一补一次。没攒东西时是空操作。 */
        flushReplayPending();
        /* 实时段合帧窗口同理：abort / 抛错 / reader 断开都可能停在「攒了没画」的一刻，
           而且必须在这里把 timer 清掉 —— 否则组件已经走人了还留一发 setState 定时器。 */
        flushLivePending();
      }

      return { streamDone, finalText, localBlocks, lastConvId: streamTargetRef.current };
    },
    [session, applyConversationUsageState, applyCollabLayoutEvent]
  );

  // ---- P2 待发队列：agent 在跑时回车发消息 → 排队（不打断当前 run）/ 立刻穿插 ----
  const _extractQueueText = useCallback((content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (p): p is { type: string; text: string } =>
            !!p && typeof p === 'object' && (p as { type?: string }).type === 'text' &&
            typeof (p as { text?: unknown }).text === 'string',
        )
        .map((p) => p.text)
        .join('');
    }
    return '';
  }, []);
  const fetchSendQueue = useCallback(
    async (cid?: string) => {
      const id = String(cid || conversationIdRef.current || '').trim();
      if (!id || !session) return;
      try {
        const items = await getSendQueue(session, id);
        if (String(conversationIdRef.current || '').trim() !== id) return;
        setSendQueue(items.map((m) => ({ id: m.id, text: _extractQueueText(m.content) })));
      } catch {
        /* ignore */
      }
    },
    [session, _extractQueueText],
  );

  /* ==================== 语音听写（实时 ASR → composer pending 灰字） ====================
     mic 按钮 tap-to-toggle：idle ↔ recording。点第二下立刻回 idle（mic 图标），不留中间态；
     session.stop() 只是发 finish 后在后台等服务端最终结果，onDone 到达时再把 pending commit
     成正式内容——这段"后台定稿"不再用一个可见状态表示，避免图标闪一下三个点。
     onResult 把累计文本整体写进 native pending（灰字，不进 composerDoc、不触发 onChangeContent）；
     onDone 把 pending commit 成正式内容；onError 也 commit 已识别部分（别让用户白说）+ 弹提示；
     cancel 丢弃 pending。发送 / 清空 composer 前若有进行中的听写先 cancel。 */
  type DictationState = 'idle' | 'recording';
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const dictationSessionRef = useRef<VoiceDictationSession | null>(null);
  const [dictationError, setDictationError] = useState('');
  const dictationErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 实时麦克风振幅（0~1 归一化 RMS）：onAmplitude 每 ~100ms 一拍，withTiming 插值后驱动 micPulseStyle。 */
  const micAmplitude = useSharedValue(0);
  /** 用户长按 mic 选中的麦克风源：'auto'（按连接情况自动）、'builtin'（iPhone 内置）、'headset'（耳机）。 */
  const preferredMicSource = useRef<'auto' | 'builtin' | 'headset'>('auto');
  const [currentMicSource, setCurrentMicSource] = useState<'auto' | 'builtin' | 'headset'>('auto');

  const flashDictationError = useCallback((message: string) => {
    setDictationError(message);
    if (dictationErrorTimerRef.current) clearTimeout(dictationErrorTimerRef.current);
    dictationErrorTimerRef.current = setTimeout(() => setDictationError(''), 4000);
  }, []);

  /** 打断进行中的听写：拆会话 + 丢弃 native pending 灰字 + 回 idle。返回被打断时的 pending 纯文本
   *  （取自 session.lastText，同步、无 React state 延迟），供发送路径把它并进消息 content。
   *  无会话时返回空串。幂等。 */
  const cancelActiveDictation = useCallback((): string => {
    const s = dictationSessionRef.current;
    const pending = s ? s.lastText : '';
    dictationSessionRef.current = null;
    if (s) s.cancel();
    composerAdapterRef.current?.cancelDictation();
    setDictationPendingText('');
    setDictationState('idle');
    return pending;
  }, []);

  /** commit native pending 灰字，RN 镜像的清空推迟到 committed 内容随 onChange 回进
   *  composerDoc 的那一渲染批（见 handleComposerDocChange）。立即清会闪帧：commit 是
   *  异步 native 命令，中间帧镜像和 doc 双双为空 → tall 闪回 short 再弹回。
   *  300ms 兜底防 native 不回 onChange（无 pending 灰字时 commitDictation 不 emit）。 */
  const commitDictationAndClearMirror = useCallback(() => {
    dictationCommitInFlightRef.current = true;
    composerAdapterRef.current?.commitDictation();
    setTimeout(() => {
      if (!dictationCommitInFlightRef.current) return;
      dictationCommitInFlightRef.current = false;
      setDictationPendingText('');
    }, 300);
  }, []);

  /** adapter onChange：native 内容为 truth 反向同步进 composerDoc。若有听写 commit 在途，
   *  同一渲染批里清 pending 镜像——doc 已含 committed 文本，composerTall 无缝接力不闪帧。 */
  const handleComposerDocChange = useCallback((doc: SlateDocument) => {
    setComposerDoc(doc);
    if (dictationCommitInFlightRef.current) {
      dictationCommitInFlightRef.current = false;
      setDictationPendingText('');
    }
  }, []);

  /** 长按 mic（仅 idle 时）：Bottom Sheet 弹出音频输入源选择器。
   *  无耳机时也弹（仅「手机/iPhone 麦克风」一项），确保长按始终有反馈。 */
  const [micSourceSheetOpen, setMicSourceSheetOpen] = useState(false);
  const [micSourceSheetOptions, setMicSourceSheetOptions] = useState<ModelSelectOption[]>([]);
  const micSourceOptions = useRef<ModelSelectOption[]>([
    {
      label: Platform.OS === 'ios' ? 'iPhone 麦克风' : '手机麦克风',
      value: 'builtin', subtitle: '', icon: 'phone-portrait-outline',
    },
    { label: '耳机麦克风', value: 'headset', subtitle: '', icon: 'headset-outline' },
  ]);
  const onMicLongPress = useCallback(() => {
    if (dictationState !== 'idle') return;
    const openSheet = () => {
      AudioManager.getDevicesInfo().then((info: any) => {
        // 每次按连接情况新建选项数组（不 mutate 模板）；文案只说麦克风输入，别让用户误以为在选输出
        const [builtin, headset] = micSourceOptions.current;
        let sheetOpts: ModelSelectOption[];
        // 开 sheet 前同步当前选中值：'auto' 的实际行为就是 builtin（A2DP 分离），✓ 落在内置麦上
        const pref = preferredMicSource.current;
        let cur: 'builtin' | 'headset' = pref === 'auto' ? 'builtin' : pref;
        if (Platform.OS === 'android') {
          // Android 端 getDevicesInfo 的 currentInputs/currentOutputs 恒为空数组，只能看
          // availableInputs；字段是 type（人话字符串），USB / LE Audio 耳机映射不全落在
          // "Other (n)"（22=USB_HEADSET、11=USB_DEVICE、26=BLE_HEADSET）
          const ins: any[] = info?.availableInputs || [];
          const bt = ins.find((d: any) => d.type === 'Bluetooth SCO' || d.type === 'Other (26)');
          const wired = ins.find((d: any) =>
            d.type === 'Wired Headset' || d.type === 'Other (22)' || d.type === 'Other (11)');
          if (bt) {
            sheetOpts = [
              { ...builtin, subtitle: '保持耳机播放的同时用手机麦克风讲话' },
              { ...headset, label: `${bt.name} 麦克风`, subtitle: '用耳机同时播放和讲话' },
            ];
          } else if (wired) {
            // 有线插上系统强制走耳机麦、钉不回内置麦（Oboe 跟随默认路由），降级只出单项
            sheetOpts = [{ ...headset, label: '有线耳机麦克风', subtitle: '已插入有线耳机，播放和讲话都走耳机' }];
            cur = 'headset';
          } else {
            sheetOpts = [{ ...builtin }];
            cur = 'builtin';
          }
        } else {
          const outs: any[] = info?.currentOutputs || [];
          const bt = outs.find((o: any) =>
            o.category === 'BluetoothA2DPOutput' || o.category === 'BluetoothA2DP' || o.category === 'BluetoothHFP');
          const wired = outs.find((o: any) =>
            o.category === 'Headphones' || o.category === 'Headset' || o.category === 'USBAudio');
          if (bt) {
            sheetOpts = [
              { ...builtin, subtitle: '保持耳机播放的同时用手机麦克风讲话' },
              { ...headset, label: `${bt.name} 麦克风`, subtitle: '用耳机同时播放和讲话' },
            ];
          } else if (wired) {
            sheetOpts = [
              { ...builtin, subtitle: '保持耳机播放的同时用手机麦克风讲话' },
              { ...headset, label: '有线耳机麦克风', subtitle: '用耳机同时播放和讲话' },
            ];
          } else {
            // 无耳机也弹：仅「iPhone 麦克风」单项，长按始终有反馈
            sheetOpts = [{ ...builtin }];
          }
        }
        setCurrentMicSource(cur);
        setMicSourceSheetOptions(sheetOpts);
        setMicSourceSheetOpen(true);
      }).catch(() => {});
    };
    if (!Keyboard.isVisible()) {
      openSheet();
      return;
    }
    // composer 是原生 FlowDocInputView，Keyboard.dismiss() 找不到 first responder（见
    // dismissComposer 注释），必须 native blur 收键盘；收起是硬件动画（~250ms），
    // 用 keyboardDidHide 精确等它结束再弹 sheet（600ms 兜底），否则 sheet 被键盘压住。
    let opened = false;
    const openOnce = () => {
      if (opened) return;
      opened = true;
      sub.remove();
      clearTimeout(fallback);
      openSheet();
    };
    const sub = Keyboard.addListener('keyboardDidHide', openOnce);
    const fallback = setTimeout(openOnce, 600);
    dismissComposer();
  }, [dictationState, dismissComposer]);
  const handleSelectMicSource = useCallback((value: string) => {
    preferredMicSource.current = value as 'builtin' | 'headset';
    setCurrentMicSource(value as 'builtin' | 'headset');
    // 不在这里关 sheet：BlurSelectSheet 选中后播 1s 动效反馈再自行调 onClose
  }, []);

  /** mic 点击：idle→开始录音；recording→立刻停（回 idle，后台等 onDone 定稿）。 */
  const onMicPress = useCallback(async () => {
    if (dictationState === 'recording') {
      // 立刻回 idle（mic 图标 / 停脉冲）；session 在后台发 finish 等最终结果，onDone 里 commit
      ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
      dictationSessionRef.current?.stop();
      setDictationState('idle');
      return;
    }
    // 上一段还在后台定稿（ref 仍在）时忽略，避免两段会话重叠 commit 错内容
    if (!session || dictationSessionRef.current) return;
    ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
    setDictationError('');
    const s = new VoiceDictationSession({
      serverBaseUrl: session.server_base_url,
      token: session.access_token,
      preferredMicSource: preferredMicSource.current ?? undefined,
      onAmplitude: (rms) => {
        // ~100ms 一拍的硬台阶 → 80ms 线性插值成平滑斜坡
        micAmplitude.value = withTiming(rms, { duration: 80, easing: Easing.linear });
      },
      onResult: (text) => {
        // ASR 每次回全量累计文本 → 整体替换 native pending 灰字（流式增删）
        composerAdapterRef.current?.setDictationPending(text);
        setDictationPendingText(text); // RN 镜像，驱动 composerTall 实时展开
      },
      onDone: (finalText) => {
        if (dictationSessionRef.current === s) dictationSessionRef.current = null;
        if (finalText) composerAdapterRef.current?.setDictationPending(finalText);
        commitDictationAndClearMirror();
        setDictationState('idle');
        composerAdapterRef.current?.focus();
      },
      onError: (message) => {
        if (dictationSessionRef.current === s) dictationSessionRef.current = null;
        commitDictationAndClearMirror(); // 已识别的部分照样落地
        setDictationState('idle');
        flashDictationError(message);
      },
      onNotice: flashDictationError, // 非致命（如耳机麦不可用回落内置麦）：只闪提示，录音继续
    });
    dictationSessionRef.current = s;
    setDictationState('recording'); // 乐观：权限被拒时 onError 会回 idle
    await s.start();
  }, [dictationState, session, flashDictationError, commitDictationAndClearMirror]);

  // 非录音态：振幅归零（缩回底圆）。录音态由 onAmplitude 回调实时驱动 micAmplitude。
  useEffect(() => {
    if (dictationState !== 'recording') {
      micAmplitude.value = withTiming(0, { duration: 150 });
    }
  }, [dictationState, micAmplitude]);

  /* 录音中的红色涟漪：图标后面的圆形背景随麦克风实时振幅往外扩散并淡出——说话响则放大、
     涟漪扩散，安静则缩回 1x 底圆。图标本身不变色，只有这个背景圆在动。 */
  const micPulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + micAmplitude.value * 0.4 }],
    opacity: 0.35 * (1 - micAmplitude.value * 0.5),
  }));

  // 切换对话 / 卸载时放弃进行中的听写，避免会话泄漏
  useEffect(() => {
    return () => {
      const s = dictationSessionRef.current;
      dictationSessionRef.current = null;
      if (s) s.cancel();
      if (dictationErrorTimerRef.current) clearTimeout(dictationErrorTimerRef.current);
    };
  }, [conversationId]);

  /* 卸载时把「这轮 run 收到哪儿了 + 已经收到了什么」落进模块级快照。
   * DrawerShell 只挂一个顶层页且用 key 强制 remount（产品定的「不保留状态」），所以切到今日页
   * 本组件整个消失，state/ref 全没；再点回来是全新挂载，没有半截内容就只能 replay_from:0
   * 整轮重放。存到组件外面，重新挂载时就能接着收。
   * 只在这一处写 blocks（一次性 O(n) 拷贝），流式热路径上只更新 resumeCursorRef 那个数字。 */
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      const cur = resumeCursorRef.current;
      const blocks = currentAssistantBlocksRef.current;
      if (cur && conversationIdRef.current && blocks.length > 0) {
        saveResumeSnapshot({
          conversationId: conversationIdRef.current,
          runId: cur.runId,
          cursor: cur.cursor,
          blocks,
          text: streamingTextRef.current,
          status: streamStatusRef.current,
          savedAt: Date.now(),
        });
      }
      /* 存完必须把流掐掉。卸载时本来没有任何地方 abort——isAlive 读的 conversationIdRef 在
         闭包里活得好好的，于是这条流变成「孤儿」继续跑：它照样在收帧、照样会在 run 结束时
         走收尾同步，那里的 clearResumeSnapshot 就把刚存的快照抹了（也会跟用户回来后新起的
         那条流抢着改全局状态）。abort 只断本端订阅，服务端的 run 不受影响，跟切后台同理。 */
      if (abortRef.current && !manualStopRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  /** 入队当前 composer 内容（agent 跑时回车走这里）。乐观显示 + 失败回滚。
   *  opts.overrideText：程序化入队一条纯文本（show_visual 图卡忙态回注），不读/不清 composer、
   *  不动听写、不带引用。无该字段时行为不变。 */
  const enqueueCurrentComposer = useCallback(async (opts?: { overrideText?: string }) => {
    const id = String(conversationIdRef.current || '').trim();
    if (!id || !session) return;
    const overrideText = typeof opts?.overrideText === 'string' ? opts.overrideText.trim() : '';
    const isOverride = Boolean(overrideText);
    let text: string;
    let flops_refs: unknown[] = [];
    if (isOverride) {
      text = overrideText;
    } else {
      const ser = serializeSlateDocumentToUserMessage(composerDoc, composerRefDataByKeyRef.current);
      flops_refs = ser.flops_refs;
      /* 打断进行中的听写并取回 pending 尾巴，并进入队文本（跟 handleSendMessage 一致的语义）。 */
      const dictationTail = cancelActiveDictation();
      text = (ser.content + dictationTail).trim();
      if (!text && flops_refs.length === 0) return;
      setComposerDoc([{ type: 'paragraph', children: [{ text: '' }] }]);
      composerRefDataByKeyRef.current = new Map();
      /* 可靠清空：imperative 命令直接清 native 内容。不靠 keyed-remount 重读空 initialContent——
         Fabric view 回收 + initialContentApplied 守卫让 remount 清空不可靠（旧文本残留）；
         保持同一 native view + setContent('[]') 是可靠路径。切页回来重对齐也是同一套（见 useFocusEffect）。 */
      composerAdapterRef.current?.clear();
    }
    const tempId = `tmp-${Date.now()}`;
    setSendQueue((q) => [...q, { id: tempId, text, pending: true }]);
    try {
      const { id: newId } = await enqueueSendQueue(session, id, text, flops_refs);
      setSendQueue((q) => q.map((it) => (it.id === tempId ? { id: newId || tempId, text } : it)));
    } catch (e) {
      setSendQueue((q) => q.filter((it) => it.id !== tempId));
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, composerDoc, cancelActiveDictation]);
  const deleteQueueItem = useCallback(
    async (itemId: string) => {
      const id = String(conversationIdRef.current || '').trim();
      setSendQueue((q) => q.filter((it) => it.id !== itemId));
      if (!id || !session || !itemId || itemId.startsWith('tmp-')) return;
      try {
        await deleteSendQueueItem(session, id, itemId);
      } catch {
        /* ignore */
      }
    },
    [session],
  );
  /** 把某条待发改为「立刻穿插」：移出队列 → 注入当前活跃 run（乐观钉在流式末尾）。 */
  const injectQueueItem = useCallback(
    async (itemId: string) => {
      const id = String(conversationIdRef.current || '').trim();
      if (!id || !session || !itemId || itemId.startsWith('tmp-')) return;
      // 同步从 ref 取文本（不能靠 setSendQueue updater 副作用，那是异步的，乐观钉会拿不到文本）
      const found = sendQueueRef.current.find((it) => it.id === itemId);
      const injText = found ? found.text || '' : '';
      setSendQueue((q) => q.filter((it) => it.id !== itemId));
      if (injText) setLiveInjections((p) => [...p, { id: itemId, text: injText }]);
      try {
        await injectSendQueueItem(session, id, itemId);
      } catch {
        /* ignore */
      }
    },
    [session],
  );

  /** opts.overrideText：程序化发一条纯文本消息（show_visual 图卡回注），不读/不清 composer、
   *  不动听写、不带附件与引用；其余（建会话 / runV2WithHandlers / 收尾同步）与普通发送同路。
   *  注意本函数也直接挂在发送键 onPress 上（届时首参是 GestureResponderEvent，无该字段）→ 行为不变。 */
  const handleSendMessage = useCallback(async (opts?: { overrideText?: string }) => {
    const overrideText = typeof opts?.overrideText === 'string' ? opts.overrideText.trim() : '';
    const isOverride = Boolean(overrideText);
    /* 语音听写进行中按发送：pending 灰字只在原生层。先同步取 session.lastText 当"尾巴"，让它跟
       composerDoc 的内容一起决定能否发送 / 一起拼进消息。真正打断（cancel 会话 + 丢 native 灰字）
       放到确定要发送之后，避免 guard 未过就误杀听写。 */
    const dictationTail = isOverride ? '' : dictationSessionRef.current?.lastText ?? '';
    const hasDictationTail = dictationTail.trim().length > 0;
    // P2：agent 在跑时回车 → 入待发队列（不打断当前 run）；enqueue 内部会自己打断听写并并入 tail
    if (
      !isOverride &&
      loading &&
      session &&
      (composerStats.hasContent || hasDictationTail) &&
      conversationIdRef.current
    ) {
      void enqueueCurrentComposer();
      return;
    }
    /* 「发送文件」就绪附件：即便正文为空也可发送（对齐 web —— 会自动补一句提示文案）。 */
    const readyAtts = isOverride ? [] : readyAttachmentsToFlops(pendingAttachmentsRef.current);
    if (
      !session ||
      (!isOverride && !composerStats.hasContent && !hasDictationTail && readyAtts.length === 0) ||
      loading ||
      conversationHistoryLoading
    )
      return;
    /* 序列化 composerDoc → content（pill 还原为 mention_text）+ flops_refs（按 pill 出现顺序） */
    const { content: rawContent, flops_refs } = isOverride
      ? { content: overrideText, flops_refs: [] as FlopsRef[] }
      : serializeSlateDocumentToUserMessage(composerDoc, composerRefDataByKeyRef.current);
    /* 确定发送 → 立刻打断听写（cancel 会话 + 丢 native 灰字），pending 文字通过 dictationTail 并进 content。 */
    if (!isOverride) cancelActiveDictation();
    const nextMessage = (rawContent + dictationTail).trim();
    if (!nextMessage && flops_refs.length === 0 && readyAtts.length === 0) return;
    /* 有附件 → message 走多模态数组（text + flops_attachment parts）；无附件保持纯字符串旧行为。 */
    const outboundMessage = buildOutboundChatMessage(nextMessage, readyAtts);
    if (!isOverride) {
      /* 附件已随本次发送带走 → 清空待发附件 chips。 */
      if (readyAtts.length > 0) setPendingAttachments([]);
      /* 清空 composer：把 SlateDocument 重置为单段空 paragraph，refDataByKey 清空，再 bump key 强制 remount native */
      setComposerDoc([{ type: 'paragraph', children: [{ text: '' }] }]);
      composerRefDataByKeyRef.current = new Map();
      /* 可靠清空：imperative 命令直接清 native 内容。不靠 keyed-remount 重读空 initialContent——
         Fabric view 回收 + initialContentApplied 守卫让 remount 清空不可靠（旧文本残留）；
         保持同一 native view + setContent('[]') 是可靠路径。切页回来重对齐也是同一套（见 useFocusEffect）。 */
      composerAdapterRef.current?.clear();
    }
    setError('');
    setLoading(true);
    setStreamingText('');
    setCurrentAssistantBlocks([]);
    setStreamStatus('thinking');
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: nextMessage,
        ...(flops_refs.length > 0 ? { flops_refs } : {}),
        ...(readyAtts.length > 0 ? { attachments: readyAtts } : {}),
      },
    ]);
    messageAreaRef.current?.armOnce();

    let convId = conversationId;
    if (!convId) {
      try {
        const bid = String(draftAgentId || '').trim();
        const opts: { bound_agent_id?: string; encrypted?: boolean } = {};
        if (bid) opts.bound_agent_id = bid;
        if (createEncrypted) opts.encrypted = true;
        const created = await createConversation(session, Object.keys(opts).length ? opts : undefined);
        convId = created.id;
        setConversationId(created.id);
        conversationIdRef.current = created.id;
        setConversationTitle(nextMessage.slice(0, 50) || '新对话');
        /* 同步灌 meta（含 bound agent 的 agent_profile）：草稿对话首条消息走惰性创建，
           随后立即 runV2WithHandlers 同步读 conversationMetaRef 拼 k_agent_wire。漏了它，
           加密 bound agent 的 chat_v2 缺 k_agent_wire，server 返 400。对齐 getConversation 写法。 */
        const nextMeta = {
          bound_agent_id: created.bound_agent_id,
          agent_profile: created.agent_profile,
          model: created.model,
        };
        conversationMetaRef.current = nextMeta;
        setConversationMeta(nextMeta);
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
        start: { tag: 'new_message', message: outboundMessage, flops_refs },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      /* abort 常常不抛异常、直接正常返回（见 consumeBackgroundAbortFlag）。这里补判一次：
         被后台掐断就跟 catch 那条路一样收尾 —— 标记 silentBackgroundAbort 让 finally 保留
         本地半截内容（回前台好接着收），并跳过下面这发全量同步（马上进后台，白拉；
         回前台的 AppState 分支会统一 resync/resume）。 */
      if (consumeBackgroundAbortFlag()) {
        silentBackgroundAbort = true;
        return;
      }
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
          // run 收尾：答案已经并进 messages，续流快照没用了（留着也会被 runId 不匹配挡下，这里主动清）
          if (!stillRunning && mountedRef.current) clearResumeSnapshot(syncId);
          if (streamDone || finalText.trim() || synced.length > 0) {
            messageAreaRef.current?.armOnce();
            setMessages(synced);
          }
          const t = conversation?.title?.trim();
          if (t) setConversationTitle(t);
        }
      } catch {
        if (streamDone || finalText.trim()) {
          messageAreaRef.current?.armOnce();
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
        messageAreaRef.current?.armOnce();
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
        messageAreaRef.current?.armOnce();
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
      /* 被后台掐断时**保留**这半截流式内容：run 在服务端还跑着，回前台 resume 要拿它当底
         接着往下收（见 resumeV2Stream 的 canResumeIncrementally）。清掉的话本地没底了，
         只能退回从 run 开头整轮重放 —— 那正是「切回来稀里哗啦重放一遍」的由来。
         正常结束/报错仍旧清空：那时回复已落库进 messages，留着会显示两份。 */
      if (!silentBackgroundAbort) {
        setStreamingText('');
        setCurrentAssistantBlocks([]);
        // 状态文案也一起留着：恢复窗口里气泡还挂着，清空会让标题在「thinking」和空之间闪一下
        setStreamStatus('');
      }
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
    consumeBackgroundAbortFlag,
    draftAgentId,
    enqueueCurrentComposer,
    cancelActiveDictation,
  ]);
  /** 发送键的 onPress 适配：吞掉 GestureResponderEvent，别让它落到 handleSendMessage 的 opts 上。 */
  const handleSendPress = useCallback(() => {
    void handleSendMessage();
  }, [handleSendMessage]);

  // 打开对话 / 流式起止时同步待发队列；流结束清掉乐观穿插钉
  useEffect(() => {
    if (conversationId) void fetchSendQueue(conversationId);
    else setSendQueue((prev) => (prev.length === 0 ? prev : []));
    // 空数组也是新引用：本来就空的时候直接返回 prev，让 React bail out 掉这次重渲染
    if (!loading) setLiveInjections((prev) => (prev.length === 0 ? prev : []));
  }, [conversationId, loading, fetchSendQueue]);
  // 持久化的穿插用户消息（user_injection block）到达 messages 后移除对应乐观钉，避免重复
  useEffect(() => {
    setLiveInjections((prev) => {
      if (prev.length === 0) return prev;
      const persisted = new Set<string>();
      for (const m of messages) {
        const blocks = (m as { blocks?: Array<{ type?: string; content?: unknown }> })?.blocks;
        if ((m as { role?: string })?.role === 'assistant' && Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b && b.type === 'user_injection') {
              persisted.add(typeof b.content === 'string' ? b.content : '');
            }
          }
        }
      }
      if (persisted.size === 0) return prev;
      const next = prev.filter((it) => !persisted.has(it.text));
      return next.length === prev.length ? prev : next;
    });
  }, [messages]);

  const handleStop = useCallback(async () => {
    setError('');
    manualStopRef.current = true;
    const snapshotBlocks = [...currentAssistantBlocks];
    const snapshotText = streamingText;
    if (snapshotBlocks.length > 0 || (snapshotText && snapshotText.trim())) {
      messageAreaRef.current?.armOnce();
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
      /** 用户已确认"非最新重生成会丢中间消息" → 带 confirm 重试（见 catch 里 409 处理） */
      confirmNonLatest?: boolean,
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
    messageAreaRef.current?.armOnce();

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
      const confirmFlag = confirmNonLatest ? { confirm_non_latest_regenerate: true } : {};
      const regenStart: ChatV2StreamStart = reprocTid
        ? { tag: 'regenerate', regenerate_after_task_id: reprocTid, ...confirmFlag }
        : editedMessage !== undefined
          ? {
              tag: 'regenerate',
              after_user_index: globalAfterUserIndex,
              message: editedMessage,
              ...(editedFlopsRefs && editedFlopsRefs.length > 0
                ? { flops_refs: editedFlopsRefs }
                : {}),
              ...confirmFlag,
            }
          : { tag: 'regenerate', after_user_index: globalAfterUserIndex, ...confirmFlag };
      const { streamDone, finalText, localBlocks, lastConvId } = await runV2WithHandlers({
        convId: conversationId,
        start: regenStart,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      /* abort 常常不抛异常、直接正常返回（见 consumeBackgroundAbortFlag）。这里补判一次：
         被后台掐断就跟 catch 那条路一样收尾 —— 标记 silentBackgroundAbort 让 finally 保留
         本地半截内容（回前台好接着收），并跳过下面这发全量同步（马上进后台，白拉；
         回前台的 AppState 分支会统一 resync/resume）。 */
      if (consumeBackgroundAbortFlag()) {
        silentBackgroundAbort = true;
        return;
      }
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
          // run 收尾：答案已经并进 messages，续流快照没用了（留着也会被 runId 不匹配挡下，这里主动清）
          if (!stillRunning && mountedRef.current) clearResumeSnapshot(syncId);
          if (streamDone || finalText.trim() || synced.length > 0) {
            messageAreaRef.current?.armOnce();
            setMessages(synced);
          }
          const t = conversation?.title?.trim();
          if (t) setConversationTitle(t);
        }
      } catch {
        if (streamDone || finalText.trim()) {
          messageAreaRef.current?.armOnce();
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
      if (e instanceof NonLatestRegenerateConfirmError) {
        /* 非最新重生成需确认：本地已乐观截断了消息——取消时从服务器拉回原状复原；
           确认则带 confirm 重试（会真正丢弃中间消息）。 */
        const d = e.detail;
        const drop = d.messages_to_drop ?? 0;
        const resync = () => {
          if (!session || !conversationId) return;
          getConversation(session, conversationId, CHAT_MESSAGES_INITIAL_LIMIT)
            .then(({ conversation, messagesWindow }) => {
              applyConversationUsageState(conversation, messagesWindow);
              const raw =
                conversation?.messages && Array.isArray(conversation.messages)
                  ? conversation.messages
                  : [];
              setMessages(rawMessagesToLocal(raw));
            })
            .catch(() => {});
        };
        Alert.alert(
          '重新生成会丢失消息',
          `这不是最新的消息，继续会丢弃它之后的 ${drop} 条消息（不可恢复）。确定继续吗？`,
          [
            { text: '取消', style: 'cancel', onPress: resync },
            {
              text: '继续',
              style: 'destructive',
              onPress: () => {
                void handleRegenerate(
                  afterUserIndex,
                  editedMessage,
                  editedFlopsRefs,
                  reprocessTaskId,
                  true,
                );
              },
            },
          ],
        );
      } else if (e && (e as { name?: string }).name === 'AbortError' && pausedByBackgroundRef.current) {
        pausedByBackgroundRef.current = false;
        silentBackgroundAbort = true;
      } else if (e && (e as { name?: string }).name === 'AbortError' && manualStopRef.current) {
        messageAreaRef.current?.armOnce();
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
        messageAreaRef.current?.armOnce();
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
      /* 被后台掐断时**保留**这半截流式内容：run 在服务端还跑着，回前台 resume 要拿它当底
         接着往下收（见 resumeV2Stream 的 canResumeIncrementally）。清掉的话本地没底了，
         只能退回从 run 开头整轮重放 —— 那正是「切回来稀里哗啦重放一遍」的由来。
         正常结束/报错仍旧清空：那时回复已落库进 messages，留着会显示两份。 */
      if (!silentBackgroundAbort) {
        setStreamingText('');
        setCurrentAssistantBlocks([]);
        // 状态文案也一起留着：恢复窗口里气泡还挂着，清空会让标题在「thinking」和空之间闪一下
        setStreamStatus('');
      }
    }
  },
    [
      session,
      conversationId,
      loading,
      conversationHistoryLoading,
      runV2WithHandlers,
      applyConversationUsageState,
      consumeBackgroundAbortFlag,
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
  /** 自动播报开关：即时驱动 ttsRealtime 单例（连/断本对话流）+ 写回服务端偏好。无二次确认。 */
  const persistTtsAutoplay = useCallback(
    (next: boolean) => {
      setTtsAutoplay(next);
      setRealtimeEnabled(next);
      if (!session) return;
      setLayoutPreferences(session, { tts_autoplay: next }).catch(() => {});
    },
    [session],
  );
  /** 「开启播报模式」：弹二次确认 Alert，确认后开全局播报（沉浸式 overlay 由 BroadcastModeOverlay 呈现）。
   *  开关本身 per-device 存本机（由 setBroadcastMode 落 AsyncStorage）。退出播报走 overlay 底部横条，不在这里管。 */
  const handleEnableBroadcast = useCallback(() => {
    Alert.alert(
      '开启播报模式',
      '像导航软件一样：开启后会监听你所有对话的语音，离开对话页、锁屏、切到其它 App 都持续朗读，并盖过桌面端/网页端的播报。\n\n屏幕会套上黑色边框 + 底部「语音播报中」横条，退出点那条横条上的按钮即可。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开启',
          onPress: () => {
            setBroadcastMode(true);
          },
        },
      ],
    );
  }, []);

  /* ⋯ 菜单项。自动播报是带勾选（state on/off）的开关行；开启播报模式是纯选项行（点了弹确认 Alert）。
     语音相关两项放在一个 displayInline 子菜单里 —— iOS UIMenu 对 displayInline 子菜单会自动在跟兄弟项
     之间画分隔线（这就是原生分组语义，@react-native-menu/menu 的 MenuAction 也直接支持 displayInline+
     subactions）。顺序：对话信息 / 复制诊断资料在上，语音组在下，中间自动分隔。依赖 ttsAutoplay →
     切换后 UIMenu 重建、勾选态刷新。 */
  type ConvLeafAction = { id: string; title: string; image: string; state?: 'on' | 'off' };
  type ConvMenuEntry =
    | ConvLeafAction
    | { id: string; title: string; displayInline: true; subactions: ConvLeafAction[] };
  const convMenuActions = useMemo<ConvMenuEntry[]>(
    () => [
      { id: 'info', title: '对话信息', image: 'info.circle' },
      { id: 'diag', title: '复制诊断资料', image: 'doc.on.clipboard' },
      {
        id: 'voice',
        title: '',
        displayInline: true,
        subactions: [
          {
            id: 'tts',
            title: '语音合成',
            image: 'speaker.wave.2',
            state: ttsAutoplay ? 'on' : 'off',
          },
          { id: 'broadcast', title: '开启播报模式', image: 'dot.radiowaves.left.and.right' },
        ],
      },
    ],
    [ttsAutoplay],
  );
  /* Liquid Glass（iOS26）走我们自绘的 UIMenu builder（BouncyButton），它吃扁平数组 + sectionBreakBefore
     标记来分区段。把上面的嵌套结构摊平：displayInline 组的首项打 sectionBreakBefore，native 会在此起新
     的 displayInline 区段，效果跟 MenuView 的原生分组一致。 */
  const glassMenuActions = useMemo<AnimatedCircleButtonMenuAction[]>(() => {
    const out: AnimatedCircleButtonMenuAction[] = [];
    for (const entry of convMenuActions) {
      if ('subactions' in entry) {
        entry.subactions.forEach((sub, i) => {
          out.push({ ...sub, ...(i === 0 ? { sectionBreakBefore: true } : null) });
        });
      } else {
        out.push(entry);
      }
    }
    return out;
  }, [convMenuActions]);
  const onConvMenuAction = useCallback(
    (id: string) => {
      if (id === 'info') handleConvInfo();
      else if (id === 'tts') persistTtsAutoplay(!ttsAutoplay);
      else if (id === 'broadcast') handleEnableBroadcast();
      else if (id === 'diag') handleConvDiagCopy();
    },
    [handleConvInfo, handleConvDiagCopy, persistTtsAutoplay, ttsAutoplay, handleEnableBroadcast],
  );
  const onConvMenuPressAction = useCallback(
    (e: { nativeEvent: { event: string } }) => {
      onConvMenuAction(e.nativeEvent.event);
    },
    [onConvMenuAction],
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

  /* ---------- composer「+」附件菜单（引用 FlowDoc 文档 / 发送文件）---------- */
  /** iOS：菜单打开时把「+」图标淡到 0.4（让位给原生 UIMenu）。Android：整张 composer 卡片
   *  由 composerPressAnimStyle 淡出让位，「+」跟着卡片一起消失，不再单独动画（分支恒定
   *  不切换，返回 {} 安全）。 */
  const composerAttachIconAnimStyle = useAnimatedStyle(() =>
    IS_ANDROID ? {} : { opacity: 1 - composerAttachMenuShow.value * 0.6 },
  );
  /** Android popover 卡片：scale 0.1→1，transformOrigin 锚在 composer 卡片的左下角，菜单从
   *  composer 原位"长出来"（composer 同步整卡淡出让位）。left/bottom 从 SharedValue 读（见声明注释）。
   *  bottom 上叠键盘跟随项：composer 距屏底 = max(键盘高, restingNavInset) + 常量（meta row /
   *  margin），菜单开着时键盘收起/弹出，按同一增量平移即可始终贴住卡片底边（含 open 发生在键盘
   *  动画中途的竞态——基准与增量都是同一时刻快照，残差只有几帧）。 */
  const composerAttachCardAnimStyle = useAnimatedStyle(() => {
    const kbNow = Math.max(-kbAnimHeight.value, 0);
    const kbFollow = Math.max(kbNow, restingNavInset) - composerAttachMenuKbBase.value;
    return {
      opacity: composerAttachMenuShow.value,
      transform: [{ scale: 0.1 + composerAttachMenuShow.value * 0.9 }],
      transformOrigin: 'left bottom',
      left: composerAttachMenuLeft.value,
      bottom: Math.max(0, Math.min(
        composerAttachMenuBottom.value + kbFollow,
        composerAttachMenuBottomMax.value,
      ) - 45),
      pointerEvents: composerAttachMenuShow.value > 0.5 ? 'auto' : 'none',
    };
  });
  const composerAttachBackdropAnimStyle = useAnimatedStyle(() => ({
    opacity: composerAttachMenuShow.value,
  }));
  /* open 80ms / close 100ms：跟 ⋯ 菜单 / TodayScreen FAB 菜单同一节奏。 */
  const openComposerAttachMenu = useCallback(() => {
    if (attachBackdropOffTimerRef.current) {
      clearTimeout(attachBackdropOffTimerRef.current);
      attachBackdropOffTimerRef.current = null;
    }
    setAttachBackdropActive(true);
    composerAttachMenuShow.value = withTiming(1, { duration: 80 });
  }, [composerAttachMenuShow]);
  const closeComposerAttachMenu = useCallback(() => {
    if (IS_ANDROID) {
      setAttachBackdropActive(false);
    } else {
      /* iOS：UIMenu 收起的 outside tap 会穿透到 app 层，且可能晚于 onCloseMenu 抵达，
       * backdrop 多活一拍把它吞掉（250ms ≈ 菜单收起动画时长，用户无感）。 */
      attachBackdropOffTimerRef.current = setTimeout(() => {
        attachBackdropOffTimerRef.current = null;
        setAttachBackdropActive(false);
      }, 250);
    }
    composerAttachMenuShow.value = withTiming(0, { duration: 100 });
  }, [composerAttachMenuShow]);
  /** Android：按下时 measure composer 卡片屏幕坐标，菜单卡片跟 composer 左下角对齐（左边线
   *  贴卡片左边线、底边贴卡片底边），配合整卡淡出 = 「composer 变菜单」：
   *  bottom = winH − 卡片底 Y，同时快照当时的键盘基准 max(键盘高, restingNavInset) 与
   *  bottom 上限（菜单顶 ≤ insets.top+8，按当时 menuH 折算）；此后键盘任何升降由
   *  composerAttachCardAnimStyle 的跟随项逐帧补偿，菜单跟 composer 一起走。
   *  菜单高取常驻 onLayout 实测值（未测到时用 4 项估算兜底）。
   *  坐标直写 SharedValue，跟 show 动画同帧生效。
   *  精确性前提：measure 时卡片祖先矩阵必须是 identity——+ 的 onPressIn 已把按压放大
   *  guard 掉（见 onComposerAttachPressIn），否则测出的坐标带 scale 偏移。
   *  ⚠️ 不要改成「同批 measure 一个 overlay 参照相减」的差分方案：overlay 子树的
   *  measureInWindow 回读比视觉位置少 insets.top（Fabric + stack card 实测），跟 composer
   *  子树不同系，跨系相减会把菜单压低一个状态栏高；height 两系一致，origin 差异在
   *  bottom 锚定下天然抵消，winH 公式已 screencap 验证（见 memory chatscreen-overlay-positioning）。 */
  const openAndroidComposerAttachMenu = useCallback(() => {
    const node = composerCardRef.current;
    if (node?.measureInWindow) {
      node.measureInWindow((x, y, _w, h) => {
        const menuH = composerAttachMenuHeightRef.current || 200;
        const winH = Dimensions.get('window').height;
        composerAttachMenuLeft.value = Math.max(8, x);
        composerAttachMenuBottom.value = winH - (y + h);
        composerAttachMenuKbBase.value = Math.max(
          Math.max(-kbAnimHeight.value, 0),
          restingNavInset,
        );
        composerAttachMenuBottomMax.value = winH - (insets.top + 8) - menuH;
        openComposerAttachMenu();
      });
    } else {
      openComposerAttachMenu();
    }
  }, [
    composerAttachMenuLeft,
    composerAttachMenuBottom,
    composerAttachMenuKbBase,
    composerAttachMenuBottomMax,
    kbAnimHeight,
    restingNavInset,
    openComposerAttachMenu,
    insets.top,
  ]);

  /** iOS MenuView 的两项（SF Symbol image）：对齐 Desktop lucide 图标 —— FlowDoc 用 FileText
   *  (=doc.text)，发送文件用 Upload (=square.and.arrow.up 托盘+上箭头)。
   *  imageColor 必填：新架构下 @react-native-menu/menu 对未指定 imageColor 的 action 会默认传 0
   *  （= 透明色），而 native 端无条件 image.withTintColor(uiColor(imageColor), .alwaysOriginal) →
   *  SF Symbol 被染成全透明、完全看不见。显式给 textPrimary（随主题翻转）让图标以标签同色渲染。 */
  /* 「+」菜单向上弹（composer 在屏底 → UIMenu 在按钮上方展开）。iOS 对**向上展开**的 UIMenu 会把
     数组顺序上下翻转，让首项贴近按钮（落在最下）—— 所以数组顺序要跟期望视觉顺序**相反**：
       - 发送文件放数组首位 → 翻转后落在视觉**底部**
       - FlowDoc 裸项放数组末位 → 翻转后落在视觉**顶部**
     发送文件用 displayInline 分组，UIMenu 在它与 FlowDoc 之间自动画分隔线。
     （⋯ 菜单在顶栏、向下展开不翻转，所以那边是「裸项在前 / inline 组在后」；这里向上必须反过来。）
     leaf id 仍是 'flowdoc' / 'file'，onPressAction 分发不受影响。对齐 Desktop「文档 / 分隔线 / 发送文件」。 */
  const composerAttachMenuActions = useMemo(
    () => [
      /* 发送文件拆成三个子项，同放一个 displayInline 组（组内无分隔线，只跟 FlowDoc 之间有）。
         组内顺序同样受向上翻转影响：数组 [文件, 拍照, 相册] → 视觉自上而下 [相册, 拍照, 文件]。 */
      {
        id: 'file-group',
        title: '',
        displayInline: true,
        subactions: [
          { id: 'file-pick', title: '从文件选择', image: 'square.and.arrow.up', imageColor: colors.textPrimary },
          { id: 'camera', title: '拍照', image: 'camera', imageColor: colors.textPrimary },
          { id: 'photo-pick', title: '从相册选择', image: 'photo.on.rectangle', imageColor: colors.textPrimary },
        ],
      },
      { id: 'flowdoc', title: '引用 FlowDoc 文档', image: 'doc.text', imageColor: colors.textPrimary },
    ],
    [colors.textPrimary],
  );
  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);
  /** 单个文件/资源 → 入队 pendingAttachments 并上传到 /api/file_to_url。相册 / 拍照 / 文件三条
   *  路径共用。文件走 flops_attachment 通道（发送时拼进数组 message），与 FlowDoc 的 flops_refs 无关。 */
  const enqueueAttachmentUpload = useCallback(
    (file: { uri: string; name: string; mime: string; size?: number }) => {
      const sess = session;
      if (!sess) return;
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const name = (file.name && file.name.trim()) || 'attachment';
      const mime = (file.mime && file.mime.trim()) || 'application/octet-stream';
      const size = typeof file.size === 'number' ? file.size : undefined;
      setPendingAttachments((prev) => [
        ...prev,
        { id, name, mime, size, uri: file.uri, status: 'uploading' },
      ]);
      void (async () => {
        try {
          const { url } = await uploadComposerFile(sess, { uri: file.uri, name, mime });
          setPendingAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: 'ready', url } : a)),
          );
        } catch (e) {
          setPendingAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, status: 'error', error: e instanceof Error ? e.message : '上传失败' }
                : a,
            ),
          );
        }
      })();
    },
    [session],
  );
  /** react-native-image-picker 结果 → 逐个资源入队上传（相册 / 拍照共用）。 */
  const processImagePickerResult = useCallback(
    (result: ImagePickerResponse, failMsg: string) => {
      if (result?.didCancel) return;
      if (result?.errorCode) {
        setError(result.errorMessage || failMsg);
        return;
      }
      for (const asset of result?.assets || []) {
        if (!asset?.uri) continue;
        enqueueAttachmentUpload({
          uri: asset.uri,
          name: asset.fileName || `image-${Date.now()}.jpg`,
          mime: asset.type || 'image/jpeg',
          size: asset.fileSize,
        });
      }
    },
    [enqueueAttachmentUpload],
  );
  /** 从相册选择（可多选）→ 上传。 */
  const handlePhotoLibraryPick = useCallback(async () => {
    if (!session) return;
    try {
      const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 0 });
      processImagePickerResult(result, '相册出错');
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开相册失败');
    }
  }, [session, processImagePickerResult]);
  /** 拍照（不存进系统相册）→ 上传。 */
  const handleCameraPick = useCallback(async () => {
    if (!session) return;
    try {
      const result = await launchCamera({ mediaType: 'photo', saveToPhotos: false, presentationStyle: 'fullScreen' });
      processImagePickerResult(result, '相机出错');
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开相机失败');
    }
  }, [session, processImagePickerResult]);
  /** 从文件选择（系统文件选择器，可多选）→ 上传。 */
  const handleFilePick = useCallback(async () => {
    if (!session) return;
    let picked;
    try {
      picked = await pick({ type: [types.allFiles], allowMultiSelection: true });
    } catch (err) {
      if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) return;
      setError(err instanceof Error ? err.message : '选择文件失败');
      return;
    }
    for (const f of (picked || []).filter((x) => x && x.uri)) {
      enqueueAttachmentUpload({
        uri: f.uri,
        name: (f.name && f.name.trim()) || 'attachment',
        mime: (f.type && f.type.trim()) || 'application/octet-stream',
        size: typeof f.size === 'number' ? f.size : undefined,
      });
    }
  }, [session, enqueueAttachmentUpload]);
  /** 菜单项分发（iOS MenuView / Android popover 共用）。 */
  const onComposerAttachAction = useCallback(
    (id: string) => {
      if (id === 'flowdoc') setComposerPickerOpen(true);
      else if (id === 'photo-pick') void handlePhotoLibraryPick();
      else if (id === 'camera') void handleCameraPick();
      else if (id === 'file-pick') void handleFilePick();
    },
    [handlePhotoLibraryPick, handleCameraPick, handleFilePick],
  );
  const onComposerAttachMenuView = useCallback(
    (e: { nativeEvent: { event: string } }) => onComposerAttachAction(e.nativeEvent.event),
    [onComposerAttachAction],
  );

  const handleNewConversation = useCallback(async () => {
    if (loading) return;
    const bidForCreate = String(draftAgentId || '').trim();
    setError('');
    setConversationId('');
    conversationIdRef.current = '';
    setConversationTitle('');
    setMessages([]);
    setPendingAttachments([]);
    setServerRawMessages([]);
    setContextSummaries([]);
    setActiveContextSummaryId('');
    setUsageStats(null);
    setUsageRuns([]);
    conversationMetaRef.current = null;
    setConversationMeta(null);
    try {
      if (session) {
        /* 新对话始终加密；并回填 meta（含 bound agent 的 agent_profile）让随后首条消息能拼
           k_agent_wire（加密 bound agent 缺它 → server 400）。对齐草稿惰性创建与 web。 */
        const created = await createConversation(session, {
          encrypted: true,
          ...(bidForCreate ? { bound_agent_id: bidForCreate } : {}),
        });
        setConversationId(created.id);
        conversationIdRef.current = created.id;
        setConversationTitle('新对话');
        const nextMeta = {
          bound_agent_id: created.bound_agent_id,
          agent_profile: created.agent_profile,
          model: created.model,
        };
        conversationMetaRef.current = nextMeta;
        setConversationMeta(nextMeta);
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
      /* 能不能「接着收」而不是「整轮重放」：必须同时满足
         ①上次记的游标属于同一个 run（新一轮 run 的游标空间与上一轮无关）
         ②本地确实还留着这轮的半截内容（没有的话续流会只拿到后半段，前半段永远缺）
         任一不满足就退回老路：replay_from=0 + 清空本地，慢但一定正确。
         注意判定只看游标与本地有无内容，不做任何内容比对去重 —— 服务端回放段是合并段、
         实时段是原始事件，两者粒度不同，按内容对不上。 */
      const cursorRec = resumeCursorRef.current;
      const canResumeIncrementally =
        !!cursorRec &&
        cursorRec.runId === runId &&
        cursorRec.cursor > 0 &&
        currentAssistantBlocksRef.current.length > 0;
      streamInFlightRef.current = true;
      setV2ResumeUiActive(true);
      setError('');
      setLoading(true);
      if (!canResumeIncrementally) {
        // 全量回放：本地那份要清掉，否则回放内容会叠在旧内容后面变成两份
        setStreamingText('');
        setCurrentAssistantBlocks([]);
        resumeCursorRef.current = null;
      }
      setStreamStatus('thinking');
      messageAreaRef.current?.armOnce();
      const controller = new AbortController();
      abortRef.current = controller;
      manualStopRef.current = false;
      const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
      /** 这一轮是被切后台掐断的（catch 里置位，finally 据此决定要不要保留半截内容） */
      let silentBackgroundAbort = false;
      try {
        const { streamDone, finalText, localBlocks, lastConvId } = await runV2WithHandlers({
          convId: cid,
          start: { tag: 'resume', run_id: runId },
          signal: controller.signal,
          initialReplayFrom: canResumeIncrementally ? cursorRec!.cursor : 0,
          seedBlocks: canResumeIncrementally ? currentAssistantBlocksRef.current : undefined,
        });
        clearTimeout(timeout);
        // 同上：abort 可能不抛异常就正常返回，这里补判，保留半截 + 跳过白拉的全量同步
        if (consumeBackgroundAbortFlag()) {
          silentBackgroundAbort = true;
          return;
        }
        try {
          const { conversation, messagesWindow } = await getConversation(session, lastConvId, CHAT_MESSAGES_INITIAL_LIMIT);
          applyConversationUsageState(conversation, messagesWindow);
          const raw = conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
          let synced = rawMessagesToLocal(raw);
          const stillRunning = typeof conversation?.active_chat_v2_run_id === 'string' && conversation.active_chat_v2_run_id.trim();
          if (stillRunning) {
            synced = truncateMessagesAfterLastUser(synced);
          }
          // run 收尾：答案已并进 messages，续流快照可以清了
          if (!stillRunning && mountedRef.current) clearResumeSnapshot(lastConvId);
          /* resume 跑完后的整表对账：本轮开头那次 armOnce 早被流式中的第一次内容变化消费掉了，
             这里补一次，否则「后台期间 run 继续跑、回前台后才跑完」的最后一批消息不贴底。
             同样只在贴着底时才跟。 */
          if (messageAreaRef.current?.isAtBottom()) messageAreaRef.current.armForOpen();
          setMessages(synced);
          const t = conversation?.title?.trim();
          if (t) setConversationTitle(t);
        } catch {
          if (streamDone || finalText.trim()) {
            messageAreaRef.current?.armOnce();
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
        const isAbort = Boolean(e && (e as { name?: string }).name === 'AbortError');
        const bgAbort = isAbort && pausedByBackgroundRef.current;
        if (bgAbort) {
          pausedByBackgroundRef.current = false;
          silentBackgroundAbort = true;
        } else if (!(isAbort && manualStopRef.current)) {
          setError(e instanceof Error ? e.message : String(e));
        }
        /* 被后台掐断：马上就要进后台了，这一发全量拉取白费（且回来还要再拉一次）。
           统一交给回前台的 AppState 分支 resync/resume。 */
        if (bgAbort) return;
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
        // 同上：被后台掐断就留着这半截，回前台好接着往下收（见发送路径 finally 的说明）
        if (!silentBackgroundAbort) {
          setStreamingText('');
          setCurrentAssistantBlocks([]);
          setStreamStatus('');
        }
      }
    },
    [session, runV2WithHandlers, applyConversationUsageState, consumeBackgroundAbortFlag]
  );

  useEffect(() => {
    const endBgPauseRecovery = () => {
      bgPauseRecoveringRef.current = false;
      setBgPauseRecovering(false);
    };
    const sub = AppState.addEventListener('change', (next) => {
      /* 只认 'background'，不认 'inactive'。iOS 的 inactive 是瞬时态（底部上滑进 App Switcher
       * 预览、控制中心、通知横幅、来电、系统弹窗）—— app 仍在前台、网络照跑。以前把 inactive
       * 一并当后台，正常跑着的流会被 abort 掉：finally 里 loading=false，而消息尾巴此时是
       * user（回复还没落库/已被 truncate），底下那条「Flops未回复任何内容」就闪出来，
       * 直到回到 active 起 resume 才消失。对齐 BeaconReporter 对 inactive 的处理。 */
      if (next === 'background') {
        hadBackgroundPauseRef.current = true;
        if (abortRef.current && !manualStopRef.current) {
          pausedByBackgroundRef.current = true;
          abortRef.current.abort();
          // 流是我们自己掐断的：回前台 resync/resume 定论之前，不许把「尾巴是 user」判成没回复。
          bgPauseRecoveringRef.current = true;
          setBgPauseRecovering(true);
        }
      }
      if (next !== 'active') return;
      if (!hadBackgroundPauseRef.current) return;
      hadBackgroundPauseRef.current = false;
      const sess = sessionRef.current;
      const cid = conversationIdRef.current;
      if (!sess || !cid || streamInFlightRef.current) {
        endBgPauseRecovery();
        return;
      }
      // 先用轻量 meta 接口看有没有活动 run；绝大多数情况无 run，省掉一次全量拉取。
      getConversationMeta(sess, cid)
        .then(({ conversation: meta }) => {
          const rid = meta?.active_chat_v2_run_id;
          const s = typeof rid === 'string' ? rid.trim() : '';
          if (streamInFlightRef.current || conversationIdRef.current !== cid) return;
          if (!s) {
            /* 无活动 run。若这轮流是被后台掐断的，run 多半是在后台期间跑完的 —— 不能停在本地
             * 被截断的消息尾上（那会把「Flops未回复任何内容」永久钉在页面上），拉一次全量把
             * 服务端已落库的回复补回来。没掐断过就是纯粹的前后台切换，什么都不用做。 */
            if (!bgPauseRecoveringRef.current) return;
            return getConversation(sess, cid, CHAT_MESSAGES_INITIAL_LIMIT).then(
              ({ conversation, messagesWindow }) => {
                if (streamInFlightRef.current || conversationIdRef.current !== cid) return;
                applyConversationUsageState(conversation, messagesWindow);
                const raw =
                  conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
                /* 后台跑完的回复要补进来：走的时候在看最新就跟到底。用 armForOpen 而不是
                   armOnce —— 这批消息里的图片/附件同样是随后才量出高度的，需要窗口兜住。
                   用户切后台前手动上翻过的话 isAtBottom() 是 false，这里不动，不把人拽回去。 */
                if (messageAreaRef.current?.isAtBottom()) messageAreaRef.current.armForOpen();
                setMessages(rawMessagesToLocal(raw));
                /* run 已经跑完，这份回复此刻已在 messages 里了 —— 把切后台时保留下来的那半截
                   流式内容清掉，跟 setMessages 落在同一批里，不会闪出「气泡 + 正式消息」两份。
                   （保留是给「回来还要续流」用的，这条路不续流。） */
                setCurrentAssistantBlocks([]);
                setStreamingText('');
                setStreamStatus('');
                const t = conversation?.title?.trim();
                if (t) setConversationTitle(t);
              }
            );
          }
          // 确实有活动 run 才拉全量消息做 resume。
          return getConversation(sess, cid, CHAT_MESSAGES_INITIAL_LIMIT).then(
            ({ conversation, messagesWindow }) => {
              const rid2 = conversation?.active_chat_v2_run_id;
              const s2 = typeof rid2 === 'string' ? rid2.trim() : '';
              if (!s2) return;
              applyConversationUsageState(conversation, messagesWindow);
              const raw =
                conversation?.messages && Array.isArray(conversation.messages) ? conversation.messages : [];
              /* 能增量续流时，别再整表刷一遍 messages：本地那半截回复还在 currentAssistantBlocks
                 里，而这份服务端快照会被 truncate 掉尾巴 —— 先塌一截、增量再涨回来，视觉上就是
                 「回来先跳一下再滚回底部」。判定与 resumeV2Stream 内部同源（同一个 run + 本地
                 还有内容），不满足才按老路整表替换。 */
              const rc = resumeCursorRef.current;
              const willResumeIncrementally =
                !!rc &&
                rc.runId === s2 &&
                rc.cursor > 0 &&
                currentAssistantBlocksRef.current.length > 0;
              if (!willResumeIncrementally) {
                // 走全量回放：内容会整段重来，按需贴底
                if (messageAreaRef.current?.isAtBottom()) messageAreaRef.current.armForOpen();
                setMessages(truncateMessagesAfterLastUser(rawMessagesToLocal(raw)));
              }
              /* 同步跑到第一个 await 前：setLoading(true) 会在这个 then 结束前落下，
                 下面 finally 解除门控时不会露出空窗。 */
              resumeV2Stream(s2, cid);
            }
          );
        })
        .catch(() => {
          /* ignore */
        })
        .finally(endBgPauseRecovery);
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
        /* 打开对话：不是滚一次就完事——图片/附件/流式气泡的高度都是随后才量出来的，
           所以武装一个窗口，这段时间内容每次变高都重新贴到底（用户一碰列表即作废）。 */
        messageAreaRef.current?.armForOpen();
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
          /* 上次卸载（比如切去今日页）时留下的续流快照：conversation + run 都对得上就把半截
             内容与游标恢复回来，resumeV2Stream 里的 canResumeIncrementally 随之成立，
             接着往下收而不是整轮重放。对不上 / 过期 / 没有 → 什么都不做，走原来的全量回放。 */
          const snap = takeResumeSnapshot(id, runId);
          if (snap) {
            setCurrentAssistantBlocks(snap.blocks);
            setStreamingText(snap.text);
            setStreamStatus(snap.status);
            currentAssistantBlocksRef.current = snap.blocks;
            resumeCursorRef.current = { runId, cursor: snap.cursor };
          }
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

  /* 挂起决策（授权 / 安全确认 / 选择题）提交成功后：服务端会自主起一个**新的**续起 run（新 run_id），
     其流式续跑内容不会自动推到本端——原挂起 run 的流早在挂起时就以 suspended_awaiting_user 收束了。
     这里轮询对话 lite meta 直到新 active_chat_v2_run_id 出现，再 subscribe_only 接上它的流（replay+实时）。
     不做的话：服务端续起成功、内容已生成，但 Mobile 不实时展示，用户以为卡死、刷新才看到（本 bug）。
     对齐 Web/Desktop 的 pollResumeRunAfterDecision。25×600ms≈15s 超时兜底，切走对话/已在流即停。 */
  const pollResumeRunAfterDecision = useCallback(
    (cid: string) => {
      const id = String(cid || '').trim();
      if (!id || !session) return;
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        if (
          id !== String(conversationIdRef.current || '').trim() ||
          streamInFlightRef.current ||
          tries >= 25
        ) {
          clearInterval(timer);
          return;
        }
        try {
          const { conversation } = await getConversationMeta(session, id);
          const rid =
            typeof conversation?.active_chat_v2_run_id === 'string'
              ? conversation.active_chat_v2_run_id.trim()
              : '';
          if (rid) {
            clearInterval(timer);
            void resumeV2Stream(rid, id); // subscribe_only + replay 接上续起 run
          }
        } catch {
          /* 网络抖动等：忽略，下次重试 */
        }
      }, 600);
    },
    [session, resumeV2Stream]
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
        // 决策成功 → 服务端起新续起 run（approve/reject 都续跑，reject 也要把结果喂回 agent 收尾），
        // 主动轮询接上它的流（否则续跑内容不实时展示、用户以为卡死）。
        pollResumeRunAfterDecision(conversationId);
      } catch (e) {
        // 回滚乐观更新，让安全卡片再出现一次让用户重试
        patchToolBlocksByReviewId(reviewId, { status: 'awaiting_confirmation' });
        setError(e instanceof Error ? e.message : '提交确认失败');
      } finally {
        setSubmittingReviewId('');
      }
    },
    [session, conversationId, patchToolBlocksByReviewId, pollResumeRunAfterDecision]
  );

  const patchToolBlocksByAuthRequestId = useCallback(
    (requestId: string, patch: Partial<ToolBlock>) => {
      if (!requestId) return;
      setCurrentAssistantBlocks((prev) =>
        prev.map((b) =>
          b?.type === 'tool' && (b as ToolBlock).auth_request?.request_id === requestId ? { ...(b as ToolBlock), ...patch } : b,
        ),
      );
      setMessages((prev) =>
        prev.map((msg) => {
          if (!msg?.blocks || !Array.isArray(msg.blocks)) return msg;
          return {
            ...msg,
            blocks: msg.blocks.map((b) =>
              b?.type === 'tool' && (b as ToolBlock).auth_request?.request_id === requestId ? { ...(b as ToolBlock), ...patch } : b,
            ),
          };
        }),
      );
    },
    []
  );

  const handleAuthorizationDecision = useCallback(
    async (payload: NonNullable<ToolBlock['auth_request']> & { decision: 'approve' | 'reject' }) => {
      if (!session) return;
      const kind = payload?.kind === 'access' ? 'access' : 'titles';
      const requestId = String(payload?.request_id || '').trim();
      const decision = payload?.decision;
      const requester = String(payload?.requester_conversation_id || conversationId || '').trim();
      if (!requestId || (decision !== 'approve' && decision !== 'reject') || !requester) return;
      if (submittingAuthorizationId) return;
      // 清投影，避免 effect 又把 block 翻回 awaiting_authorization
      setPendingAuthProjection(null);
      setSubmittingAuthorizationId(requestId);
      // 乐观置态：与 ask/safety 一致，点击即把工具卡推进（confirming/rejected），右上角徽标随之
      // 切「提交中」覆盖「待授权」，而非二者并存。失败再回滚成 awaiting_authorization。
      const optimisticStatus = decision === 'approve' ? 'confirming' : 'rejected_by_user';
      patchToolBlocksByAuthRequestId(requestId, { status: optimisticStatus, authorization_error: '' });
      try {
        if (kind === 'access') {
          await submitConversationAccessDecision(session, {
            requestId,
            decision,
            requesterConversationId: requester,
            targetConversationId: String(payload?.target_conversation_id || ''),
          });
        } else {
          await submitConversationTitlesDecision(session, {
            requestId,
            decision,
            requesterConversationId: requester,
            targetIds: Array.isArray(payload?.target_ids) ? payload.target_ids : [],
          });
        }
        // 决策成功 → 服务端起新续起 run，主动轮询接上它的流（否则续跑内容不实时展示、用户以为卡死）。
        pollResumeRunAfterDecision(requester);
      } catch (e) {
        patchToolBlocksByAuthRequestId(requestId, {
          status: 'awaiting_authorization',
          authorization_error: e instanceof Error ? e.message : '提交授权失败',
        });
      } finally {
        setSubmittingAuthorizationId('');
      }
    },
    [session, conversationId, submittingAuthorizationId, patchToolBlocksByAuthRequestId, pollResumeRunAfterDecision]
  );


  /* ── 渲染链的叶子 helper ────────────────────────────────────────────────
     统一上移到卡片渲染器之前：下面每个渲染器都被包成 useCallback，这几个会出现在
     它们的依赖数组里，声明必须在前，否则依赖数组求值时踩 TDZ。 */
  const renderToolCardSafetyActions = useCallback((reviewId: string, isSubmitting: boolean) => {
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
  }, [handleSafetyDecision, styles.safetyActions, styles.safetyBtn, styles.safetyBtnPrimary, styles.safetyBtnPrimaryText, styles.safetyBtnText]);

  // 工具授权（批量标题解密 / 档B对话访问）：按钮内嵌进 list_conversations / request_conversation_access
  // 工具卡（DefaultToolCard 的 awaiting_authorization 分支），与安全确认按钮同款。
  const renderToolCardAuthorizationActions = useCallback(
    (authReq: NonNullable<ToolBlock['auth_request']>, isSubmitting: boolean, error?: string) => {
      const isAccess = authReq?.kind === 'access';
      // action=send（subagent_continue 向无钥加密对话发消息）走 access 同款加解密/决策路径，仅文案不同。
      const isSend = isAccess && (authReq as { action?: string })?.action === 'send';
      const intro = isSend
        ? '这个对话里的 agent 想向另一条加密对话发送一条消息。那条对话的密钥只有你手里有，服务端拿不到——你同意后客户端才会把它的密钥交出去（一次性），消息才会真正投递并唤醒那个对话。'
        : isAccess
          ? '这个对话里的 agent 想读取另一条加密对话的内容。那条对话的密钥只有你手里有，服务端解不开——你同意后客户端才会把它的密钥交出去（一次性）。'
          : `这个对话里的 agent 想列出你的对话来定位，其中有 ${authReq?.count || (authReq?.target_ids || []).length} 个是加密对话、标题服务端看不到。你同意后客户端才会用你的密钥把这些标题解出来交给它（只给标题、不含内容）。`;
      return (
        <View>
          <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18, marginBottom: 8 }}>{intro}</Text>
          {isAccess ? (
            <Text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 8 }}>
              {authReq?.reason && String(authReq.reason).trim() ? `理由：${String(authReq.reason).trim()}` : '（agent 没有说明理由）'}
              {authReq?.target_conversation_id ? `\n目标对话 id：${authReq.target_conversation_id}` : ''}
            </Text>
          ) : null}
          {error ? <Text style={{ color: '#ff8f8a', fontSize: 12, lineHeight: 17, marginBottom: 8 }}>{error}</Text> : null}
          <View style={styles.safetyActions}>
            <TouchableOpacity
              style={styles.safetyBtn}
              onPress={() => handleAuthorizationDecision({ ...authReq, decision: 'reject' })}
              disabled={isSubmitting}
            >
              <Text style={styles.safetyBtnText}>拒绝</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.safetyBtn, styles.safetyBtnPrimary]}
              onPress={() => handleAuthorizationDecision({ ...authReq, decision: 'approve' })}
              disabled={isSubmitting}
            >
              <Text style={styles.safetyBtnPrimaryText}>
                {isSubmitting ? '提交中...' : isSend ? '允许发送' : isAccess ? '允许本次读取' : '允许解密标题'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [handleAuthorizationDecision, colors.textMuted, styles.safetyActions, styles.safetyBtn, styles.safetyBtnPrimary, styles.safetyBtnPrimaryText, styles.safetyBtnText],
  );

  const renderAnsiText = useCallback((text: string, maxLen: number) => {
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
  }, [styles.toolCardCodeText]);

  /**
   * 与 Web `.tool-card-write-preview` / `.tool-card-diff` 一致：半折叠(preview)时 max-height 120px；
   * 流式(pending/running)时内部可滚动；非流式时底部渐变 + 「…」。
   */
  const wrapFileToolPreviewBody = useCallback((
    isFull: boolean,
    isStreaming: boolean,
    cardKey: string,
    children: React.ReactNode
  ): React.ReactNode => {
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
  }, [colors, isDark, styles.fileToolPreviewClip, styles.fileToolPreviewEllipsis, styles.fileToolPreviewFade, styles.fileToolPreviewFullWrap, styles.fileToolPreviewScroll, styles.fileToolPreviewScrollContent]);

  const renderSubagentBlock = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
    return (
      <SubagentCard
        block={block as unknown as Record<string, unknown> as never}
        cardKey={key}
        agentLabel={subagentAgentLabel(block)}
        styles={styles as unknown as Record<string, any>}
        colors={colors as unknown as Record<string, any>}
        iconColor={colors.textSecondary}
        getToolStatusLabel={getToolStatusLabel}
        renderToolCardSafetyActions={renderToolCardSafetyActions}
        isSubmitting={Boolean(submittingReviewId && submittingReviewId === block.review_id)}
        renderToolCardAuthorizationActions={renderToolCardAuthorizationActions}
        authSubmitting={Boolean(submittingAuthorizationId && submittingAuthorizationId === block.auth_request?.request_id)}
        onOpenSubagentView={openSubagentView}
        onOpenConversation={openConversationById}
      />
    );
  }, [colors, renderToolCardSafetyActions, renderToolCardAuthorizationActions, submittingAuthorizationId, styles, submittingReviewId, getToolStatusLabel, openSubagentView]);

  const renderSubagentMetaBlock = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
    return (
      <SubagentMetaCard
        block={block as unknown as Record<string, unknown> as never}
        cardKey={key}
        agentLabel={subagentAgentLabel(block)}
        styles={styles as unknown as Record<string, any>}
        renderToolCardAuthorizationActions={renderToolCardAuthorizationActions}
        authSubmitting={Boolean(submittingAuthorizationId && submittingAuthorizationId === block.auth_request?.request_id)}
      />
    );
  }, [styles, renderToolCardAuthorizationActions, submittingAuthorizationId]);

  /* show_visual 图卡回注：图内 sendPrompt(text) → 卡片 onEcho → 这里拼【图卡·title】溯源前缀，
     作为一条新的**用户消息**发出，agent 据前缀认出是自己画的哪张卡（与 Web/Desktop 同一契约）。
     忙态入待发队列、空闲直发，对齐 Web；软上限挡住"狂点把队列灌满"，回合结束（loading 落定）归零。 */
  const widgetEchoQueuedRef = useRef(0);
  useEffect(() => {
    if (!loading) widgetEchoQueuedRef.current = 0;
  }, [loading]);
  const handleWidgetEcho = useCallback(
    (title: string, text: string) => {
      if (!session) return;
      const outbound = formatWidgetEcho(title, text);
      if (loading && conversationIdRef.current) {
        if (widgetEchoQueuedRef.current >= WIDGET_ECHO_QUEUE_SOFT_MAX) return;
        widgetEchoQueuedRef.current += 1;
        void enqueueCurrentComposer({ overrideText: outbound });
        return;
      }
      void handleSendMessage({ overrideText: outbound });
    },
    [session, loading, enqueueCurrentComposer, handleSendMessage],
  );

  const renderVisualWidgetBlock = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
    const { error: widgetError, title, mode, code } = parseVisualWidget(block);
    return (
      <VisualWidgetCard
        key={key}
        code={code}
        mode={mode}
        title={title}
        isCompleted={block.status === 'completed'}
        error={widgetError}
        colors={colors}
        isDark={isDark}
        onEcho={(text) => handleWidgetEcho(title, text)}
      />
    );
  }, [colors, handleWidgetEcho, isDark]);

  // ask_user_question：用户点选 → POST /ask/answer 解阻塞正在等待的本轮 run（卡片自管 submitted 乐观态）
  const handleAskUserAnswer = useCallback(
    async (answers: { header?: string; question?: string; answer: string }[]) => {
      if (!session || !conversationId) return;
      await answerAskUserQuestion(session, conversationId, answers);
      // 回答成功 → 服务端起新续起 run，主动轮询接上它的流（否则续跑内容不实时展示、用户以为卡死）。
      pollResumeRunAfterDecision(conversationId);
    },
    [session, conversationId, pollResumeRunAfterDecision]
  );

  const renderAskUserQuestionBlock = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
    return (
      <AskUserQuestionCard
        block={block}
        cardKey={key}
        styles={styles as unknown as Record<string, object>}
        placeholderColor={colors.textMuted}
        onSubmit={handleAskUserAnswer}
      />
    );
  }, [colors.textMuted, handleAskUserAnswer, styles]);

  const setToolCardMode = useCallback((cardKey: string, mode: 'collapsed' | 'preview' | 'full') => {
    setToolCardViewMode((prev) => ({ ...prev, [cardKey]: mode }));
  }, []);







  const renderReadPagesToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode]);

  const renderFileWriteToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode, wrapFileToolPreviewBody]);

  const renderFileEditToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode, wrapFileToolPreviewBody]);

  const renderExecCommandToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
    /* 秒表的数据源是 execCardTimeRef（ref）+ Date.now()，两者都不是 state —— 真正把秒数推着走的
       是每秒自增的 runningExecTick。这里显式读一下，让它成为本 useCallback 的真实依赖，从而沿
       renderToolBlock → renderMessage → renderedMessages 一路把缓存按秒打穿。
       必须这么做而不是把 tick 手工塞进上层依赖数组：那样 eslint 会判定「多余依赖」，
       而且一旦哪天链路变了也没人能机检出来。
       跑动中的 exec 卡确实可能落在历史消息里（见 hasRunningExec 对 messages 的扫描）。 */
    void runningExecTick;
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
  }, [renderAnsiText, renderToolCardSafetyActions, runningExecTick, setToolCardMode, styles, submittingReviewId, toolCardViewMode]);

  /** 与 FlopsDesktop SearchEngineCard.jsx 1:1（无「完全展开」行，默认折叠） */
  const renderSearchEngineToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [handleSafetyDecision, setToolCardMode, styles, submittingReviewId, toolCardViewMode]);

  const renderFlowDocEditToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [conversationId, renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode, wrapFileToolPreviewBody]);

  const renderFlowDocPatchToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [conversationId, renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode, wrapFileToolPreviewBody]);

  const renderFlowDocWriteToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [conversationId, renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode, wrapFileToolPreviewBody]);

  const renderFlowDocReadToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [conversationId, renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode, wrapFileToolPreviewBody]);

  const renderFlowDocGetTreeToolCard = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
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
  }, [renderToolCardSafetyActions, setToolCardMode, styles, submittingReviewId, toolCardViewMode, wrapFileToolPreviewBody]);

  /** drawer 模式下不渲染返回，由 HamburgerButton 顶替；同时左缘 PanResponder 不挂，避免与 DrawerShell 左缘手势重叠。
   *  mainPane（iPad 主区嵌套栈）：能否返回看 nested navigation.canGoBack()，但左缘手势交给嵌套 stack 自带的
   *  swipe-back（gestureEnabled），不挂这里的手动 PanResponder（避免双份手势 / 与侧栏左缘冲突）。 */
  const canGoBack = (!inDrawer || mainPane) && navigation.canGoBack();
  /** 是否挂手动左缘 PanResponder：只有 iPhone 全屏 push 模式（非 inDrawer、非 mainPane）才需要。 */
  const useManualEdgeBack = canGoBack && !mainPane && !inDrawer;
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

  const renderToolBlock = useCallback((block: Extract<StreamBlock, { type: 'tool' }>, key: string) => {
    if (
      block.tool_name === 'local_cursor_agent' ||
      block.tool_name === 'local_claude_agent' ||
      block.tool_name === 'subagent_start' ||
      block.tool_name === 'subagent_continue'
    ) {
      return renderSubagentBlock(block, key);
    }
    if (block.tool_name === 'subagent_find_sessions' || block.tool_name === 'subagent_get_session') {
      return renderSubagentMetaBlock(block, key);
    }
    if (block.tool_name === 'ask_user_question') {
      return renderAskUserQuestionBlock(block, key);
    }
    if (block.tool_name === 'show_visual') {
      return renderVisualWidgetBlock(block, key);
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

    // fetch_url_rendered 只有 summarize 产出对得上 ReadPagesCard（readings）；原文形态没有对应富卡，
    // 与 read_page_raw 一样落 DefaultToolCard。旧名 read_page_subagent 恒走概括卡。
    if (
      block.tool_name === 'read_page_subagent' ||
      (block.tool_name === 'fetch_url_rendered' && isFetchUrlRenderedSummarize(block))
    ) {
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
        renderToolCardAuthorizationActions={renderToolCardAuthorizationActions}
        authSubmitting={Boolean(submittingAuthorizationId && submittingAuthorizationId === block.auth_request?.request_id)}
      />
    );
  }, [colors.textMuted, renderAskUserQuestionBlock, renderExecCommandToolCard, renderFileEditToolCard, renderFileWriteToolCard, renderFlowDocEditToolCard, renderFlowDocGetTreeToolCard, renderFlowDocPatchToolCard, renderFlowDocReadToolCard, renderFlowDocWriteToolCard, renderReadPagesToolCard, renderSearchEngineToolCard, renderSubagentBlock, renderSubagentMetaBlock, renderToolCardSafetyActions, renderToolCardAuthorizationActions, submittingAuthorizationId, renderVisualWidgetBlock, setToolCardMode, styles, submittingReviewId, toolCardViewMode]);

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

  const renderMessage = useCallback((msg: ChatMessage, idx: number) => {
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
          onOpenSubagentView={openSubagentView}
        onOpenConversation={openConversationById}
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
    // 本条含"挂起等待用户"的工具卡（安全确认 / 工具授权 / ask 选择题）时，本轮尚未结束——
    // 与 Web/Desktop VirtualMessageList.msgHasAwaitingTool 一致，抑制回复结束操作栏（复制/重新生成）。
    const msgHasAwaitingTool =
      !isUser &&
      msg.role === 'assistant' &&
      Array.isArray(msg.blocks) &&
      msg.blocks.some(
        (b) =>
          b?.type === 'tool' &&
          (b?.status === 'awaiting_confirmation' ||
            b?.status === 'awaiting_authorization' ||
            // 点「允许/拒绝」后乐观置态（confirming=提交中 / rejected_by_user=已拒绝）：仍在
            // 「提交中→续跑完成」途中，本轮未结束，操作栏须继续隐藏，否则提交瞬间闪出操作行。
            b?.status === 'confirming' ||
            b?.status === 'rejected_by_user' ||
            String((b as ToolBlock)?.tool_name || '') === 'ask_user_question')
      );
    // TTS 语音播放（本条 assistant 消息服务端已合成的 metadata.audio）。
    const msgAudio = msg.role === 'assistant' ? msg.audio : undefined;
    const audioSegments = msgAudio?.segments;
    // isTtsPlaybackSupported 门控：原生回放模块缺失的平台（如未 rebuild 的旧包）不渲染死按钮
    const hasAudio =
      isTtsPlaybackSupported() && Array.isArray(audioSegments) && audioSegments.length > 0;
    const audioIsThis = ttsPlayback.key === stableKey;
    const audioIsPlaying = audioIsThis && ttsPlayback.state === 'playing';
    const audioIsLoading = audioIsThis && ttsPlayback.state === 'loading';
    const onPlayAudio = () => {
      if (!hasAudio) return;
      void togglePlayback(audioSegments as string[], {
        key: stableKey,
        title: (msg.content || '').trim().slice(0, 40) || 'Flops 语音',
        subtitle: composerAgentLabel,
        // 传 convId：某段是 .mp3.enc 密文时 ttsPlayer 用 getCachedKConv 解密再播（同 Web/Desktop）
        convId: conversationId ?? undefined,
      });
    };
    const segmentUsage =
      showTokenUsageInChat && usageByAssistantIdx[idx]
        ? formatUsageTiny(usageByAssistantIdx[idx], { currencyMode: usageCurrencyDisplay })
        : undefined;
    const segmentDetail =
      showTokenUsageInChat && usageByAssistantIdx[idx]
        ? formatUsageHoverDetail(usageByAssistantIdx[idx], {
            currencyMode: usageCurrencyDisplay,
            modelPriceReference,
            selectedModelId: effectiveSelectedModel,
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
                      onOpenSubagentView={openSubagentView}
        onOpenConversation={openConversationById}
                    />
                  );
                }
                if (block.type === 'user_injection') {
                  return <UserInjectionInline key={`msg-userinj-${idx}-${bi}`} content={block.content} />;
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
                        // 回复结束操作栏（含右侧 token 用量）：挂起(awaiting/confirming 等 msgHasAwaitingTool)
                        // 或流式进行中(loading，含续起 run 流式恢复)都**整行隐藏**（左按钮 + 右 token 一起），
                        // 等流结束才显示——与 Desktop hideStreamToolbar 对齐。
                        showCopyButton={isLastAssistant && bi === lastTextBlockIdx && !msgHasAwaitingTool && !loading}
                        showRegenerateButton={bi === lastTextBlockIdx && !msgHasAwaitingTool && !loading}
                        showPlayButton={hasAudio && bi === lastTextBlockIdx}
                        isPlaying={audioIsPlaying}
                        isPlayLoading={audioIsLoading}
                        onPlay={hasAudio && bi === lastTextBlockIdx ? onPlayAudio : undefined}
                        onRegenerate={afterUserIndex >= 0 ? () => handleRegenerate(afterUserIndex) : undefined}
                        regenerateDisabled={!conversationId || loading || conversationHistoryLoading}
                        usageHint={bi === lastTextBlockIdx && !msgHasAwaitingTool && !loading ? segmentUsage : undefined}
                        usageDetail={bi === lastTextBlockIdx && !msgHasAwaitingTool && !loading ? segmentDetail : undefined}
                        compressHint={
                          bi === lastTextBlockIdx && showCompressOnThisAssistant && !msgHasAwaitingTool && !loading
                            ? compressUsagePart
                            : undefined
                        }
                        onCompressClick={
                          showCompressOnThisAssistant && bi === lastTextBlockIdx && !msgHasAwaitingTool && !loading
                            ? scrollToContextCompressAnchor
                            : undefined
                        }
                        compressAriaLabel={
                          showCompressOnThisAssistant && bi === lastTextBlockIdx && !msgHasAwaitingTool && !loading
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
              {/* 仅有工具块、无 assistant 文本时：与 Web ChatMessageList renderBlocks 一致（有重新生成和/或用量、压缩条）。
                  同上：挂起(msgHasAwaitingTool)或流式中(loading，含续起恢复)整行隐藏，等流结束才显示。 */}
              {lastTextBlockIdx < 0 &&
              msg.role === 'assistant' &&
              !msgHasAwaitingTool &&
              !loading &&
              (afterUserIndex >= 0 ||
                hasAudio ||
                (showTokenUsageInChat && Boolean(segmentUsage)) ||
                showCompressOnThisAssistant) ? (
                <View style={styles.assistantTextBlock}>
                  <MarkdownContent
                    text=""
                    showRegenerateButton={afterUserIndex >= 0}
                    showPlayButton={hasAudio}
                    isPlaying={audioIsPlaying}
                    isPlayLoading={audioIsLoading}
                    onPlay={hasAudio ? onPlayAudio : undefined}
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
                  attachments={msg.role === 'user' ? msg.attachments : undefined}
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
                  showCopyButton={isLastAssistant && !loading}
                  showRegenerateButton={!loading}
                  onRegenerate={afterUserIndex >= 0 ? () => handleRegenerate(afterUserIndex) : undefined}
                  regenerateDisabled={!conversationId || loading || conversationHistoryLoading}
                  usageHint={!loading ? segmentUsage : undefined}
                  usageDetail={!loading ? segmentDetail : undefined}
                  compressHint={showCompressOnThisAssistant && !loading ? compressUsagePart : undefined}
                  onCompressClick={showCompressOnThisAssistant && !loading ? scrollToContextCompressAnchor : undefined}
                  compressAriaLabel={
                    showCompressOnThisAssistant && !loading ? contextCompressScrollToAnchorTitle : undefined
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
  }, [composerAgentLabel, contextCompressMessagePercent, contextCompressPlacement, conversationHistoryLoading, conversationId, effectiveSelectedModel, handleRegenerate, lastAssistantIdx, loading, messageWindowMeta?.viewStart, modelPriceReference, ordinalInfo, presentUserMessageActions, renderToolBlock, scrollToContextCompressAnchor, serverRawMessages, showTokenUsageInChat, styles.assistantBubble, styles.assistantBubbleWrap, styles.assistantTextBlock, styles.assistantTextBlockCompactAbove, styles.assistantTextBlockTightAfterThinking, styles.bubble, styles.bubbleRole, styles.bubbleWrap, styles.errorText, styles.errorWrap, styles.userBubble, styles.userBubbleWrap, styles.userText, ttsPlayback.key, ttsPlayback.state, usageByAssistantIdx, usageCurrencyDisplay]);

  /* ── 历史消息整棵子树按引用缓存 ────────────────────────────────────────────
   * live 段最贵的一笔开销：**messages 根本没变**，变的只有流式气泡，但每一帧都要把
   * 几十条历史消息重新 map 一遍 —— 每行的 formatUsageTiny / formatUsageHoverDetail、
   * 找 lastTextBlockIdx 的 blocks 扫描、以及整棵 host View 子树的 reconcile 全部重跑。
   *
   * 这里缓存的是**元素数组本身**：依赖没变时返回同一批 element 引用，React 认出引用相同
   * 会直接跳过整个子树 —— 比逐行 React.memo 更彻底（连 memo 比较器都不用跑），
   * 代价只是一个依赖数组。
   *
   * 依赖完整性由 eslint react-hooks/exhaustive-deps 机检：renderMessage 及它调用的
   * renderToolBlock → 各 render*Card 链全部包成了 useCallback，规则能一路追进去，
   * 所以这里只需要列 messages + renderMessage，深层依赖由链上每一环各自申报。
   * exec 卡的秒表是唯一一个 eslint 看不见的驱动源，已在 renderExecCommandToolCard 里
   * 用一次显式读取（void runningExecTick）把它接回依赖链，不在这儿手工补。 */
  const renderedMessages = useMemo(
    () => messages.map(renderMessage),
    [messages, renderMessage]
  );

  const showEmpty =
    messages.length === 0 && !loading && !conversationHistoryLoading;
  const streamEmptyPlaceholderResume =
    v2ResumeUiActive &&
    currentAssistantBlocks.length === 0 &&
    !(streamingText && streamingText.trim());
  // 续起 run 续接的是已存在的那条 assistant 气泡（挂起轮）→ 流式气泡不该再顶一条「Agent 名 (状态)」
  // 角色条（会重复/突兀）。与 Desktop VirtualMessageList.streamIsResumeContinuation 同款：
  // 正在 resume 且 messages 末条(跳过 tool / isMeta user)是 assistant 时隐藏该角色条。
  const streamIsResumeContinuation = (() => {
    if (!v2ResumeUiActive) return false;
    for (let j = messages.length - 1; j >= 0; j -= 1) {
      const r = String(messages[j]?.role || '');
      if (r === 'tool') continue;
      if (r === 'user' && (messages[j] as { isMeta?: boolean })?.isMeta) continue;
      return r === 'assistant';
    }
    return false;
  })();
  const streamStatusBracketLabel = streamEmptyPlaceholderResume
    ? 'thinking' // 续起 run 占位与 Desktop 一致用 thinking，不显示 resuming
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
    ? 'Thinking...' // 续起首 token 前占位与 Desktop 一致用 Thinking…，不显示 Resuming…
    : streamStatusLabel;

  /* 未登录早退。**位置很重要**：必须在本组件所有 Hook 之后 —— 原来它在 ordinalInfo 那个
     useMemo 上面，属于「条件调用 Hook」（eslint react-hooks/rules-of-hooks 一直在报），
     session 一旦从 null 变成非 null，Hook 数量就会对不上而崩。下面新增的 renderedMessages
     也是 useMemo，一并挪到早退之上。
     搬下来是安全的：从原位置到这里之间只有纯计算，没有副作用，且没有一处读 session
     （第一个用到的就是紧跟着的 <ChatMessageArea session={session}>）。 */
  if (!session) return null;

  /* 消息区元素只造一份，两种布局（平铺 / 落进 sheet）复用同一份 props。
   * **它在任何分支下都要挂着**：ChatScreen 里 20+ 处钉底/滚动命令全走 messageAreaRef 的可选链，
   * 某个分支不挂载的话钉底会静默失效（见 ChatMessageArea 头注）。所以下面两处是
   * 严格二选一，绝不会同时为空。 */
  const chatMessageArea = (
    <ChatMessageArea
      ref={messageAreaRef}
      session={session}
      conversationId={conversationId}
      messages={messages}
      serverRawMessages={serverRawMessages}
      currentAssistantBlocks={currentAssistantBlocks}
      streamingText={streamingText}
      liveInjections={liveInjections}
      conversationAttachmentsMap={conversationAttachmentsMap}
      contextCompressPlacement={contextCompressPlacement}
      contextCompressAnchorRef={contextCompressAnchorRef}
      bottomPin={chatBottomPinRef.current}
      showEmpty={showEmpty}
      loading={loading}
      bgPauseRecovering={bgPauseRecovering}
      conversationHistoryLoading={conversationHistoryLoading}
      reloadPending={reloadPending}
      loadingOlder={loadingOlder}
      hasOlder={Boolean(messageWindowMeta?.hasOlder)}
      composerAgentLabel={composerAgentLabel}
      streamStatusBracketLabel={streamStatusBracketLabel}
      streamBubblePlaceholderText={streamBubblePlaceholderText}
      streamIsResumeContinuation={streamIsResumeContinuation}
      renderedMessages={renderedMessages}
      renderToolBlock={renderToolBlock}
      onOpenSubagentView={openSubagentView}
        onOpenConversation={openConversationById}
      onRegenerate={handleRegenerate}
      onReachTop={() => void loadOlderMessages()}
      onDismissComposer={dismissComposer}
      styles={styles}
      colors={colors}
      /* 协同模式下消息区在 sheet 里：顶上没有 header 要让位，只留 sheet handle 的余量。 */
      headerHeight={collabActive ? 0 : headerHeight}
      scrollBottomPadding={scrollBottomPadding}
      wideChat={wideChat}
      historyOverlayBottomOverflow={insets.bottom + 32}
    />
  );

  /* ── 右上角操作簇 ──
   * 协同布局被关掉时，⋯ 左边多一个带角标的协同入口，两个选项合成**一颗胶囊**。
   *
   * 胶囊态**三端一律走自绘**（白底 + hairline + 投影），包括 iOS 26。原本想在 iOS 26 上用
   * 系统 Liquid Glass 材质做胶囊本体，试了三版都是「材质一片不画」：真机逐像素量，胶囊内
   * 与页面底色一模一样 (248,249,251)，而同屏返回钮（同样走 glassButtonConfiguration）是
   * (252,252,254) 亮得出来。手搭 UIVisualEffectView+UIGlassEffect 不画、复用 _glassButton
   * 当背景板也不画，配置链查下来没问题（applySfSymbolName 空名只清 image、不动 glass cfg），
   * 剩下的怀疑点只能上真机调试才能收敛。
   * 而目标本来就是 Android 那枚**白色实底**胶囊（量到胶囊内 (255,255,255)、页面 (247,247,247)）
   * —— 自绘这条路已经在跑、且用户认可，就不为了材质再耗。胶囊里的两格都用 iosForceWorklet
   * 走非玻璃路径，否则 iOS 26 会在白胶囊里再叠两颗玻璃药丸。 */
  const collabEntryVisible = collabAvailable && collabDismissed;
  /** ⋯ 触发器在胶囊里是「一格」（透明、无底色），单独出现时才是圆钮。 */
  const convMenuTriggerStyle = collabEntryVisible
    ? styles.headerCapsuleSegment
    : styles.circleBtn;
  /* 右上角 ⋯ 菜单 三条路：
   *  - iOS 26+ 且**不在胶囊里**：AnimatedCircleButton 透传 menuActions 给 BouncyButton，
   *    底下 UIButton 直接挂原生 UIMenu（glass material + 系统 scale + UIMenu 弹层 全套
   *    系统接管）。进了胶囊就得让位给 MenuView —— 玻璃材质那条路没法只要菜单不要材质。
   *  - iOS 15..25 / iOS 26 胶囊态：MenuView（同样是原生 UIMenu，只是没玻璃 material）。
   *  - Android：AnimatedCircleButton + 自绘 Modal popover。 */
  const convMenuTrigger = IS_IOS_LIQUID_GLASS && !collabEntryVisible ? (
    <AnimatedCircleButton
      style={[convMenuTriggerStyle, !conversationId ? styles.circleBtnDisabled : null]}
      disabled={!conversationId}
      menuActions={glassMenuActions}
      iosSfSymbol={{ name: 'ellipsis', size: 16, color: colors.textSecondary }}
      onMenuAction={onConvMenuAction}
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
          convMenuTriggerStyle,
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
        style={[convMenuTriggerStyle, !conversationId && styles.circleBtnDisabled]}
        onPress={openConvMenu}
        disabled={!conversationId}
      >
        <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
      </AnimatedCircleButton>
    </Reanimated.View>
  );
  /** 点协同入口 → 原样开回协同布局。 */
  const openCollabWorkspace = () => {
    /* 溶解进度先归零，否则 sheet 与工作区会带着「已经化没了」的透明度挂回来。 */
    collabDismissProgress.value = 0;
    collabDismissCommitted.value = false;
    /* 档位一并回到 mid：sheet 挂载时 index=1，档位 state 不跟着回去的话，
       聊天区高度会先按关掉前那一档算一帧。 */
    setCollabSheetIndex(1);
    /* 走 settled 版：开回来同样是一次重挂，首帧也得先按住别画。 */
    setCollabDismissedSettled(false);
  };
  /** 协同入口那一格。iosForceWorklet：胶囊里不要玻璃材质，否则 iOS 26 会在白胶囊里
   *  再叠一颗玻璃药丸（仍有 UI 线程 bouncy 按压反馈，只是没材质）。 */
  const collabEntryNode = collabEntryVisible ? (
    <Reanimated.View style={[styles.headerCollabSlot, collabEntryStyle]}>
      <AnimatedCircleButton
        style={styles.headerCapsuleSegment}
        onPress={openCollabWorkspace}
        iosForceWorklet
      >
        <Ionicons name="layers-outline" size={21} color={colors.textSecondary} />
      </AnimatedCircleButton>
      {collabTabCount > 0 ? (
        <View style={styles.headerCapsuleBadge} pointerEvents="none">
          <Text style={styles.headerUnreadBadgeText} numberOfLines={1}>
            {collabTabCount > 99 ? '99+' : collabTabCount}
          </Text>
        </View>
      ) : null}
    </Reanimated.View>
  ) : null;
  /* 胶囊里的两格 + 中缝，两条路共用。 */
  const headerCapsuleContent = (
    <>
      {collabEntryNode}
      <View style={styles.headerCapsuleDivider} />
      {convMenuTrigger}
    </>
  );
  const headerActions = !collabEntryVisible ? (
    convMenuTrigger
  ) : IS_IOS_LIQUID_GLASS ? (
    /* iOS 26：胶囊本体直接用 BouncyGlassCard —— 项目里**已经验证能画出玻璃**的那套
       （底部 composer 就是它）。它内部是 UIVisualEffectView + UIGlassEffect，形状走
       UIView.cornerConfiguration 而不是 layer mask（玻璃由系统 out-of-process 渲染，
       in-process 的 mask 裁不动它，见 BouncyGlassCardComponentView.applyCornerShape 的注释）
       —— 我先前自搭那几版栽的正是这一条。
       interactive=false：不要整颗胶囊一起放大，按压反馈各格自己做（同 composer 的选择）。 */
    <BouncyGlassCard
      style={styles.headerGlassCapsule}
      cornerRadius={HEADER_CIRCLE_BTN_SIZE / 2}
      interactive={false}
    >
      {headerCapsuleContent}
    </BouncyGlassCard>
  ) : (
    <View style={styles.headerCapsule}>{headerCapsuleContent}</View>
  );

  return (
    <>
    {/* edges 不含 'bottom'：bottom inset 交给 bottomOverlay 处理（见 navInset），
        避免 SafeAreaView 在透明导航栏后面糊一条白 padding 带。 */}
    <SafeAreaView style={styles.container} edges={[]}>
    <View
      style={styles.containerInner}
      /* 协同模式 sheet 的档位与消息区可视高度补偿都按这个盒子算（BottomSheet 的 hosting
         container 就绝对定位在它里面）。实测而不是拿窗口高度估，省得差那几像素。 */
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height);
        setCollabHostHeight((prev) => (prev === h ? prev : h));
      }}
    >
      {useManualEdgeBack ? (
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
          /* 渐变基色必须跟顶栏**背后那块画布**同色，否则实色段与画布错开一档、渐变尾巴
             也会浮出一层灰。普通聊天页背后是消息区（chatScreenBackground）；协同模式下
             顶栏压的是工作区层，而它已随分层改成了 drawerBackground（见 collabWorkspaceLayer）。 */
          gradientBaseHex={collabActive ? colors.drawerBackground : colors.chatScreenBackground}
        />
        {/* inDrawer（compact 覆盖式抽屉顶层）= 永远汉堡；否则能返回就显返回箭头（mainPane pop 嵌套栈 /
         *  iPhone pop 根栈），不能返回（mainPane 栈底）兜底汉堡。 */}
        {/* 左上角按钮槽：返回箭头 / 汉堡 / 占位，其余对话有未读时右上角挂微信式红点数字 badge。 */}
        <View style={styles.headerLeftSlot}>
          {inDrawer || (mainPane && !canGoBack) ? (
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
          {otherUnreadCount > 0 ? (
            <View style={styles.headerUnreadBadge} pointerEvents="none">
              <Text style={styles.headerUnreadBadgeText} numberOfLines={1}>
                {otherUnreadCount > 99 ? '99+' : otherUnreadCount}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
            {conversationId ? (conversationTitle || '新对话') : 'Flops'}
          </Text>
        </View>
        {headerActions}
      </View>

      {/* ── 协同工作模式：工作区主体（最底层，被 sheet 与 composer 盖住的部分靠 inset 让位）── */}
      {collabActive ? (
        <Reanimated.View style={[styles.collabWorkspaceLayer, collabWorkspaceCanvasStyle]}>
          <Reanimated.View style={[styles.collabWorkspaceInner, collabWorkspaceContentStyle]}>
            <WorkspaceBody
              layout={collabLayout}
              topInset={headerHeight}
              bottomInset={collabSheetPeekHeight}
              /* 当前档真正占掉的高度：居中类页面按它算可视区（sheet 一展开就得往上让） */
              viewportBottomInset={collabSheetVisibleHeight}
              /* 走马灯指示器贴着 sheet 上沿走：sheet 拖到哪档，tabs 就跟到哪 */
              sheetTopY={collabSheetPosition}
              sheetTopYMax={collabSheetLowestTopY}
            />
          </Reanimated.View>
        </Reanimated.View>
      ) : null}
      {/* ── 协同工作模式：聊天消息区落进 bottom sheet ──
       * 位置在 KeyboardAvoidingView **之前** = 画在 composer 之下：折叠 sheet 也能边看文档边输入。
       * 键盘避让在这里由 sheet 自己做（keyboardBehavior='interactive'，容器是整页高、
       * 量到的 containerOffset.bottom=0，偏移量正好是键盘高）；composer 那侧仍归 KAV 管。
       * 两者各自避让同一个键盘、互不叠加 —— 把 sheet 塞进 KAV 里才会双重避让（KAV 先缩容器、
       * sheet 再按整个键盘高往上顶）。 */}
      {collabActive ? (
        <BottomSheet
          ref={collabSheetRef}
          snapPoints={collabSheetSnapPoints}
          index={1}
          /* 档位变化 → 聊天区高度要跟着变（见 collabSheetChatHeight）。
             onAnimate 给的是**目标**档，动画一开始就把 ScrollView 调到位（展开时新露出来的
             那块当场就有内容）；onChange 是收尾确认，兜住拖拽甩到别档的情况。 */
          onAnimate={(_from, to) => {
            if (to >= 0) setCollabSheetIndex(to);
          }}
          onChange={(index) => {
            if (index >= 0) setCollabSheetIndex(index);
          }}
          /* 顶沿位置逐帧抛给工作区层（指示器跟着它走）。拖拽 / 键盘顶起都在 UI 线程更新，
             不经 React —— 所以 tabs 跟随是跟手的，不是等档位 state 落定才跳一下。 */
          animatedPosition={collabSheetPosition}
          /* 只为截住「松手」这一下（见 useCollabSheetGestureHandlers）；其余手势行为不变。 */
          gestureEventsHandlersHook={useCollabSheetGestureHandlers}
          /* 顶到 header 下沿为止：百分比档位按「header 以下」这块算，
             最高档也不会把 handle 藏到顶栏毛玻璃后面。 */
          topInset={headerHeight}
          enableDynamicSizing={false}
          enablePanDownToClose={false}
          /* 消息区是自带滚动的普通 ScrollView（Phase 0 抽出来时原样保留），不是
             BottomSheetScrollView：关掉内容区拖拽手势，免得跟列表滚动抢 responder。
             sheet 靠顶部 handle 拖，或由 collabSheetRef 程序化展开/折叠。 */
          enableContentPanningGesture={false}
          /* interactive 的实际语义（lib 内 getEvaluatedPosition）：键盘一弹就把 sheet 顶到
             「最高档 - 键盘高」，收键盘再由 blurBehavior='restore' 回到原来那档。于是
             「点输入框 → 聊天升起来看得见上下文 → 收键盘 → 回到刚才那档继续看文档」，
             折叠态也不会被永久顶开。 */
          keyboardBehavior="interactive"
          keyboardBlurBehavior="restore"
          /* 面与把手都自渲染：溶解过渡要让这两样跟着进度淡出（见 collabSheetChromeStyle）。
             backgroundStyle 照旧传 —— gorhom 会把它拼进 style 交给下面这个组件，圆角 /
             hairline / 投影全都原样生效。把手容器高度仍钉死在 collabSheetHandleBar 上：
             聊天区高度是「当前档高 - 把手高」算出来的，这个数不能随内容浮动。 */
          backgroundStyle={styles.collabSheetBackground}
          backgroundComponent={renderCollabSheetBackground}
          handleComponent={renderCollabSheetHandle}
        >
          {/* 用普通 View 而非 BottomSheetView：后者是给「内容自己量高」的动态尺寸场景用的
              （position:absolute + 无 bottom → 高度由内容决定），塞一个 flex:1 的 ScrollView
              进去会量成 0 高。这里也不用 flex:1 —— 高度按当前档位显式给死
              （见 collabSheetChatHeight），彻底不参与父级那条高度传递链。 */}
          <View
            style={[
              styles.collabSheetContent,
              collabSheetChatHeight > 0
                ? { height: collabSheetChatHeight }
                : styles.collabSheetContentFill,
            ]}
          >
            {chatMessageArea}
            {/* 把手 → 消息区的淡出。消息区自带滚动、内容会一路顶到把手下沿被 overflow 硬切，
                铺一条同色渐变让它化开（pointerEvents=none，不吃滚动手势）。
                它也是 sheet 的「壳」的一部分：溶解时要跟着面一起淡掉，否则 sheet 都化没了
                还剩一条 sheet 色的横带压在消息上。 */}
            <Reanimated.View
              style={[styles.collabSheetTopFade, collabSheetChromeStyle]}
              pointerEvents="none"
            >
              <LinearGradient
                colors={collabSheetTopFadeGradient(colors)}
                /* 中档提前到 0.2（原 0.45）：实色不留平台段，一出把手下沿就开始淡 —— 带子长度
                   不变（12pt），只是「看得出在淡」的起点往上挪。带子挂在内容区里，top:0 就是
                   把手下沿，再往上挪只能靠这条曲线：负 top 会被 BottomSheetContent 的 overflow
                   裁掉，挂到把手层则会拿方角盖掉 sheet 圆角（6ab8591 已实测翻车并回退）。 */
                locations={[0, 0.2, 1]}
                style={StyleSheet.absoluteFill}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                pointerEvents="none"
              />
            </Reanimated.View>
          </View>
        </BottomSheet>
      ) : null}

      <KeyboardAvoidingView
        style={styles.keyboardView}
        /* lib KAV 两端都用 'padding'：lib 内部用 WindowInsets.ime / UIKeyboardLayoutGuide 拿
         *  键盘 frame，paddingBottom 由 lib worklet 直接驱动。Android 不再走 adjustResize
         *  那条路（lib 不依赖它，传 undefined 会走 default no-op，content 完全不动），且
         *  edge-to-edge 模式下 adjustResize 行为已被 fitsSystemWindows=false 改变。 */
        behavior="padding"
        keyboardVerticalOffset={0}
        /* 协同模式：本层只有底部 composer 是实体，其余让位给 sheet（见下面 scrollAndGradientWrap）。 */
        pointerEvents={collabActive ? 'box-none' : 'auto'}
      >
        {error ? (
          <Text style={[styles.globalError, { marginTop: headerHeight + 8 }]}>{error}</Text>
        ) : null}
        {convLockedReason === 'need_parent' ? (
          <Text style={[styles.convLockedNotice, error ? null : { marginTop: headerHeight + 8 }]}>
            这是一个子 agent 的对话，它的密钥由发起它的那个对话保管（服务端也解不开）。
            现在取不到那个对话 —— 多半是它已被删除，或不在当前登录的账号下，所以内容无法解密。
          </Text>
        ) : null}

        {/* 协同模式下这层只剩 composer 有内容：其余区域一律让位，触摸落到底下的 sheet / 工作区。 */}
        <View
          style={styles.scrollAndGradientWrap}
          pointerEvents={collabActive ? 'box-none' : 'auto'}
        >
          {collabActive ? null : chatMessageArea}
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
                messageAreaRef.current?.scrollToBottom(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="滚动到对话底部"
            />
            <Reanimated.View style={[styles.bottomOverlayInner, navInsetAnimStyle]} pointerEvents="box-none">
              {/* P2 待发队列：agent 在跑时回车发的消息排这里，逐条自动发；可对某条立刻穿插或删除 */}
              {sendQueue.length > 0 ? (
                <View
                  style={{ marginHorizontal: 12, marginBottom: 8, gap: 6 }}
                  pointerEvents="box-none"
                >
                  {/* 待发队列：参考 web —— 虚线边框卡片 + 文字 + 「穿插」/「×」描边胶囊按钮 */}
                  {sendQueue.map((it) => (
                    <View
                      key={it.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        backgroundColor: colors.surface,
                        borderRadius: 14,
                        borderWidth: 1,
                        borderStyle: 'dashed',
                        borderColor: colors.borderMuted,
                        paddingVertical: 10,
                        paddingLeft: 14,
                        paddingRight: 8,
                        opacity: it.pending ? 0.6 : 1,
                      }}
                    >
                      <Text
                        numberOfLines={2}
                        style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.textBody }}
                      >
                        {it.text || '（空）'}
                      </Text>
                      {loading ? (
                        <TouchableOpacity
                          onPress={() => injectQueueItem(it.id)}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          accessibilityLabel="立刻穿插"
                          activeOpacity={0.7}
                          style={{
                            paddingVertical: 5,
                            paddingHorizontal: 12,
                            borderRadius: 9,
                            borderWidth: 1,
                            borderColor: colors.borderMuted,
                            backgroundColor: colors.surfaceMuted,
                          }}
                        >
                          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.accentPurple }}>
                            穿插
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                      <TouchableOpacity
                        onPress={() => deleteQueueItem(it.id)}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        accessibilityLabel="移除待发消息"
                        activeOpacity={0.7}
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 9,
                          borderWidth: 1,
                          borderColor: colors.borderMuted,
                          backgroundColor: colors.surfaceMuted,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons name="close" size={16} color={colors.textSecondary} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              ) : null}
              {/* 输入区。short 模式：圆角胶囊一行，+ 内嵌左侧 + 输入填满；模型 / 助手 chips
                  走绝对定位的 meta row 贴在 composer 下面留白里。
                  tall 模式：圆角卡片两行，上面纯输入区，下面一行 [+ 按钮][model][agent]
                  全部 inline 在卡片底部 — 不再走绝对 meta row（避免位置错位）。
                  发送统一靠键盘 Return（FlowDocSlateAdapter.onSubmitOnEnter） — 没有发送按钮。
                  loading 时把 + 换成 ⏹ 停止键。 */}
              {/* 语音听写错误：贴在 composer 上方的临时气泡（4s 自动消失） */}
              {dictationError ? (
                <View style={styles.composerDictationError} pointerEvents="none">
                  <Text style={styles.composerDictationErrorText} numberOfLines={2}>
                    {dictationError}
                  </Text>
                </View>
              ) : null}
              {/* 「发送文件」待发附件 chips（对齐 Desktop）：圆角卡片 + 48 缩略图（图片直接预览 /
                  文件按类型彩色图标）+ 文件名 + 大小；上传中暗蒙层转圈、失败红蒙层；右上角 × 移除。 */}
              {pendingAttachments.length > 0 ? (
                <View style={styles.composerAttachRow}>
                  {pendingAttachments.map((a) => {
                    const isImage = a.mime.startsWith('image/') && !!a.uri;
                    const ft = fileTypeMeta(a.mime, a.name);
                    const sizeLabel = formatFileSize(a.size);
                    return (
                      <View
                        key={a.id}
                        style={[
                          styles.composerAttachChip,
                          a.status === 'error' ? styles.composerAttachChipError : null,
                        ]}
                      >
                        <View
                          style={[
                            styles.composerAttachThumb,
                            !isImage ? { backgroundColor: ft.tint } : null,
                          ]}
                        >
                          {isImage ? (
                            <Image source={{ uri: a.uri }} style={styles.composerAttachThumbImg} />
                          ) : (
                            <Ionicons
                              name={ft.icon as React.ComponentProps<typeof Ionicons>['name']}
                              size={22}
                              color={ft.color}
                            />
                          )}
                          {a.status === 'uploading' ? (
                            <View style={styles.composerAttachThumbOverlay}>
                              <ActivityIndicator size="small" color="#ffffff" />
                            </View>
                          ) : null}
                          {a.status === 'error' ? (
                            <View
                              style={[
                                styles.composerAttachThumbOverlay,
                                styles.composerAttachThumbOverlayErr,
                              ]}
                            >
                              <Ionicons name="alert-circle" size={20} color="#ffffff" />
                            </View>
                          ) : null}
                        </View>
                        <View style={styles.composerAttachMeta}>
                          <Text numberOfLines={1} style={styles.composerAttachName}>
                            {a.name}
                          </Text>
                          {a.status === 'error' ? (
                            <Text numberOfLines={1} style={styles.composerAttachErrText}>
                              {a.error || '上传失败'}
                            </Text>
                          ) : a.status === 'uploading' ? (
                            <Text numberOfLines={1} style={styles.composerAttachSize}>
                              上传中…
                            </Text>
                          ) : sizeLabel ? (
                            <Text numberOfLines={1} style={styles.composerAttachSize}>
                              {sizeLabel}
                            </Text>
                          ) : null}
                        </View>
                        <TouchableOpacity
                          onPress={() => removePendingAttachment(a.id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityLabel="移除附件"
                          activeOpacity={0.7}
                          style={styles.composerAttachRemove}
                        >
                          <Ionicons name="close" size={13} color={colors.textSecondary} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              ) : null}
              {(() => {
                /* iOS + Android 都有右下角发送/停止键（对齐桌面/web）→ 左侧 + 永远只做"引用文档"，
                   不再兼任停止（停止交给发送键的停止态）。 */
                const showSendBtn = Platform.OS === 'ios' || Platform.OS === 'android';
                /* 「+」是附件菜单触发器：点开 → 引用 FlowDoc 文档 / 发送文件（停止交给右下角发送键的停止态）。
                   iOS 走原生 MenuView（打开时图标淡）；Android 走自绘 popover。 */
                const plusDisabled = !session || conversationHistoryLoading;
                const plusIcon = (
                  <Reanimated.View style={composerAttachIconAnimStyle}>
                    <Ionicons name="add" size={22} color={colors.textSecondary} />
                  </Reanimated.View>
                );
                const renderPlusBtn = plusDisabled ? (
                  <View style={[styles.composerPlusBtnAbsolute, { opacity: 0.4 }]}>
                    <Ionicons name="add" size={22} color={colors.textSecondary} />
                  </View>
                ) : Platform.OS === 'ios' ? (
                  <MenuView
                    title=""
                    style={styles.composerPlusBtnAbsolute}
                    actions={composerAttachMenuActions as unknown as any[]}
                    onPressAction={onComposerAttachMenuView}
                    onOpenMenu={openComposerAttachMenu}
                    onCloseMenu={closeComposerAttachMenu}
                    shouldOpenOnLongPress={false}
                  >
                    <View style={styles.composerPlusBtnInner}>{plusIcon}</View>
                  </MenuView>
                ) : (
                  /* 不用 hitSlop：Android hitSlop 只扩 JS 命中区、native 分发不认，环带 touch 会
                     穿给底下的 EditText 弹键盘。touch 区直接做进 view 尺寸（TOUCH_SIZE，同心）。 */
                  <TouchableOpacity
                    style={styles.composerPlusBtnAbsolute}
                    onPressIn={onComposerAttachPressIn}
                    onPressOut={onComposerAttachPressOut}
                    onPress={openAndroidComposerAttachMenu}
                    accessibilityLabel="添加附件"
                    activeOpacity={0.7}
                  >
                    <View style={styles.composerPlusBtnInner}>{plusIcon}</View>
                  </TouchableOpacity>
                );
                /* 右下角发送键（仅 iOS，跟右侧半圆同心）：
                   - 运行中且内容为空 → 停止键（handleStop）
                   - 否则 → 发送键（handleSendMessage；idle=发送 / 运行中有内容=入待发队列）
                   - idle 且无内容 → 发送禁用（灰） */
                /* 语音听写 pending 也算"有内容"：录音中按发送要能点（会打断听写并把 pending 一起发），
                   所以停止态 / 禁用态都用 composerHasSendableContent 而非纯 composerStats.hasContent。 */
                const sendIsStop = loading && !composerHasSendableContent;
                const sendDisabled =
                  !sendIsStop &&
                  (!session || conversationHistoryLoading || !composerHasSendableContent);
                const renderSendBtn = showSendBtn ? (
                  <TouchableOpacity
                    style={[
                      styles.composerSendBtnAbsolute,
                      /* 跟 web 一致：亮色=黑底白 icon，暗色反之（白底黑 icon）——用随主题翻转的
                         textPrimary(底)+surface(icon) 自动得到。禁用：灰底白 icon（surfaceMuted 太浅
                         显不出白 icon，用中性灰 placeholder 作底）。 */
                      {
                        backgroundColor: sendDisabled
                          ? '#a3a3a3' /* 中性灰（R=G=B），非 placeholder 的偏蓝冷灰 */
                          : colors.textPrimary,
                      },
                    ]}
                    /* handleSendPress 包一层：handleSendMessage 现在收可选 opts（图卡回注的
                       overrideText），直接挂 onPress 会把 GestureResponderEvent 当 opts 传进去。 */
                    onPress={sendIsStop ? handleStop : handleSendPress}
                    disabled={sendDisabled}
                    accessibilityLabel={sendIsStop ? '停止' : '发送'}
                    activeOpacity={0.7}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Ionicons
                      name={sendIsStop ? 'stop' : 'arrow-up'}
                      size={sendIsStop ? 15 : 20}
                      color={sendDisabled ? '#ffffff' : colors.surface}
                    />
                  </TouchableOpacity>
                ) : null;
                /* 麦克风键：card 的 absolute child，在发送键左边（其它平台贴右，镜像 +）。
                   tap-to-toggle 语音听写。录音中：图标（空心 mic-outline）变深红 colors.danger，
                   图标后面出现一个红色背景圆 + 往外扩散淡出的涟漪（对齐 Desktop .mic-recording-pulse）。 */
                const dictationActive = dictationState === 'recording';
                const renderMicBtn = (
                  <View style={styles.composerMicBtnAbsolute} pointerEvents="box-none">
                    <TouchableOpacity
                      style={styles.composerMicBtnInner}
                      onPress={onMicPress}
                      onLongPress={onMicLongPress}
                      disabled={!session}
                      accessibilityLabel={dictationActive ? '结束语音输入' : '语音输入'}
                      activeOpacity={0.7}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      {/* 先画背景圆 / 涟漪（绝对定位、在图标下面），最后画图标 → 图标永远在最上层 */}
                      {dictationActive ? (
                        <>
                          <View style={styles.composerMicActiveDisc} pointerEvents="none" />
                          <Reanimated.View
                            style={[styles.composerMicPulseRing, micPulseStyle]}
                            pointerEvents="none"
                          />
                        </>
                      ) : null}
                      <Ionicons
                        name="mic-outline"
                        size={20}
                        color={dictationActive ? colors.danger : colors.placeholder}
                      />
                    </TouchableOpacity>
                  </View>
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
                                selectedModelId: effectiveSelectedModel,
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
                    ref={composerAdapterRef}
                    initialDocument={composerDoc}
                    onChange={handleComposerDocChange}
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
                    /* agent 跑动时也可编辑：P2 待发队列 / 穿插消息需要 run 中输入。只在历史加载中禁用。 */
                    editable={!conversationHistoryLoading}
                    textContainerInset={
                      composerTall ? COMPOSER_TEXT_INSET_TALL : COMPOSER_TEXT_INSET_SHORT
                    }
                    style={styles.composerAdapterFill}
                  />
                );
                const innerCardContent = (
                  <>
                    {adapter}
                    {/* + 按钮：card 的 absolute child；跟左侧半圆同心 */}
                    {renderPlusBtn}
                    {/* 麦克风键：card 的 absolute child；在发送键左边 */}
                    {renderMicBtn}
                    {/* 发送/停止键（iOS）：card 的 absolute child；跟右侧半圆同心 */}
                    {renderSendBtn}
                  </>
                );
                return (
                  <>
                    {/* composer card 直接渲染——不能用 Reanimated.View wrapper，会干扰内部
                     * FlowDocSlateAdapter 的 autoHeight 测量（中文/换行时 card 不变高、文本叠层
                     * 渲染）。card 上移到键盘上方的过渡靠 kbBottomStyle 在 bottomOverlay 整体
                     * 下移 6pt 实现，card 的 marginBottom: 18 保持静态。 */}
                    {IS_IOS_LIQUID_GLASS ? (
                      /* iOS26 玻璃卡：interactive=false 关掉系统 contentView 单独放大
                       * （否则内容放大、卡片边缘不动，视觉割裂），改由 JS 统一驱动整卡
                       * scale——composerPressAnimStyle 通过 createAnimatedComponent 直接
                       * 打到原生卡片本体（不包 Reanimated.View，不干扰 autoHeight 测量）。 */
                      <AnimatedBouncyGlassCard
                        style={[
                          composerTall
                            ? styles.composerCardTallGlass
                            : styles.composerCardShortGlass,
                          composerPressAnimStyle,
                        ]}
                        cornerRadius={COMPOSER_CARD_RADIUS}
                        interactive={false}
                        onTouchStart={onComposerTouchStart}
                        onTouchEnd={onComposerTouchEnd}
                        onTouchCancel={onComposerTouchCancel}
                      >
                        {innerCardContent}
                      </AnimatedBouncyGlassCard>
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
                        {/* Android：现代兜底卡（半透明 + 细边框、无重阴影，圆角/布局对齐 iOS 玻璃版）。
                            旧 iOS 15-25：保持原款（inputBg 实底 + shadowMenu）。
                            ref 给 Android 附件菜单当锚点（measure 卡片框架，菜单左下对齐）。 */}
                        <View
                          ref={composerCardRef}
                          style={
                            Platform.OS === 'android'
                              ? composerTall
                                ? styles.composerCardTallModern
                                : styles.composerCardShortModern
                              : composerTall
                                ? styles.composerCardTall
                                : styles.composerCardShort
                          }
                          pointerEvents="box-none"
                        >
                          {innerCardContent}
                        </View>
                      </Reanimated.View>
                    )}
                    {/* 模型 / 助手 chips：永远在 card 外的绝对 meta row。键盘弹起时由 kbMetaRowStyle
                     * 平滑淡出（opacity 1→0）+ 关闭 pointerEvents（不可见时不接收 touch）——两者都在
                     * kbMetaRowStyle 里由 kbAnimHeight worklet 驱动，不再依赖 keyboardOpen React state
                     * （避免键盘/菜单开合触发 composer 重渲染 → glass 圆角闪烁）。always-render + 透明度
                     * 避免瞬间 unmount 抖动。 */}
                    {session ? (
                      <Reanimated.View style={[styles.composerMetaRowAbsolute, kbMetaRowStyle]}>
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
    <BlurSelectSheet
      visible={micSourceSheetOpen}
      onClose={() => setMicSourceSheetOpen(false)}
      options={micSourceSheetOptions}
      title="选择麦克风"
      selectedValue={currentMicSource}
      onSelect={handleSelectMicSource}
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
    {session && subagentViewTarget ? (
      <SubagentViewOverlay
        visible={subagentViewVisible}
        session={session}
        parentConversationId={String(conversationId || '')}
        targetSessionId={subagentViewTarget}
        title={subagentViewTitle}
        agentType={subagentViewAgentType}
        deviceId={subagentViewDeviceId}
        cwd={subagentViewCwd}
        onClose={() => setSubagentViewVisible(false)}
        onOpenConversation={openConversationById}
        cardStyles={styles as unknown as Record<string, any>}
        cardColors={colors as unknown as Record<string, any>}
        getToolStatusLabel={getToolStatusLabel}
      />
    ) : null}

    {/* composer「+」附件菜单的全屏透明 backdrop（两平台共用）：
     *  - Android：自绘 popover 的关闭层，点空白关菜单。
     *  - iOS：原生 UIMenu 收起时 outside tap 会穿透到 app 视图层（UIKit pull-down 菜单
     *    对 platter 外的点按不拦 hit-test），这层在菜单打开期间吞掉穿透 touch，防止
     *    mic / 发送键被误触。菜单 platter 在 UIKit 自己的容器层（更高），菜单项点击与
     *    dismiss 手势都不受这层影响（dismiss 由 window 级手势触发，与命中目标无关——
     *    修复前 mic 被误触时菜单照样关掉即为证）。iOS 不在 release 里 close：原生菜单
     *    自己关，onCloseMenu 会同步 JS 状态（含延迟放开 backdrop）。 */}
    <Reanimated.View
      style={[StyleSheet.absoluteFill, styles.convMenuBackdrop, composerAttachBackdropAnimStyle]}
      pointerEvents={attachBackdropActive ? 'auto' : 'none'}
    >
      {/* 可靠吞掉 outside tap：pointerEvents 走 React state 而非 Reanimated
       * （shared-value 驱动的 pointerEvents 在 Android 上不稳定，会穿透到底层按钮）。
       * 内层 View 用显式 responder + backgroundColor 确保触摸被捕获（完全透明的 View
       * 在 Android 上不接收 touches）。 */}
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.001)' }]}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderRelease={IS_ANDROID ? closeComposerAttachMenu : undefined}
      />
    </Reanimated.View>
    {/* Android：composer「+」附件菜单 popover（iOS 走 MenuView native）。设计跟 ⋯ 菜单 /
     *  TodayScreen FAB 菜单同款：常驻 mount + SharedValue 驱动 opacity/scale/pointerEvents，
     *  卡片 transformOrigin: left bottom 在 composer 卡片原位左下对齐长出来，composer 整卡
     *  同步淡出微缩"变成菜单"（composerPressAnimStyle）。 */}
    {Platform.OS === 'android' ? (
      <>
        <Reanimated.View
          onLayout={(e) => {
            composerAttachMenuHeightRef.current = e.nativeEvent.layout.height;
          }}
          style={[styles.composerAttachMenuCard, composerAttachCardAnimStyle]}
        >
          <TouchableOpacity
            style={styles.convMenuItem}
            activeOpacity={0.6}
            onPress={() => {
              closeComposerAttachMenu();
              onComposerAttachAction('flowdoc');
            }}
          >
            <Ionicons name="document-text-outline" size={20} color={colors.textPrimary} />
            <Text style={styles.convMenuItemText}>引用 FlowDoc 文档</Text>
          </TouchableOpacity>
          <View style={styles.convMenuDivider} />
          {/* 发送文件三子项（组内无分隔线）。Android 自绘 popover 按渲染顺序自上而下，无 UIMenu 翻转。 */}
          <TouchableOpacity
            style={styles.convMenuItem}
            activeOpacity={0.6}
            onPress={() => {
              closeComposerAttachMenu();
              onComposerAttachAction('photo-pick');
            }}
          >
            <Ionicons name="images-outline" size={20} color={colors.textPrimary} />
            <Text style={styles.convMenuItemText}>从相册选择</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.convMenuItem}
            activeOpacity={0.6}
            onPress={() => {
              closeComposerAttachMenu();
              onComposerAttachAction('camera');
            }}
          >
            <Ionicons name="camera-outline" size={20} color={colors.textPrimary} />
            <Text style={styles.convMenuItemText}>拍照</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.convMenuItem}
            activeOpacity={0.6}
            onPress={() => {
              closeComposerAttachMenu();
              onComposerAttachAction('file-pick');
            }}
          >
            <Ionicons name="share-outline" size={20} color={colors.textPrimary} />
            <Text style={styles.convMenuItemText}>从文件选择</Text>
          </TouchableOpacity>
        </Reanimated.View>
      </>
    ) : null}

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
          {/* 同上/同 TodayScreen：显式 responder 吞掉 outside tap，防穿透误触底层按钮。 */}
          <View
            style={StyleSheet.absoluteFill}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderRelease={closeConvMenu}
          />
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
          <View style={styles.convMenuSectionDivider} />
          {/* 语音合成：带 Switch 的行（不关菜单，方便看开关翻转 / 连续操作） */}
          <View style={styles.convMenuItem}>
            <Ionicons name="volume-high-outline" size={20} color={colors.textPrimary} />
            <Text style={[styles.convMenuItemText, styles.convMenuItemTextGrow]}>语音合成</Text>
            <IOSStyleSwitch value={ttsAutoplay} onValueChange={persistTtsAutoplay} />
          </View>
          <View style={styles.convMenuDivider} />
          {/* 开启播报模式：纯选项行 → 弹确认 Alert */}
          <TouchableOpacity
            style={styles.convMenuItem}
            activeOpacity={0.6}
            onPress={() => {
              closeConvMenu();
              handleEnableBroadcast();
            }}
          >
            <Ionicons name="radio-outline" size={20} color={colors.textPrimary} />
            <Text style={styles.convMenuItemText}>开启播报模式</Text>
          </TouchableOpacity>
        </Reanimated.View>
      </>
    ) : null}
    </>
  );
}

