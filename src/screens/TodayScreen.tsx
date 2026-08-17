/**
 * TodayScreen —— 抽屉里「今天」条目对应的顶层页。
 *
 * 整体一个滚动容器，自上而下：
 *  1. 顶部 header：左 = 汉堡按钮（开抽屉）、中 = 今日日期/任务数、右 = 跨项目日历按钮
 *  2. 「今日 tasks」段头 + filter 按钮（右）+ 任务列表（拖拽排序，沿用 TasksHomeScreen 的状态/AsyncStorage key）
 *  3. 「对话」段头 + 历史对话列表（沿用 ConversationListScreen 的拉取、SSE running/unread 指示、长按删除）
 *  4. 底部 sticky 搜索框（UI 占位，后续接搜索 API）
 *
 * 注意：
 *  - 旧 TasksHomeScreen 内的「左缘右滑开 ProjectList」手势 + 「项目入口圆钮」**移除**，由抽屉接管。
 *  - 旧 TasksHomeScreen 内底部的 calendar/end-today/FAB 行 **移除**：日历搬到顶部、新建任务走抽屉底栏的 + 按钮。
 *    （结束今天按钮仍保留在 task 段尾作为一个 inline 按钮，避免破坏现有"今日结束"功能。）
 *  - DraggableFlatList 作为外层滚动容器；conv 段渲染在 ListFooterComponent 里。
 *  - 项目名仍然显示（沿用 showProjectName 偏好）。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  Vibration,
  View,
} from 'react-native';
import {
  KeyboardAvoidingView,
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import DraggableFlatList from 'react-native-draggable-flatlist';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnUI,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { useTask } from '../context/TaskContext';
import { PRESS_SPRING_CONFIG } from '../constants/animation';
import { useSession } from '../context/SessionContext';
import {
  createConversation,
  deleteConversation,
  type ConversationListItem,
} from '../api';
import {
  useConversations,
  useConversationPaging,
  useRunningConvMap,
  useBgTaskRunningConvMap,
  useUnreadConvMap,
  useConversationsStatus,
  useConversationActions,
  useRowTapGuard,
} from '../context/ConversationContext';
import type { RootStackParamList } from '../navigation/types';
import type { TaskItem, Project } from '../taskApi';
import { TaskRow } from '../components/TaskRow';
import { TaskFilterSheet, type StatusLevel } from '../components/TaskFilterSheet';
import { ProjectSelectSheet } from '../components/ProjectSelectSheet';
import {
  CreateTaskRegionSheet,
  type CreateRegionChoice,
} from '../components/CreateTaskRegionSheet';
import {
  displayTitleForDumpParent,
  listUnorderedDumpParentsForProject,
} from '../utils/taskChoreRegion';
import { filterTasksByStatusLevel } from '../utils/taskFilters';
import { BlurHeaderBackground, BlurFooterBackground } from '../components/BlurHeaderBackground';
import { PullToRefreshRing } from '../components/PullToRefreshRing';
import { InboxRunSpinner, InboxUnreadCheck } from '../components/InboxListIndicators';
import { ConversationRow } from '../components/ConversationRow';
import { ConversationListSkeleton, TodayContentSkeleton } from '../components/Skeleton';
import { HamburgerButton } from './shell/HamburgerButton';
import {
  AnimatedCircleButton,
  IS_IOS_LIQUID_GLASS,
  type AnimatedCircleButtonMenuAction,
} from '../components/AnimatedCircleButton';
import { MenuView } from '@react-native-menu/menu';
import { Fab, FAB_SIZE } from '../components/Fab';
import { BouncyGlassCard } from '../components/BouncyGlassCard';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { shadowCircleButtonThemed, shadowMenu, shadowSoft } from '../theme/shadows';
import {
  HEADER_CIRCLE_BTN_SIZE,
  HEADER_CIRCLE_IONICON_SIZE,
  HEADER_CIRCLE_SF_ICON_SIZE,
  COMPOSER_PILL_SIZE,
  COMPOSER_CARD_RADIUS,
  LIST_PADDING_BOTTOM_WITH_FOOTER,
  bottomInsetTotal,
} from '../theme/layout';
import { isSquareScreen, getScreenCornerRadiusSync, getBottomInsetSync } from '../utils/screenInfo';
import {
  TASK_FONT_SIZE_SMALL,
  TASK_FONT_SIZE_TITLE,
  TASK_FONT_SIZE_BODY,
} from '../theme/typography';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const PULL_RING_THRESHOLD = 120;
const MIN_REFRESH_DURATION_MS = 1000;
const STATUS_KEY = 'statusLevel_todayTasks';
const SHOW_TIME_KEY = 'showTimeLabels_todayTasks';
const SHOW_PROJECT_KEY = 'showProjectName_todayTasks';

function formatTodayDate(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const min = d.getMinutes();
  return `${m}月${day}日 ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return isoString;
  }
}

/** 渲染条目类型：DraggableFlatList 主区只渲染 task；conv 在 footer 里. */
type ListRow = TaskItem;

export function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  /* 底部 inset：safe-area-context 首帧上报 0（安卓 edge-to-edge 已知），会让底部避让"先贴底后上移"。
   * 安卓用 native 同步值兜首帧（render 时窗口已就绪，可靠）；keyed on insets.bottom 重读以跟随导航
   * 模式切换 / 转屏。iOS getBottomInsetSync 返回 null → 用 safe-area（配 initialWindowMetrics）。
   * 下面所有底部间距 / SafeAreaView 下 padding 都用它，而不是直接用 insets.bottom。 */
  const bottomInset = useMemo(() => {
    const sync = getBottomInsetSync();
    return Math.max(sync ?? 0, insets.bottom);
  }, [insets.bottom]);
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useSession();
  const {
    todayTasks,
    todayDate,
    tasks,
    projects,
    isLoadingTasks,
    tasksEverLoaded,
    errorMessage,
    loadTasks,
    loadProjects,
    toggleTaskCompletion,
    shouldShowEndTodayButton,
    endToday,
    clearError,
    isAheadOfToday,
    cancelAheadOfToday,
  } = useTask();

  /* ---------- task 段：filter / 拖拽顺序 ---------- */
  const [filterVisible, setFilterVisible] = useState(false);
  const [statusLevel, setStatusLevel] = useState<StatusLevel>(3);
  const [showTimeLabels, setShowTimeLabels] = useState(false);
  const [showProjectName, setShowProjectName] = useState(true);

  const filteredTodayTasks = useMemo(
    () => filterTasksByStatusLevel(todayTasks, statusLevel),
    [todayTasks, statusLevel]
  );

  const [localTaskOrder, setLocalTaskOrder] = useState<TaskItem[]>(filteredTodayTasks);
  useEffect(() => {
    setLocalTaskOrder(filteredTodayTasks);
  }, [filteredTodayTasks]);

  useEffect(() => {
    (async () => {
      try {
        const [s, t, p] = await Promise.all([
          AsyncStorage.getItem(STATUS_KEY),
          AsyncStorage.getItem(SHOW_TIME_KEY),
          AsyncStorage.getItem(SHOW_PROJECT_KEY),
        ]);
        if (s != null) {
          const v = parseInt(s, 10);
          if (v >= 0 && v <= 3) setStatusLevel(v as StatusLevel);
        }
        if (t != null) setShowTimeLabels(t === 'true');
        if (p != null) setShowProjectName(p === 'true');
      } catch {
        /* ignore */
      }
    })();
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(STATUS_KEY, String(statusLevel));
  }, [statusLevel]);
  useEffect(() => {
    AsyncStorage.setItem(SHOW_TIME_KEY, String(showTimeLabels));
  }, [showTimeLabels]);
  useEffect(() => {
    AsyncStorage.setItem(SHOW_PROJECT_KEY, String(showProjectName));
  }, [showProjectName]);

  /* ---------- 对话段（数据源为全局 ConversationContext）---------- */
  const convList = useConversations();
  const chatV2RunningByConv = useRunningConvMap();
  /** agent 没跑但后台任务在跑的会话（只有 inbox SSE 有这份，列表接口没这个字段） */
  const bgTaskRunningByConv = useBgTaskRunningConvMap();
  const chatV2UnreadByConv = useUnreadConvMap();
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  /** pending = 首次列表请求还没跑完（含还没起步）。不能只看 loading——它初始是 false，
   *  首帧会先闪一下「暂无历史对话」空态再进骨架。 */
  const { pending: convPending } = useConversationsStatus();
  const { refreshConversations, removeConversationOptimistic } = useConversationActions();
  /** 服务端分页：convList 只有已加载的那几页，滚到底再从服务端补（增量追加，见 ConversationContext）。 */
  const { hasMore: serverHasMoreConvs, loadMore: loadMoreConvsFromServer } = useConversationPaging();
  /** 客户端分页：footer 只渲染前 convVisibleCount 条对话，滚到底每次 +CONV_PAGE_SIZE。
   *  根因——之前 convList 全量 .map() 渲染在 footer（零虚拟化），几百条对话一次性 mount → 卡。
   *  纯客户端切片：滚动位置不跳变（footer 尾部追加内容，已有项偏移不变，自然向下延伸）。iOS/Android 同生效。
   *  两层分页并存：客户端切片管「渲染多少」（瞬时），服务端分页管「手上有多少」（走网络）。
   *  客户端页(10) < 服务端页(20)，所以多数上滑只是切片，两次才摸一次网络。 */
  const CONV_PAGE_SIZE = 10;
  const [convVisibleCount, setConvVisibleCount] = useState(CONV_PAGE_SIZE);
  const [deleteConvTarget, setDeleteConvTarget] = useState<ConversationListItem | null>(null);

  /* ---------- 键盘避让（react-native-keyboard-controller frame-perfect 路径）----------
   *  上方 import 的 KAV 是 lib 版（drop-in for RN KAV，API 一致，但 native frame timing：
   *  iOS UIKeyboardLayoutGuide / Android WindowInsetsCompat.Type.ime）。kavInner 缩小、kb 上
   *  下抬升 list 视图区，全程跟键盘逐帧 sync，不再走 React render cycle，搜索框跟键盘同步无卡顿。
   *
   *  useReanimatedKeyboardAnimation: 返回 keyboard frame 的 SharedValue。height **负数**
   *  offset 语义，-300 表示键盘 300pt 高。我们只用来在 searchWrap 两套 tuning（no-kb vs
   *  kb-up）之间 interpolate 平滑过渡；主体几何位移由 KAV 缩 kavInner 处理（双重 driven 会
   *  overshoot）。 */
  const { height: kbAnimHeight } = useReanimatedKeyboardAnimation();
  /* searchWrap 两态 tuning（动画 0→30pt h 区间内 interpolate）：
   *  - no-kb: bottom:-8 paddingBottom:2，搜索框略侵入 home indicator 区。
   *  - kb-up: bottom:0 paddingBottom:12，row 距键盘顶 12pt。
   *  几何上 kbHeight 量级的整体上抬由 KAV 缩 kavInner 自动出。 */
  /* searchWrap resting 态距屏底间距：SafeAreaView 的下 padding 已是 bottomInset（见下），这里只补
   *  「目标总间距 - 已 pad 的部分」。bottomInsetTotal = max(inset, 下限)：有导航条/安全区的设备
   *  extra=0（直接紧贴 inset，nav bar/单键条/home indicator 内部自带留白）；只有完全没有导航条
   *  （inset≈0：安卓全面屏手势、iOS home 键/方形屏）才兜出下限，extra>0 避免搜索栏贴死屏底。 */
  const searchWrapExtraBottom = bottomInsetTotal(bottomInset) - bottomInset;
  const kbSearchWrapStyle = useAnimatedStyle(() => {
    const h = -kbAnimHeight.value;
    /* 无键盘 resting bottom = searchWrapExtraBottom：让 searchWrap 停在 kavInner.bottom（=
     *  SafeAreaView content 底部）上方（无底部栏机型靠 extra 兜出间距）。原 -8 让它沉进 safe
     *  area 区域，视觉上过于贴底。键盘弹起时 bottom→0、paddingBottom 12 让 row 离 kb 12pt
     *  （kavInner 由 lib KAV 缩到 kb 顶，searchWrap 跟 kavInner 底走；此时导航栏被键盘盖住，
     *  extra 也插值归零避免偏高）。 */
    return {
      bottom: interpolate(h, [0, 30], [searchWrapExtraBottom, 0], 'clamp'),
      paddingBottom: interpolate(h, [0, 30], [2, 12], 'clamp'),
    };
  });
  /* paddingHorizontal 单独一个 animated style，下面声明（要等 focusedProgress 出现）。 */
  /* bottomFade 几何由 KAV 缩同步带动，静态 bottom -38 即可。 */
  const FADE_BOTTOM_BELOW_KAV = 38;
  const FADE_TOP_ABOVE_KAV = 68;
  const FADE_SOLID_HEIGHT = Math.max(bottomInset, 8);
  const kbBottomFadeStyle = useAnimatedStyle(() => {
    return { bottom: -FADE_BOTTOM_BELOW_KAV };
  });

  /* ---------- 刷新 ---------- */
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullDistanceShared = useSharedValue(0);
  const refreshingShared = useSharedValue(false);

  useEffect(() => {
    refreshingShared.value = refreshing;
  }, [refreshing, refreshingShared]);

  useEffect(
    () => () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    },
    []
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (Platform.OS === 'android') {
      Vibration.vibrate(15);
    } else {
      ReactNativeHapticFeedback.trigger('impactHeavy', { enableVibrateFallback: true });
    }
    clearError();
    const startedAt = Date.now();
    try {
      // 下拉刷新：可见数回到首页大小，服务端窗口也重置回第一页（reset）。
      // 只有这里 reset —— 静默刷新（SSE / 回前台 catchup）要保持已加载窗口，否则滚了几页会缩回去。
      setConvVisibleCount(CONV_PAGE_SIZE);
      await Promise.all([loadTasks(true), loadProjects(true), refreshConversations({ reset: true })]);
    } finally {
      const elapsed = Date.now() - startedAt;
      const remain = MIN_REFRESH_DURATION_MS - elapsed;
      if (remain > 0) {
        refreshTimeoutRef.current = setTimeout(() => {
          refreshTimeoutRef.current = null;
          setRefreshing(false);
        }, remain);
      } else {
        setRefreshing(false);
      }
    }
  }, [clearError, loadTasks, loadProjects, refreshConversations]);

  /** session 切换 / 挂载首拉 */
  useEffect(() => {
    if (session) {
      loadTasks(true);
      loadProjects(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const updatePullDistance = runOnUI((pull: number) => {
    'worklet';
    pullDistanceShared.value = pull;
  });

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      if (Platform.OS !== 'ios') return;
      const y = e.nativeEvent.contentOffset.y;
      const pull = y <= 0 ? Math.min(-y, 120) : 0;
      updatePullDistance(pull);
    },
    [updatePullDistance]
  );

  /* 行点击守卫（全局 context，恒定引用）：菜单开合上报 + 实时抑制判定。
   *  为什么要它、为什么必须实时读 ref：iOS 原生 UIMenu 在 RN 视图树之外，dismiss 那一下 touch 会
   *  穿透回底层行；JS backdrop 拦不住原生 UIMenu，且 ref 变更不触发 re-render，UIMenu 开→关→穿透
   *  全程无渲染，render 时求值的 suppress 是滞后快照 → 高亮闪一下。ConversationRow 现在在 Pressable
   *  的 style callback / onPress 里**实时**调 isRowTapSuppressed() 自守，行点击的抑制不再走这里；
   *  这里只负责：菜单开合上报（setMenuOpen）+ 任务行（TaskRow 无自守）的导航抑制。 */
  const { setMenuOpen, isRowTapSuppressed } = useRowTapGuard();

  /* ---------- 跳转 ---------- */
  const onTaskPress = useCallback(
    (task: TaskItem) => {
      if (isRowTapSuppressed()) return;
      navigation.navigate('TaskDetail', { taskId: task.id });
    },
    [navigation, isRowTapSuppressed]
  );

  /** 对话行点击：作为二级页 push 出来，返回箭头回到今日页（与抽屉 Recents 的「顶层切换」区分开）。
   *  抑制守卫由 ConversationRow 内部实时自守，这里不再重复判断。 */
  const onConvPress = useCallback(
    (conv: ConversationListItem) => {
      navigation.navigate('Chat', {
        conversationId: conv.id,
        conversationTitle: (conv.title && conv.title.trim()) || '新对话',
      });
    },
    [navigation]
  );

  const onCalendarPress = useCallback(
    () => navigation.navigate('TasksCalendar'),
    [navigation]
  );

  /* ---------- 新建任务（沿用旧 TasksHomeScreen 流程） ---------- */
  const [showProjectSelect, setShowProjectSelect] = useState(false);
  const [showCreateRegionSheet, setShowCreateRegionSheet] = useState(false);
  const [pendingCreateProject, setPendingCreateProject] = useState<Project | null>(null);
  const [createRegionDumpOptions, setCreateRegionDumpOptions] = useState<
    { id: string; title: string }[]
  >([]);

  const onCreateTask = useCallback(() => {
    if (projects.length === 0) return;
    setShowProjectSelect(true);
  }, [projects.length]);

  /** 新对话：建一条空 conversation 然后进 Chat 页（不挂项目/folder） */
  const onCreateChat = useCallback(async () => {
    if (!session) return;
    try {
      // 新对话始终加密（与全局抽屉一致）。即时创建后按 id 进页，ChatScreen 的
      // getConversation 会用本机 K_user 从 k_conv_blob 派生并缓存 K_conv。
      const { id } = await createConversation(session, { encrypted: true });
      navigation.navigate('Chat', { conversationId: id, conversationTitle: '新对话' });
      refreshConversations();
    } catch (e) {
      Alert.alert('新建对话失败', e instanceof Error ? e.message : String(e));
    }
  }, [session, navigation, refreshConversations]);

  /* ---------- 右下 FAB 菜单 ---------- */
  /* "新建对话 / 新建任务" 两选项菜单。iOS 26 走 UIButton 原生 UIMenu（AnimatedCircleButton
   *  menuActions 透传给底层 BouncyButton），native 那侧的 onMenuWillShow / onMenuDidDismiss
   *  把 fabMenuOpen 跟原生菜单状态同步。其它平台（iOS<26 / Android）按 FAB 后 setFabMenuOpen
   *  → 自绘 Modal popover，与 ChatScreen Android ⋯ 菜单同款实现。
   *
   *  动画同步：搜索框收缩动画**不**走 fabMenuOpen state → useEffect → withTiming 那条链
   *  （那串走 React render cycle，会比 menu 系统动画明显慢几帧）。直接在 open/close 同款
   *  callback 里**同步**推 shared value，touchDown emit 进 JS 后 worklet 立即接管，跟
   *  iOS UIMenu 弹出动画基本零延迟齐播。 */
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const searchCollapsed = useSharedValue(0);
  /* fabMenuJustClosedAtRef：记录 menu 最近一次 close 的时间戳。给搜索胶囊 onPress focus
   * 用——用户点搜索关 menu 那一下，swizzle 在 touchBegan 同帧 close，但 BouncyGlassCard
   * 自己的 tap recognizer 在 touchEnd 才 fire（onPress 回调）；那时 fabMenuOpen 已 false，
   * 单看当前状态判断会误把这次 dismiss tap 当 focus 意图。500ms 窗口内 skip focus 即可。 */
  const fabMenuJustClosedAtRef = useRef<number>(0);
  /* fabMenuShow：UI 线程 SharedValue 驱动 menu 可见性（opacity + scale + pointerEvents)。
   * 跟 React state fabMenuOpen 并行 —— state 用于 React 侧逻辑联动（searchInput editable
   * 等），SharedValue 用于动画 / 可见性切换。这样 menu 常驻 mount、不依赖 React re-render
   * → 开菜单立即响应（worklet 一帧切 opacity），不再有 conditional mount 的 ~100ms 延迟。
   *
   * 关键时序：fabMenuShow.value 必须**先**设，再 setFabMenuOpen —— 前者立即触发 UI 线程
   * worklet 动画（独立 thread），后者 schedule React re-render（主线程，会阻塞几十 ms)。
   * 顺序反过来 worklet 会跟 setState 引发的 re-render 抢主线程时间片，感觉"等待 state"。
   * duration 80ms 是 menu 进入感觉"瞬间"的上限，用户感受不到延迟。 */
  const fabMenuShow = useSharedValue(0);
  const openFabMenu = useCallback(() => {
    setMenuOpen(true);
    fabMenuShow.value = withTiming(1, { duration: 80 });
    searchCollapsed.value = withTiming(1, { duration: 220 });
    setFabMenuOpen(true);
  }, [searchCollapsed, fabMenuShow, setMenuOpen]);
  const closeFabMenu = useCallback(() => {
    setMenuOpen(false);
    fabMenuJustClosedAtRef.current = Date.now();
    fabMenuShow.value = withTiming(0, { duration: 100 });
    searchCollapsed.value = withTiming(0, { duration: 220 });
    setFabMenuOpen(false);
  }, [searchCollapsed, fabMenuShow, setMenuOpen]);

  const fabMenuActions = useMemo<ReadonlyArray<AnimatedCircleButtonMenuAction>>(
    () => [
      { id: 'newChat', title: '新建对话' },
      { id: 'newTask', title: '新建任务' },
    ],
    []
  );

  const onFabMenuPick = useCallback(
    (id: string) => {
      if (id === 'newChat') onCreateChat();
      else if (id === 'newTask') onCreateTask();
    },
    [onCreateChat, onCreateTask]
  );

  /* 计算 search 长条态目标宽度。focused 态把 searchWrap 两侧 padding 从 26 收到 12（左右各
   *  挤掉 14pt），搜索框宽度跟着补回 28pt。 */
  const { width: windowWidth } = useWindowDimensions();
  /** 本屏容器实际宽度（onLayout 实测）。手机/iPhone = 全屏宽；iPad 侧栏模式下 TodayScreen 处在
   *  主区 pane 里 = 全屏宽−侧栏。底部搜索框宽度按它算（而非 windowWidth），否则在主区里会按全屏宽
   *  算、右侧戳出 pane。未量到时（首帧）回退 windowWidth。 */
  const [containerWidth, setContainerWidth] = useState(0);
  const layoutWidth = containerWidth > 0 ? containerWidth : windowWidth;
  const SEARCH_WRAP_PADDING_H = 26;
  /** 方角屏 resting padding：对齐顶部圆钮（topBar paddingHorizontal = 16），不再做全宽 12。 */
  const SEARCH_WRAP_PADDING_H_SQUARE = 16;
  const SEARCH_WRAP_PADDING_H_FOCUSED = 12;
  const SEARCH_ROW_GAP = 10;
  /* 直角屏（屏幕物理圆角≈0：iPhone SE / 8 等矩形屏）：resting padding 用 16，跟顶部圆钮两边距对齐
   * （圆角屏 resting 是 26、比顶部更内缩）。两种屏聚焦/键盘弹出都收到 12 widen，动画保留。
   * 判据走屏幕圆角（跟 DrawerShell 同一套 inferScreenCornerRadius），而非长宽比 / 底部安全区。
   * 注：Android 这里走 inference 的保守默认（非 0）→ 当作圆角屏；真有直角 Android 需另接 native 实测值。 */
  /* Android 屏幕物理圆角（API 31+ native 同步实测；iOS / 旧 build 未重编为 null → isSquareScreen
   * 走 topInset 推断）。同步取 → 首帧 render 就拿到正确值，不再"先窄后宽"闪。值设备固定、wrapper 内已缓存。 */
  const squareScreen = isSquareScreen(insets.top, getScreenCornerRadiusSync());
  const searchRestingPaddingH = squareScreen
    ? SEARCH_WRAP_PADDING_H_SQUARE
    : SEARCH_WRAP_PADDING_H;
  const searchExpandedWidth = Math.max(
    FAB_SIZE,
    layoutWidth - searchRestingPaddingH * 2 - SEARCH_ROW_GAP - FAB_SIZE
  );
  const searchExpandedWidthFocused = Math.max(
    FAB_SIZE,
    layoutWidth - SEARCH_WRAP_PADDING_H_FOCUSED * 2 - SEARCH_ROW_GAP - FAB_SIZE
  );

  /* 整个搜索胶囊（不止 TextInput 那一块）点哪都能进输入态。BouncyGlassCard / 非 glass 路径
   *  外层 wrapper 都接 onSearchPress。menu close 后 500ms 内的 tap 跳过 focus——那很可能
   *  就是关 menu 那一下（swizzle touchBegan dismiss + recognizer touchEnd onPress 是同一次
   *  tap 的两端）。 */
  const searchInputRef = useRef<TextInput>(null);
  /* focusedProgress：scale + pointerEvents 双驱动量，跟键盘 frame 逐帧同步。UI 线程 worklet,
   * 完全不走 React render。Fab 的视觉切换与 hit-test 路由都在 animated style 里读取这条
   * SharedValue（详见 fabPlus/CloseAnimStyle 定义）—— 跟键盘升起严格同帧，无 React state 延迟。 */
  const focusedProgress = useSharedValue(0);
  useKeyboardHandler({
    onMove: (e) => {
      'worklet';
      focusedProgress.value = e.progress;
    },
  }, [focusedProgress]);
  /* 用 scale 而不是 opacity 切换两个 Fab —— iOS UIGlassEffect 在子树 opacity:0 mount 时
   * 实测背景没正常初始化 (close 圆不出来)。两个 Fab 永远 opacity:1，glass 材质从 mount
   * 第一帧就完整渲染；通过 scale 0↔1 控制可见性（CALayer compose 顺序：contents → bounds
   * → transform，glass 在 scale 之前已完整光栅化，transform 只是把整层缩放到 0 也无副作用）。 */
  /* scale: 视觉切换；pointerEvents: hit-test 路由——两者都吃 focusedProgress（键盘 progress)。
   * Android 必需把 pointerEvents 也走 UI 线程：Yoga 用 layout bounds 做 hit-test，scale=0 的
   * 隐形 View 仍能截到 tap；React state 驱动的 pointerEvents 在 IME 弹起期间 render 延迟,
   * tap 落点会跑到老状态的 pe=auto plus → 误触 openFabMenu。这里用 animated style 让
   * pointerEvents 跟 scale 逐帧同步。iOS hit-test 已经用 transform 后 bounds，scale=0 即无
   * 命中区域，pointerEvents 切换是冗余但无害。 */
  const fabPlusAnimStyle = useAnimatedStyle(() => ({
    /* fabMenuShow > 0 时把 + FAB 略缩到 0.8 + 淡出到 0，视觉上"被菜单吸收"。菜单卡片
     * 从 bottom-right 长出来时正好覆盖 FAB 原位，过渡上 FAB 顺着 scale 1→0.8 退场,
     * 看不到 FAB 露在菜单外。 */
    transform: [{ scale: (1 - focusedProgress.value) * (1 - fabMenuShow.value * 0.2) }],
    opacity: 1 - fabMenuShow.value,
    pointerEvents:
      focusedProgress.value > 0.5 || fabMenuShow.value > 0.1 ? 'none' : 'auto',
  }));
  const fabCloseAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: focusedProgress.value }],
    pointerEvents: focusedProgress.value > 0.5 ? 'auto' : 'none',
  }));
  /* searchWrap 左右 padding：focused 时由 26 收到 12（每边各让出 14pt 给搜索框扩宽）。
   * 单独一个 animated style 而不是合进 kbSearchWrapStyle —— 因为 focusedProgress 必须在
   * useKeyboardHandler 之后才声明，跟早期声明的 kbSearchWrapStyle 时序对不上。 */
  const searchWrapPaddingStyle = useAnimatedStyle(() => ({
    paddingHorizontal: interpolate(
      focusedProgress.value,
      [0, 1],
      [searchRestingPaddingH, SEARCH_WRAP_PADDING_H_FOCUSED]
    ),
  }));
  const onSearchPress = useCallback(() => {
    if (Date.now() - fabMenuJustClosedAtRef.current < 500) return;
    searchInputRef.current?.focus();
  }, []);
  /* Android 搜索框胶囊按下放大 —— RNGH 路径，跟 AnimatedCircleButton AndroidWorkletBouncy
   * 同款。worklet 在 UI 线程直接驱动 scale，不走 JS bridge / React render scheduling，
   * 快速 tap 时 spring 不会被立刻取消。胶囊宽 ~280pt，倍率 1.15 比圆钮 1.5 保守（再大
   * 会越过 row 把 FAB 挤掉）。iOS 走 BouncyGlassCard 系统 interactive，不在这里管。 */
  const searchBoxPressScale = useSharedValue(1);
  const searchBoxPressAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: searchBoxPressScale.value }],
  }));
  /* fabMenu 可见性：opacity 0→1 + scale 0.1→1.0；transformOrigin 锚在 bottom-right
   * (= FAB 位置)，所以菜单从 FAB 角"向左向上长出来"，不是 uniform 从中心放大。
   * pointerEvents 在 show > 0.5 时切到 'auto'，避免 fade-in 早段被误触。 */
  const fabMenuCardAnimStyle = useAnimatedStyle(() => ({
    opacity: fabMenuShow.value,
    transform: [{ scale: 0.1 + fabMenuShow.value * 0.9 }],
    transformOrigin: 'right bottom',
    pointerEvents: fabMenuShow.value > 0.5 ? 'auto' : 'none',
  }));
  const fabMenuBackdropAnimStyle = useAnimatedStyle(() => ({
    pointerEvents: fabMenuShow.value > 0.5 ? 'auto' : 'none',
  }));
  /* 搜索框胶囊按下放大用 RN raw onTouchStart/End/Cancel 而不是 RNGH gesture：
   * Gesture.Manual + 不 activate 在 EditText activate 它自己的 native gesture 后会被
   * cancel → spring 提前 down，按住保持不住放大状态。
   * RN onTouch* 是 raw touch event，独立于 responder system 跟 native gesture
   * ownership，child EditText cursor placement / 选词 不被影响，外层 view 仍能 raw
   * 接到 touch event 驱动 spring。 */
  const onSearchBoxTouchStart = useCallback(() => {
    searchBoxPressScale.value = withSpring(1.1, PRESS_SPRING_CONFIG);
  }, [searchBoxPressScale]);
  const onSearchBoxTouchEnd = useCallback(() => {
    searchBoxPressScale.value = withSpring(1, { mass: 1, stiffness: 220, damping: 14 });
    /* imperative focus 是 safe no-op if already focused（native tap 已 focus）;
     * 点搜索 icon 区域不在 EditText 上、native 不 focus 时由这步兜底。 */
    onSearchPress();
  }, [searchBoxPressScale, onSearchPress]);
  const onSearchBoxTouchCancel = useCallback(() => {
    searchBoxPressScale.value = withSpring(1, { mass: 1, stiffness: 220, damping: 14 });
  }, [searchBoxPressScale]);
  /* close Fab 的 onPress 必须 useCallback 稳定引用 —— Android 路径的 AnimatedCircleButton
   * 用 RNGH `Gesture.Tap()` 包在 useMemo 里，依赖列表包含 onPress；inline 箭头函数每次 parent
   * re-render 都是新引用 → useMemo 失效 → Gesture.Tap 实例重建 → RNGH 内部状态被重置,
   * 正在跟踪的 tap 被取消。键盘动画期间 setSearchFocused 触发多次 re-render，tap 反复被
   * 重置导致用户感觉"点了之后过一会儿才有效"。iOS 路径走 BouncyButtonNative 不受影响。 */
  const onCloseFabPress = useCallback(() => {
    searchInputRef.current?.blur();
    Keyboard.dismiss();
  }, []);

  const searchBoxAnimatedStyle = useAnimatedStyle(() => {
    const c = searchCollapsed.value;
    const fp = focusedProgress.value;
    /* 长条态宽度跟 focusedProgress 联动：focused 时 searchWrap padding 缩了 28pt，搜索框
     * 补回这 28pt。collapsed (menu open) 态还是 52pt 圆。 */
    const expandedNow = interpolate(fp, [0, 1], [searchExpandedWidth, searchExpandedWidthFocused]);
    return {
      width: interpolate(c, [0, 1], [expandedNow, FAB_SIZE]),
    };
  });
  const searchContentAnimatedStyle = useAnimatedStyle(() => {
    /* 圆形态只保留 icon —— TextInput + placeholder 用 opacity 0..1 衰减；圆收完时直接 0
     *  避免文字渗出。0.5 前快速 fade out，避免文字跟着压缩看着奇怪。
     *  marginLeft 同步 8→0：圆态下抹掉 icon 与 wrapper 之间的间距（之前用 row gap:8，但
     *  flex gap 即使 wrapper 0 宽也会算占位，导致 paddingH 14×2 + icon 18 + gap 8 = 54 >
     *  52pt，icon 右边会被裁 2pt）。把 gap 挪进 wrapper 自己的 marginLeft 让它动到 0 解决。 */
    const c = searchCollapsed.value;
    return {
      opacity: interpolate(c, [0, 0.5], [1, 0], 'clamp'),
      marginLeft: interpolate(c, [0, 1], [8, 0]),
    };
  });

  const onSelectProjectForCreate = useCallback(
    (project: Project) => {
      setShowProjectSelect(false);
      const dumpParents = listUnorderedDumpParentsForProject(tasks, project.id);
      if (dumpParents.length === 0) {
        navigation.navigate('TaskDetail', {
          projectId: project.id,
          projectName: project.name ?? project.id,
          createPlacement: 'unorganized',
        });
        return;
      }
      setPendingCreateProject(project);
      setCreateRegionDumpOptions(
        dumpParents.map((t) => ({ id: t.id, title: displayTitleForDumpParent(t) }))
      );
      setShowCreateRegionSheet(true);
    },
    [navigation, tasks]
  );

  const onCloseCreateRegionSheet = useCallback(() => {
    setShowCreateRegionSheet(false);
    setPendingCreateProject(null);
    setCreateRegionDumpOptions([]);
  }, []);

  const onSelectCreateRegion = useCallback(
    (choice: CreateRegionChoice) => {
      const project = pendingCreateProject;
      if (!project) {
        onCloseCreateRegionSheet();
        return;
      }
      onCloseCreateRegionSheet();
      if (choice.kind === 'unorganized') {
        navigation.navigate('TaskDetail', {
          projectId: project.id,
          projectName: project.name ?? project.id,
          createPlacement: 'unorganized',
        });
        return;
      }
      navigation.navigate('TaskDetail', {
        projectId: project.id,
        projectName: project.name ?? project.id,
        createPlacement: { kind: 'chore_area', parentTaskId: choice.parentTaskId },
      });
    },
    [navigation, pendingCreateProject, onCloseCreateRegionSheet]
  );

  /* ---------- 对话删除 ---------- */
  const closeDeleteConvModal = useCallback(() => setDeleteConvTarget(null), []);
  const confirmDeleteConversation = useCallback(async () => {
    if (!session || !deleteConvTarget) return;
    const conv = deleteConvTarget;
    setDeleteConvTarget(null);
    try {
      await deleteConversation(session, conv.id);
      removeConversationOptimistic(conv.id);
    } catch (e) {
      Alert.alert('删除失败', e instanceof Error ? e.message : '请稍后重试');
    }
  }, [session, deleteConvTarget, removeConversationOptimistic]);

  /* ---------- 渲染 ---------- */
  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.placeholderText}>请先登录</Text>
      </View>
    );
  }

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  /** 内容区该画骨架：手上没任务，且首次加载还没跑完（含还没起步）。
   *  只看 isLoadingTasks 不行——它初始 false，要等本屏 effect 调 loadTasks 才变 true，
   *  中间那一帧会露出「今日无任务」空态。 */
  const taskLoading = todayTasks.length === 0 && (isLoadingTasks || !tasksEverLoaded);
  const showEndToday = shouldShowEndTodayButton();

  /** 列表头：filter 段头 */
  const ListHeader = (
    <View style={styles.taskHeaderWrap}>
      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>
          今日 {filteredTodayTasks.length} 个任务
        </Text>
        <TouchableOpacity
          onPress={() => setFilterVisible(true)}
          activeOpacity={0.7}
        >
          <View style={styles.filterBtn}>
            <Ionicons name="filter-outline" size={20} color={colors.textSecondary} />
          </View>
        </TouchableOpacity>
      </View>
      {errorMessage ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
    </View>
  );

  /** 对话筛选菜单：两项互斥，iOS 走原生 UIMenu / Android 走自绘 popover */
  const convFilterMenuActions = useMemo<ReadonlyArray<AnimatedCircleButtonMenuAction>>(
    () => [
      { id: 'all',    title: '全部对话', image: 'tray.full',          state: (showUnreadOnly ? 'off' : 'on') as 'on' | 'off' },
      { id: 'unread', title: '仅未读',   image: 'circle.badge.fill',  state: (showUnreadOnly ? 'on'  : 'off') as 'on' | 'off' },
    ],
    [showUnreadOnly],
  );
  const onConvFilterSelect = useCallback((id: string) => {
    setShowUnreadOnly(id === 'unread');
  }, []);
  const onConvFilterMenuView = useCallback(
    (e: { nativeEvent: { event: string } }) => onConvFilterSelect(e.nativeEvent.event),
    [onConvFilterSelect],
  );

  /* 筛选按钮：filter 菜单键与"×"清除键**条件渲染**，同一时刻只有一个挂在 DOM 上 —— 彻底
   *  消灭"透明却仍吃点击"的幽灵层，也不再需要小框 + padding hack 那套（会被父节点裁掉命中区）。
   *  filter ↔ ✕ 的切换靠 Reanimated 的 entering/exiting（FadeIn/FadeOut）做出现/消失动画。
   *  filterMenuOpenSV 只管一件事：菜单打开时把 filter 图标整枚淡到 0，关闭淡回 1（原生 UIMenu
   *  弹出时图标让位）。它跟 unread 无关；返回 filter 视图时在 × 的 onPress 里顺手归 0 复位。 */
  const filterMenuOpenSV = useSharedValue(0);
  const onFilterMenuOpen = useCallback(() => {
    setMenuOpen(true);
    filterMenuOpenSV.value = withTiming(1, { duration: 150 });
  }, [filterMenuOpenSV, setMenuOpen]);
  const onFilterMenuClose = useCallback(() => {
    setMenuOpen(false);
    filterMenuOpenSV.value = withTiming(0, { duration: 150 });
  }, [filterMenuOpenSV, setMenuOpen]);
  const filterIconAnimStyle = useAnimatedStyle(() => ({
    opacity: 1 - filterMenuOpenSV.value,
  }));

  /* Android 自绘 popover 的落点：按下时用按钮 ref measureInWindow 拿到屏幕坐标，让菜单贴按钮
   *  下边缘**向下**弹。之前写死 top=headerHeight+120，可按钮在 footer 里、位置随列表长度浮动，
   *  菜单永远飘在 list 上方 → 看着像"向上展开"。iOS 走原生 UIMenu，不用这套。 */
  const filterBtnRef = useRef<View>(null);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, right: 20 });
  const openAndroidFilterMenu = useCallback(() => {
    const show = () => { setFilterMenuOpen(true); onFilterMenuOpen(); };
    const node = filterBtnRef.current;
    if (node?.measureInWindow) {
      node.measureInWindow((x, y, w, h) => {
        setFilterMenuPos({ top: y + h + 6, right: Math.max(12, layoutWidth - (x + w)) });
        show();
      });
    } else {
      show();
    }
  }, [onFilterMenuOpen, layoutWidth]);

  /** 当前可见对话切片 + 是否还有更多（本地未渲染的 或 服务端还没拉的） */
  const filteredConvList = showUnreadOnly ? convList.filter((c) => chatV2UnreadByConv[c.id]) : convList;
  const visibleConvs = filteredConvList.slice(0, convVisibleCount);
  const hasMoreConvs = convVisibleCount < filteredConvList.length || serverHasMoreConvs;
  const loadMoreConvs = useCallback(() => {
    // 先放本地切片（纯 slice，瞬时）
    setConvVisibleCount((n) => (n < filteredConvList.length ? n + CONV_PAGE_SIZE : n));
    // 手上剩余不足一屏 → 顺手从服务端补下一页（context 内部有并发闸 + hasMore 守卫，重复调用无害）
    if (filteredConvList.length - convVisibleCount <= CONV_PAGE_SIZE) {
      void loadMoreConvsFromServer();
    }
  }, [filteredConvList.length, convVisibleCount, loadMoreConvsFromServer]);

  /** 列表尾：[结束今天]（新建任务已去掉，走右下角 FAB）+ 对话段 */
  const ListFooter = (
    <View style={styles.footerWrap}>
      {showEndToday ? (
        <View style={styles.taskActionRow}>
          <AnimatedCircleButton iosForceWorklet style={styles.endTodayBtn} onPress={endToday}>
            <Text style={styles.endTodayText}>结束今天</Text>
          </AnimatedCircleButton>
        </View>
      ) : null}

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>对话</Text>
        <View style={{ flex: 1 }} />
        {/* filter 菜单键 ↔ "×"清除键 条件渲染：任一时刻只有一个挂载，无叠层、无裁剪父节点，
         *  命中区就是按钮自身（内层 filterBtn padding 撑出 ≈40x40，不再被小框裁掉）。
         *  切换用 FadeIn/FadeOut 做交叉出现/消失动画。iOS 仍走原生 MenuView。 */}
        {showUnreadOnly ? (
          <Animated.View key="filter-clear" entering={FadeIn.duration(300)} exiting={FadeOut.duration(300)}>
            <TouchableOpacity
              onPress={() => { setShowUnreadOnly(false); filterMenuOpenSV.value = 0; }}
              activeOpacity={0.7}
              hitSlop={8}
            >
              <View style={styles.filterBtn}>
                <Ionicons name="close-circle" size={20} color={colors.primary} />
              </View>
            </TouchableOpacity>
          </Animated.View>
        ) : (
          /* entering(layout animation) 与 opacity animated style 分挂两层：同一 Animated.View
           *  上两者都动 opacity 会触发 Reanimated "may be overwritten by a layout animation" 警告 */
          <Animated.View key="filter-menu" entering={FadeIn.duration(300)}>
            <Animated.View style={filterIconAnimStyle}>
              {Platform.OS === 'ios' ? (
                <MenuView
                  title=""
                  actions={convFilterMenuActions as unknown as any[]}
                  onPressAction={onConvFilterMenuView}
                  onOpenMenu={onFilterMenuOpen}
                  onCloseMenu={onFilterMenuClose}
                  shouldOpenOnLongPress={false}
                >
                  <View style={styles.filterBtn}>
                    <Ionicons name="filter-outline" size={20} color={colors.textSecondary} />
                  </View>
                </MenuView>
              ) : (
                <TouchableOpacity
                  onPress={openAndroidFilterMenu}
                  activeOpacity={0.7}
                  hitSlop={8}
                >
                  <View ref={filterBtnRef} style={styles.filterBtn}>
                    <Ionicons name="filter-outline" size={20} color={colors.textSecondary} />
                  </View>
                </TouchableOpacity>
              )}
            </Animated.View>
          </Animated.View>
        )}
      </View>

      {convPending && convList.length === 0 ? (
        /* 冷启动没快照可秒开时的加载态：骨架行而非居中菊花——预告内容形状，且行几何与
           ConversationRow 一致，真列表到位时页面不跳。有快照的路径走不到这里。 */
        <ConversationListSkeleton count={CONV_PAGE_SIZE} />
      ) : convList.length === 0 ? (
        <View style={styles.convEmpty}>
          <Ionicons
            name="chatbubbles-outline"
            size={48}
            color={colors.border}
          />
          <Text style={styles.convEmptyText}>暂无历史对话</Text>
        </View>
      ) : (
        <>
          {visibleConvs.map((c) => (
            <ConversationRow
              key={c.id}
              title={(c.title && c.title.trim()) || '新对话'}
              timeLabel={c.updated_at ? formatTime(c.updated_at) : null}
              running={chatV2RunningByConv[c.id]}
              bgRunning={bgTaskRunningByConv[c.id]}
              unread={chatV2UnreadByConv[c.id]}
              onPress={() => onConvPress(c)}
              onLongPress={() => setDeleteConvTarget(c)}
            />
          ))}
          {/* 还有更多：占位加载行（滚到底由 onEndReached 触发 loadMoreConvs 放出下一页）。
           *  本地还有未渲染的切片时几乎瞬时；切到底了则是在等服务端下一页，同一个占位复用。 */}
          {hasMoreConvs ? (
            <View style={styles.convLoading}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : null}
        </>
      )}

      {/* 留出空间不让搜索框遮内容 */}
      <View style={{ height: 80 }} />
    </View>
  );

  /* SafeAreaView edges 去掉 'bottom'：改用手动 paddingBottom = bottomInset（native 同步、首帧即正确），
   * 避免 SafeAreaView 吃 safe-area 首帧 0 的 insets 导致"先贴底后上移"闪。bottomInset 在 iOS 仍跟随
   * insets.bottom（键盘弹起时归 0、padding 自动消失，行为不变）。 */
  return (
    <SafeAreaView
      style={[styles.container, { paddingBottom: bottomInset }]}
      edges={[]}
      /* 量本屏容器实际宽度：iPad 侧栏模式下 = 主区 pane 宽（非全屏），底部搜索框据此算宽，避免戳出 pane。 */
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && w !== containerWidth) setContainerWidth(w);
      }}
    >
    <KeyboardAvoidingView
      style={styles.kavInner}
      /* lib KAV 两端都用 'padding'：lib 内部走 WindowInsets.ime（Android）/
       *  UIKeyboardLayoutGuide（iOS）拿 frame，paddingBottom 由 lib 直接驱动。Android 不再像
       *  RN 自带 KAV 那样跟 adjustResize 双重处理——lib KAV 不依赖 adjustResize，传 undefined
       *  会走到内部 default 分支变 no-op（content 不动）。edge-to-edge 模式下尤其要这样配，
       *  因为 adjustResize 本身行为被 fitsSystemWindows=false 改变了。 */
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      {/* SafeAreaView 在外 + KAV 在内（跟 ChatScreen 同款顺序）：
       *  - 无键盘：SafeAreaView 给整个 layout 加 insets.bottom 的下 padding，所有 absolute
       *    bottom:0 的子元素都在 home indicator 上方
       *  - 有键盘：iOS 报 insets.bottom=0 → SafeAreaView padding 自动消失；KAV 加 kbHeight
       *    padding → kavInner 缩小让 absolute children 跟着原生上浮
       *  零 JS 动画，跟 iOS 键盘 100% sync。
       *  注：之前 KAV 在外、SafeAreaView 在内的顺序不奏效，SafeAreaView 内的 absolute
       *  children 在 Yoga 里 anchor 到 outer border 而非 padding box。
       *  内层 <View flex:1> wrapper 必须存在：KAV padding 缩小 KAV 自己的 content area，
       *  absolute children 直接挂 KAV 上是按 outer border 定位的（padding 不影响），所以套
       *  一层 flex:1 让 padding 通过 flex 链 propagate 给它，absolute children 才能跟着上浮。 */}
      <View style={styles.kavInner}>
      {/* 顶部 header（绝对定位，blur 背景） */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        <HamburgerButton />
        <View style={styles.topBarCenter} pointerEvents="none">
          <Text style={styles.todayTitle}>{formatTodayDate(todayDate)}</Text>
          {isAheadOfToday ? (
            <TouchableOpacity onPress={cancelAheadOfToday} activeOpacity={0.7}>
              <Text style={styles.aheadHint}>预览明日 · 点取消</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <AnimatedCircleButton
          style={styles.headerCircleBtn}
          onPress={onCalendarPress}
          iosSfSymbol={{ name: 'calendar', size: HEADER_CIRCLE_SF_ICON_SIZE, color: colors.textSecondary }}
        >
          <Ionicons name="calendar-outline" size={HEADER_CIRCLE_IONICON_SIZE} color={colors.textSecondary} />
        </AnimatedCircleButton>
      </View>

      {/* 主列表。加载态是**整页骨架**而不是居中大菊花：菊花那条路把整个内容区（含
          ListFooterComponent 里的对话段）都换掉了，对话骨架根本没机会挂载——冷启动看到的
          就是「header + 全屏菊花 → 直接真内容」。骨架 paddingTop 跟下面 list 的
          contentContainerStyle 对齐，替换时第一行不跳。 */}
      {taskLoading ? (
        <TodayContentSkeleton paddingTop={headerHeight + 8} />
      ) : (
        <DraggableFlatList<ListRow>
          containerStyle={{ flex: 1 }}
          data={localTaskOrder}
          keyExtractor={(item) => item.id}
          onDragEnd={({ data }) => setLocalTaskOrder(data)}
          /* 任何 list 区域的 touchStart 都让输入框失焦 —— tap 跟滚动都从 touchStart 起步,
           * 覆盖两种交互。keyboardDismissMode 是 RN 内置的滚动 dismiss 双保险（特别是 iOS
           * 上的 interactive dismiss）。 */
          onTouchStart={Keyboard.dismiss}
          keyboardDismissMode="on-drag"
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
          ListEmptyComponent={
            <View style={styles.taskEmpty}>
              <Ionicons
                name="checkmark-done-outline"
                size={48}
                color={colors.placeholder}
              />
              <Text style={styles.taskEmptyText}>今日无任务</Text>
            </View>
          }
          renderItem={({ item, drag }) => (
            <TaskRow
              task={item}
              showProjectName={showProjectName}
              showTimeLabel={showTimeLabels}
              projectName={
                projects.find((p) => p.id === item.project_id)?.name ?? undefined
              }
              onPress={() => onTaskPress(item)}
              onToggleCompletion={() => toggleTaskCompletion(item)}
              drag={drag}
            />
          )}
          onScroll={Platform.OS === 'ios' ? handleScroll : undefined}
          scrollEventThrottle={16}
          /* 滚到底放出下一页对话（footer 里的对话段分页）。0.5 = 距底半屏即触发，提前补充更顺滑。 */
          onEndReached={loadMoreConvs}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              tintColor={colors.primary}
              progressViewOffset={Platform.OS === 'android' ? headerHeight : undefined}
            />
          }
          contentContainerStyle={[
            styles.listContent,
            { paddingTop: headerHeight + 8 },
          ]}
        />
      )}

      {Platform.OS === 'ios' ? (
        <View
          style={[styles.refreshIndicatorFixed, { top: headerHeight }]}
          pointerEvents="none"
        >
          <PullToRefreshRing
            pullDistance={pullDistanceShared}
            refreshing={refreshingShared}
            threshold={PULL_RING_THRESHOLD}
            refreshingState={refreshing}
            color={colors.primary}
          />
        </View>
      ) : null}

      {/* 底栏背后的渐变 fade，跟顶部 BlurHeaderBackground 镜像：底端是 safe-area solid
          挡块，往上是 0.05→0.98 alpha 渐变，让滚动列表滚到搜索框下方时被柔化遮挡而不是
          硬切。独立 overlay（不放进 searchWrap）以便 fade 高度可以盖过 searchRow，扩展
          到 searchWrap 上方而不挤掉 searchRow 自身的位置。
          套一层 wrapper 持有 bottom+height —— 直接把 bottom/height 透传给 BlurFooterBackground
          会跟它内部的 absoluteFill (含 top:0) 冲突，Yoga 让 top 赢导致 overlay 被吸到屏顶。 */}
      <Animated.View
        style={[
          styles.bottomFade,
          /* height = FADE_TOP_ABOVE_KAV + FADE_BOTTOM_BELOW_KAV，跟 kbBottomFadeStyle 配对：
           * - bottom = -FADE_BOTTOM_BELOW_KAV → wrapper 底端在 kavInner 下方 N pt
           * - 总高 = wrapper 顶端到底端的距离 = FADE_TOP_ABOVE_KAV - (-FADE_BOTTOM_BELOW_KAV)
           *   = FADE_TOP_ABOVE_KAV + FADE_BOTTOM_BELOW_KAV
           * 所以调 FADE_TOP_ABOVE_KAV 只影响 fade 顶端位置；调 FADE_BOTTOM_BELOW_KAV 只影响底端。 */
          { height: FADE_TOP_ABOVE_KAV + FADE_BOTTOM_BELOW_KAV },
          kbBottomFadeStyle,
        ]}
        pointerEvents="none"
      >
        <BlurFooterBackground
          bottomSolidHeight={FADE_SOLID_HEIGHT}
          gradientBaseHex={colors.chatScreenBackground}
        />
      </Animated.View>

      {/* 底部 sticky：搜索框 + 新对话 FAB 单行并列。跟 ProjectScreen 底部"tab + FAB 单行"
          同一个布局语言。 */}
      <Animated.View
        style={[
          styles.searchWrap,
          /* paddingBottom 由 kbSearchWrapStyle 管：无键盘时 = max(insets.bottom, 8) 补 safe-area；
           * 键盘弹起时 = 0（键盘自己占了底部空间，不再需要 safe-area inset）。
           * paddingHorizontal 由 searchWrapPaddingStyle 管：focused 时 26→12 收窄。 */
          kbSearchWrapStyle,
          searchWrapPaddingStyle,
        ]}
      >
        <View style={styles.searchRow}>
          {/* FAB 菜单打开时搜索框 morph 成 52pt 圆，只留 search icon——让位给上方 UIMenu。
              BouncyGlassCard / View 套一层 Animated.View 控宽度；内部 icon + TextInput 套一
              层 contentAnimatedStyle 控 opacity （宽收完前已经透明，避免文字露出来）。
              flexShrink: 0 是关键——searchRow 是 row 容器，默认 flexShrink:1 会被 FAB / gap
              挤压宽度（动画驱动的 width 又被 layout 压缩 → 两套尺寸打架）。pin 死宽度由
              animated style 单方驱动。 */}
          <Animated.View style={[styles.searchInputAnim, searchBoxAnimatedStyle]}>
            {IS_IOS_LIQUID_GLASS ? (
              <BouncyGlassCard
                style={[styles.searchInputBoxGlass, styles.searchInputBoxFill]}
                cornerRadius={COMPOSER_CARD_RADIUS}
                interactive
                /* 整个胶囊点哪都进输入态 —— TextInput 物理区域比胶囊小（左边 icon 占
                   一部分），点 icon 区或左边空白本来 TextInput 抓不到 focus。BouncyGlassCard
                   自己的 UITapGestureRecognizer 已经 cancelsTouchesInView=NO，touch 仍可正常
                   传给 TextInput；这里 onPress 是"点胶囊其它区域也焦"的补漏。menu 关闭后
                   500ms 内的 tap 在 onSearchPress 里被 skip，避免关菜单那一下误 focus。 */
                onPress={onSearchPress}
              >
                <Ionicons name="search" size={18} color={colors.textMuted} />
                <Animated.View style={[styles.searchInputTextWrap, searchContentAnimatedStyle]}>
                  <TextInput
                    ref={searchInputRef}
                    style={styles.searchInput}
                    placeholder="搜索任务或对话"
                    placeholderTextColor={colors.placeholder}
                    returnKeyType="search"
                    editable={!fabMenuOpen}
                  />
                </Animated.View>
              </BouncyGlassCard>
            ) : (
              /* Android 路径胶囊按下放大：用 RN raw onTouch* 而非 RNGH（gesture 在
               * EditText activate native gesture 后会被 cancel → spring 提前 down，
               * 按住无法保持放大）。raw onTouch* 独立于 responder system / gesture
               * ownership，child EditText cursor placement / 选词不受影响。 */
              <Animated.View
                /* collapsable={false}：保证 host view 不被 Yoga fold 进 parent,
                 * raw onTouch* event 才能稳定 dispatch 到这一层。 */
                collapsable={false}
                style={[styles.searchInputBox, styles.searchInputBoxFill, searchBoxPressAnimStyle]}
                onTouchStart={onSearchBoxTouchStart}
                onTouchEnd={onSearchBoxTouchEnd}
                onTouchCancel={onSearchBoxTouchCancel}
              >
                <Ionicons name="search" size={18} color={colors.textMuted} />
                <Animated.View style={[styles.searchInputTextWrap, searchContentAnimatedStyle]}>
                  <TextInput
                    ref={searchInputRef}
                    style={styles.searchInput}
                    placeholder="搜索任务或对话"
                    placeholderTextColor={colors.placeholder}
                    returnKeyType="search"
                    editable={!fabMenuOpen}
                  />
                </Animated.View>
              </Animated.View>
            )}
          </Animated.View>
          {/* Fab + 菜单 —— dual Fab 叠放，按 searchFocused 切 wrapper opacity + pointerEvents：
           *  - 非输入态：visible Fab 是 +（带 menuActions native UIMenu / 其它平台 onPress
           *    openFabMenu）。
           *  - 输入态：visible Fab 是 ×（onPress blur TextInput）。
           *  关键：两个 Fab 各自的 prop 永远不变，所以底层 BouncyButton native 不会 diff
           *  sfSymbolName / menuActionsJson → UIButton.configuration 不重算 → 无 layout
           *  re-pass。state 切换只影响 wrapper View 的 opacity (CALayer.opacity，纯视觉，
           *  不触发 layout)，所以输入框这一行不会再"跳"。 */}
          <View style={styles.fabSwapWrap}>
            {/* 两端统一 dual stack + scale crossfade。视觉跟 hit-test 路由都吃 focusedProgress
                (UI 线程 SharedValue) —— scale 跟 pointerEvents 由 fab*AnimStyle 在 animated
                style 里逐帧同步驱动（详见上面 fabPlus/CloseAnimStyle 注释）。close 在 z 底层、
                plus 顶层覆盖（避开 iOS UIGlassEffect 子树 opacity:0 mount 的背景渲染 bug；
                Android 无影响）。 */}
            <Animated.View style={[StyleSheet.absoluteFill, fabCloseAnimStyle]}>
              <Fab
                ionicon="close"
                sfSymbol="xmark"
                onPress={onCloseFabPress}
              />
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, fabPlusAnimStyle]}>
              <Fab
                ionicon="add"
                sfSymbol="plus"
                onPress={IS_IOS_LIQUID_GLASS ? undefined : openFabMenu}
                menuActions={IS_IOS_LIQUID_GLASS ? fabMenuActions : undefined}
                onMenuAction={IS_IOS_LIQUID_GLASS ? onFabMenuPick : undefined}
                onMenuWillShow={IS_IOS_LIQUID_GLASS ? openFabMenu : undefined}
                onMenuDidDismiss={IS_IOS_LIQUID_GLASS ? closeFabMenu : undefined}
              />
            </Animated.View>
          </View>
        </View>
      </Animated.View>
      </View>
    </KeyboardAvoidingView>

      {/* 删除对话确认 */}
      <Modal
        visible={deleteConvTarget != null}
        transparent
        animationType="fade"
        onRequestClose={closeDeleteConvModal}
      >
        <Pressable style={styles.deleteOverlay} onPress={closeDeleteConvModal}>
          <View style={styles.deleteCenter} pointerEvents="box-none">
            <View style={styles.deleteCard} onStartShouldSetResponder={() => true}>
              <Text style={styles.deleteTitle}>删除对话</Text>
              <Text style={styles.deleteBody}>
                确定要删除「
                {(deleteConvTarget?.title && deleteConvTarget.title.trim()) || '新对话'}」吗？
              </Text>
              <View style={styles.deleteActions}>
                <TouchableOpacity
                  style={[styles.deleteBtn, styles.deleteBtnCancel]}
                  onPress={closeDeleteConvModal}
                  activeOpacity={0.75}
                >
                  <Text style={styles.deleteBtnCancelText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.deleteBtn, styles.deleteBtnDanger]}
                  onPress={confirmDeleteConversation}
                  activeOpacity={0.75}
                >
                  <Text style={styles.deleteBtnDangerText}>删除</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* 新建任务的两个 sheet（沿用 TasksHomeScreen） */}
      <ProjectSelectSheet
        visible={showProjectSelect}
        onClose={() => setShowProjectSelect(false)}
        projects={projects}
        onSelectProject={onSelectProjectForCreate}
      />
      <CreateTaskRegionSheet
        visible={showCreateRegionSheet}
        projectLabel={pendingCreateProject?.name ?? pendingCreateProject?.id ?? ''}
        dumpParents={createRegionDumpOptions}
        onClose={onCloseCreateRegionSheet}
        onSelect={onSelectCreateRegion}
      />
      <TaskFilterSheet
        visible={filterVisible}
        onClose={() => setFilterVisible(false)}
        showOnlyMine={false}
        onShowOnlyMineChange={() => {}}
        statusLevel={statusLevel}
        onStatusLevelChange={setStatusLevel}
        showTimeLabels={showTimeLabels}
        onShowTimeLabelsChange={setShowTimeLabels}
        showProjectName={showProjectName}
        onShowProjectNameChange={setShowProjectName}
        showOnlyMineToggle={false}
        isAheadOfToday={isAheadOfToday}
        onCancelAheadOfToday={cancelAheadOfToday}
      />

      {/* Android 对话筛选 popover（iOS 走原生 UIMenu 不进这里） */}
      {!IS_IOS_LIQUID_GLASS && Platform.OS !== 'ios' && filterMenuOpen ? (
        <>
          {/* backdrop 必须**真吞掉** outside tap，否则触摸会穿透到底层 FlatList / ConversationRow
           *  触发误触（点进对话）。Pressable+onPress 不够：它只在 touchEnd 兜底，且 Android 上
           *  elevation 0 的 backdrop 不压制底层触摸。改成显式 responder：onStart/onMove 都 return
           *  true 抢下 responder，terminationRequest return false 拒绝被 RNGH Pan 抢走，
           *  onResponderRelease 里才关菜单。zIndex/elevation 9000（< 菜单卡 9999）压制底层。 */}
          <View
            style={[StyleSheet.absoluteFill, styles.menuBackdrop]}
            pointerEvents="auto"
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderRelease={() => { setFilterMenuOpen(false); onFilterMenuClose(); }}
          />
          <View style={[styles.filterMenuCard, {
            top: filterMenuPos.top,
            right: filterMenuPos.right,
          }]}>
            <TouchableOpacity
              style={styles.fabMenuItem}
              activeOpacity={0.6}
              onPress={() => { setFilterMenuOpen(false); onFilterMenuClose(); setShowUnreadOnly(false); }}
            >
              <Ionicons name="chatbubbles-outline" size={20} color={colors.textPrimary} />
              <Text style={styles.fabMenuItemText}>全部对话</Text>
              {!showUnreadOnly ? <Ionicons name="checkmark" size={16} color={colors.primary} style={{ marginLeft: 'auto' }} /> : null}
            </TouchableOpacity>
            <View style={styles.fabMenuDivider} />
            <TouchableOpacity
              style={styles.fabMenuItem}
              activeOpacity={0.6}
              onPress={() => { setFilterMenuOpen(false); onFilterMenuClose(); setShowUnreadOnly(true); }}
            >
              <Ionicons name="mail-unread-outline" size={20} color={colors.textPrimary} />
              <Text style={styles.fabMenuItemText}>仅未读</Text>
              {showUnreadOnly ? <Ionicons name="checkmark" size={16} color={colors.primary} style={{ marginLeft: 'auto' }} /> : null}
            </TouchableOpacity>
          </View>
        </>
      ) : null}

      {/* 非 iOS 26 走自绘 popover；iOS 26 走原生 UIMenu 不渲染。
       *
       * 改造历史：以前用 <Modal>，Android 上 native dialog 冷启动 200-400ms；后来去掉
       * Modal 直接 absolute View，但 fabMenuOpen ? <menu/> : null 还是 conditional mount,
       * Yoga layout + native view 创建几十 ms。现在 menu 跟 backdrop 全部 **常驻 mount**,
       * 可见性靠 SharedValue 驱动 opacity / scale / pointerEvents，开菜单 worklet 一帧
       * 直接切，无 mount 延迟。
       *
       * 位置：right / bottom 比 FAB 各偏移一点点（右 26→30, 底 +8），让 menu 卡片覆盖
       * 整个 FAB 范围 + 视觉上向左上长出来。borderRadius 跟 FAB 一致。 */}
      {!IS_IOS_LIQUID_GLASS ? (
        <>
          <Animated.View
            style={[StyleSheet.absoluteFill, styles.fabMenuBackdrop, fabMenuBackdropAnimStyle]}
          >
            {/* 同 filter backdrop：显式 responder 真吞掉 outside tap，杜绝穿透到底层误触。
             *  外层 Animated.View 已用 fabMenuBackdropAnimStyle 的 pointerEvents 控开合。 */}
            <View
              style={StyleSheet.absoluteFill}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderTerminationRequest={() => false}
              onResponderRelease={closeFabMenu}
            />
          </Animated.View>
          <Animated.View
            style={[
              styles.fabMenuCard,
              {
                bottom: Math.max(bottomInset, 8) + 8,
                /* right 26 跟 FAB 右沿（searchWrap.paddingHorizontal）对齐 —— 菜单右边
                 * 不向内错开，跟 FAB 右沿一根垂直线。 */
                right: 26,
              },
              fabMenuCardAnimStyle,
            ]}
          >
            <TouchableOpacity
              style={styles.fabMenuItem}
              activeOpacity={0.6}
              onPress={() => {
                closeFabMenu();
                onCreateChat();
              }}
            >
              <Ionicons name="chatbubble-outline" size={20} color={colors.textPrimary} />
              <Text style={styles.fabMenuItemText}>新建对话</Text>
            </TouchableOpacity>
            <View style={styles.fabMenuDivider} />
            <TouchableOpacity
              style={styles.fabMenuItem}
              activeOpacity={0.6}
              onPress={() => {
                closeFabMenu();
                onCreateTask();
              }}
            >
              <Ionicons name="checkbox-outline" size={20} color={colors.textPrimary} />
              <Text style={styles.fabMenuItemText}>新建任务</Text>
            </TouchableOpacity>
          </Animated.View>
        </>
      ) : null}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
    /* KAV 内层 flex:1 wrapper —— iOS 让 KAV padding 缩小它、absolute children 跟着原生上浮，
     * Android 让 adjustResize 缩小整个 wrapper 同理。layout-aware 元素都放进去。 */
    kavInner: { flex: 1 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    placeholderText: { fontSize: 16, color: c.textMuted },
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
    topBarCenter: { alignItems: 'center', flex: 1 },
    todayTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: c.textHeader },
    aheadHint: { fontSize: 12, color: c.primary, marginTop: 2 },
    headerCircleBtn: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
    smallCircleBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderMuted,
    },
    taskHeaderWrap: { paddingTop: 8, paddingBottom: 4 },
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginVertical: 8,
      paddingHorizontal: 18,
    },
    sectionTitle: { fontSize: 14, fontWeight: '600', color: c.textSecondary },
    /* 筛选按钮命中区：正常 padding 把 20px 图标撑到 ≈40x40，父节点自然尺寸不裁剪，命中区真实生效 */
    filterBtn: { padding: 10 },
    errorBar: { backgroundColor: c.errorBg, padding: 12, borderRadius: 8, marginBottom: 8, marginHorizontal: 18 },
    errorText: { fontSize: 14, color: c.danger, textAlign: 'center' },
    taskEmpty: { paddingVertical: 32, alignItems: 'center' },
    taskEmptyText: {
      marginTop: 8,
      fontSize: TASK_FONT_SIZE_SMALL,
      color: c.placeholder,
    },
    /** 列表不做页面级横向 padding（=0）：每类内容各自 padding 16，任务行全宽顶到两端
     *  （按下高亮也整条铺满），圆环靠卡片自身默认内边距(16)落在 x=16，跟段标题/对话行同一线。 */
    listContent: { paddingHorizontal: 0, paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
    footerWrap: { paddingTop: 12 },
    taskActionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      marginBottom: 12,
      paddingHorizontal: 18,
    },
    endTodayBtn: {
      height: HEADER_CIRCLE_BTN_SIZE,
      paddingHorizontal: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      borderWidth: 1,
      borderColor: c.androidCircleFabHairline,
      ...Platform.select({ ios: { ...shadowSoft } }),
    },
    endTodayText: { fontSize: 16, fontWeight: '500', color: c.textPrimary },
    convLoading: { paddingVertical: 24, alignItems: 'center' },
    convEmpty: {
      paddingVertical: 24,
      alignItems: 'center',
    },
    convEmptyText: { marginTop: 8, fontSize: 13, color: c.placeholder },
    convRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    convRowMain: { flex: 1, minWidth: 0 },
    convRowTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    /* 字号/字重跟上方任务标题一致（TASK_FONT_SIZE_BODY=17 / 400） */
    convRowText: { flex: 1, minWidth: 0, fontSize: TASK_FONT_SIZE_BODY, color: c.textPrimary, fontWeight: '400' },
    /* 灰色跟任务副标题同一个灰（c.placeholder），而非更深的 textMuted */
    convRowMeta: { fontSize: 12, color: c.placeholder, marginTop: 2 },
    refreshIndicatorFixed: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      zIndex: 9,
    },
    /* 底栏 fade 覆盖层（BlurFooterBackground）。绝对定位贴底；高度在 callsite 按 safe-area
       动态算。zIndex 隐式 = DOM 顺序，所以挂在 DraggableFlatList 之后、searchWrap 之前，让
       它正好挡在滚动列表上面、漂浮控件下面。 */
    bottomFade: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
    },
    /* sticky 底栏：上方 pill 行 + 下方搜索框 */
    searchWrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      /* paddingHorizontal: 22 跟列表 listContent 同款，搜索框左缘 / FAB 右缘对齐下方任务
         /对话列表的左右沿一根垂直线。之前试过 28（DCR 同心几何对齐）、36（更紧），最终
         视觉上跟列表内容对齐才统一。 */
      paddingHorizontal: 26,
      paddingTop: 10,
      flexDirection: 'column',
      gap: 10,
      /* 没 backgroundColor —— 让搜索 / FAB 漂浮在下方滚动内容之上（跟 ProjectScreen 底栏
         同款）。content 那侧 paddingBottom 已经给了 LIST_PADDING_BOTTOM_WITH_FOOTER 留位，
         不会永久挡住最后几条。 */
    },
    /* 搜索 + FAB 单行：searchInputAnim 宽度由 animated style 单方驱动，FAB 固定 52pt。
       justifyContent: space-between 让 FAB 死贴右沿——之前默认 flex-start，搜索框收缩时
       FAB 跟着左移、展开时右移，看着像"按钮被拽来拽去"。space-between 下：展开态两者
       宽和 ≈ row 总宽（无空隙），collapsed 态搜索贴左、FAB 贴右、中间空白，FAB 位置稳定不动。
       gap 10 在 collapsed 态会被 space-between 的间距盖掉（间距大于 gap 时 gap 不显），
       展开态两 item 紧贴反而是 gap 10 控间距——两种态下间距连续过渡。 */
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    /* searchInputAnim：搜索框外层 wrapper，宽度由 searchBoxAnimatedStyle 单方驱动（不
       走 flex）。height 跟 FAB 等高 (52pt)，菜单打开收成 52pt 圆。flexShrink:0 防止
       搜索框被 searchRow 的 flex layout 二次压缩，跟 animated width 打架。 */
    searchInputAnim: { height: COMPOSER_PILL_SIZE, flexShrink: 0, justifyContent: 'center' },
    /* searchInputBoxFill：让内部 BouncyGlassCard / View 撑满 searchInputAnim 的宽度（动画
       驱动），而不是 flex:1（跟 parent flex 抢宽）。 */
    searchInputBoxFill: { width: '100%' },
    /* dual Fab 包层：固定 FAB 尺寸的 wrapper，两个 Fab 都 absoluteFill 进去 stack 叠放。
       state 切只动子 wrapper 的 opacity（Reanimated worklet 驱动，UI 线程 220ms 渐变）+
       pointerEvents（React state 切 hit-test target），不动子 Fab 自身 prop，UIButton 内部
       完全稳定无 layout re-pass。 */
    fabSwapWrap: { width: FAB_SIZE, height: FAB_SIZE },
    /* TextInput / placeholder 套这一层，opacity 跟 searchContentAnimatedStyle 联动 ——
       菜单打开收圆时文字先 fade out 再宽度收完，避免文字被压扁/挤出来。flex:1 让它在
       icon 旁吃满剩余宽度。overflow:hidden 收圆时把溢出文字裁掉。 */
    searchInputTextWrap: { flex: 1, overflow: 'hidden' },
    /* pillBtn / pillBtnText 还在被"任务段"的新建任务按钮（inline 在 sectionRow 里）用着，
       底部 sticky 的"新对话 pill"已经换成 Fab——所以 pillBtn 的 callsite 只剩一处。 */
    pillBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 24,
      backgroundColor: c.primary,
      ...shadowMenu,
    },
    pillBtnText: { fontSize: 15, fontWeight: '600', color: c.onPrimary },
    /* height: 52 跟旁边 FAB（FAB_SIZE）等高；borderRadius: 26 = height/2 capsule 形状。
       paddingVertical 去掉——固定高度下 alignItems: center 已经把 icon + 输入框居中。
       paddingLeft = 17 = borderRadius − icon半宽 = 26 − 9：让 search icon 的水平中心
       永远落在 capsule 左半圆圆心 (x=26) 上，长条 / 圆形两态都对齐。paddingRight 留 14
       给文字 padding；圆形态 textWrap flex:1 占满右侧 slack，icon 位置不被它影响。
       gap 移除：FAB 菜单打开时 search morph 成 52pt 圆，row gap 即使 textWrap 0 宽也会
       算占位（导致 icon 被裁）。改由 searchInputTextWrap 的 marginLeft 控间距，动画到 0。 */
    searchInputBox: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 17,
      paddingRight: 14,
      height: COMPOSER_PILL_SIZE,
      borderRadius: COMPOSER_CARD_RADIUS,
      backgroundColor: c.surface,
      ...shadowMenu,
    },
    /* iOS 26 glass 路径下的 search 卡片样式：保留 row + padding，不要 bg/shadow
       —— 玻璃材质 + system 折光由 BouncyGlassCard 内部 UIVisualEffectView 提供。
       height: 52 跟 FAB 等高（cornerRadius: 26 在 BouncyGlassCard prop 上传）。
       paddingLeft / gap 处理同 searchInputBox（详见上面注释）。 */
    searchInputBoxGlass: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 17,
      paddingRight: 14,
      height: COMPOSER_PILL_SIZE,
    },
    searchInput: {
      flex: 1,
      fontSize: 15,
      color: c.textPrimary,
      padding: 0,
      /* TextInput frame 是按 ascender / descender 度量的，父级 alignItems:'center' 居中
       * 的是 frame，不是文字 cap-height 视觉中心 —— 看起来都偏下，两端都拉一下。
       * Android EditText 偏移更明显，外加 includeFontPadding + textAlignVertical
       * 关掉系统级字体度量 padding。 */
      marginTop: Platform.OS === 'android' ? -3 : -1,
      ...(Platform.OS === 'android' && {
        includeFontPadding: false,
        textAlignVertical: 'center' as const,
      }),
    },
    /* FAB 菜单 popover（仅 iOS<26 / Android 走这套；iOS 26 上原生 UIMenu 接管，
       本 Modal 不渲染）。视觉与 ChatScreen 的 convMenu* 系列同款，便于以后抽。 */
    /* backdrop 用 absoluteFill 全屏覆盖；只用来捕获 outside tap 关菜单，不变暗——
     * 跟 ChatScreen 的 convMenuBackdrop 同款，让 menu 跟背景靠 shadow / surface 区分,
     * 不是靠全屏遮罩。elevation 9000 < menu 9999，确保 backdrop 在 menu 下方。 */
    fabMenuBackdrop: {
      backgroundColor: 'transparent',
      zIndex: 9000,
      elevation: 9000,
    },
    fabMenuCard: {
      position: 'absolute',
      minWidth: 240,
      backgroundColor: c.surface,
      /* 圆角跟 FAB 一致 (FAB borderRadius = FAB_SIZE/2 = 26)，视觉上"圆按钮长大成菜单"。
       * 不要 border —— 跟 ChatScreen convMenuCard 一样，靠 shadowMenu 跟背景区分。 */
      borderRadius: FAB_SIZE / 2,
      overflow: 'hidden',
      /* 卡片内 items 离卡片边距留 padding，配合 borderRadius 26 让 item 不顶到圆角。 */
      paddingVertical: 6,
      paddingHorizontal: 18,
      zIndex: 9999,
      elevation: 9999,
      ...shadowMenu,
    },
    fabMenuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    fabMenuDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.conversationListSeparator,
      marginHorizontal: 8,
    },
    /* 透明全屏 tap-catcher：只吞 outside tap 关菜单，不变暗。Android 靠 elevation 9000
     *  （< 菜单卡 9999）压在底层内容之上、菜单之下，确保触摸落到 backdrop 而非底层行。 */
    menuBackdrop: { backgroundColor: 'transparent', zIndex: 9000, elevation: 9000 },
    filterMenuCard: {
      position: 'absolute',
      minWidth: 180,
      backgroundColor: c.surface,
      borderRadius: 14,
      overflow: 'hidden',
      paddingVertical: 6,
      zIndex: 9999,
      elevation: 9999,
      ...shadowMenu,
    },
    fabMenuItemText: { fontSize: 15, color: c.textPrimary },
    /* 删除 modal */
    deleteOverlay: { flex: 1, backgroundColor: c.modalBackdrop },
    deleteCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    deleteCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 20,
      width: '100%',
      maxWidth: 340,
      borderWidth: 1,
      borderColor: c.borderMuted,
      ...shadowMenu,
    },
    deleteTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader, marginBottom: 8 },
    deleteBody: { fontSize: 15, color: c.textSecondary, lineHeight: 22, marginBottom: 20 },
    deleteActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
    deleteBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
    deleteBtnCancel: { backgroundColor: c.surfaceMuted },
    deleteBtnDanger: { backgroundColor: c.roseBg },
    deleteBtnCancelText: { fontSize: 16, color: c.textPrimary },
    deleteBtnDangerText: { fontSize: 16, fontWeight: '600', color: c.danger },
  });
}

