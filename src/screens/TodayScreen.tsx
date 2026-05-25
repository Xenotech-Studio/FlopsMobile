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
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import DraggableFlatList from 'react-native-draggable-flatlist';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnUI,
} from 'react-native-reanimated';
import { useTask } from '../context/TaskContext';
import { useSession } from '../context/SessionContext';
import {
  createConversation,
  deleteConversation,
  listConversations,
  runInboxStream,
  type ConversationListItem,
} from '../api';
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
import { HamburgerButton } from './shell/HamburgerButton';
import {
  AnimatedCircleButton,
  IS_IOS_LIQUID_GLASS,
} from '../components/AnimatedCircleButton';
import { Fab } from '../components/Fab';
import { BouncyGlassCard } from '../components/BouncyGlassCard';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { shadowCircleButtonThemed, shadowMenu, shadowSoft } from '../theme/shadows';
import {
  HEADER_CIRCLE_BTN_SIZE,
  LIST_PADDING_BOTTOM_WITH_FOOTER,
} from '../theme/layout';
import {
  TASK_FONT_SIZE_SMALL,
  TASK_FONT_SIZE_TITLE,
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
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useSession();
  const {
    todayTasks,
    todayDate,
    tasks,
    projects,
    isLoadingTasks,
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

  /* ---------- 对话段 ---------- */
  const [convList, setConvList] = useState<ConversationListItem[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [chatV2RunningByConv, setChatV2RunningByConv] = useState<Record<string, boolean>>({});
  const [chatV2UnreadByConv, setChatV2UnreadByConv] = useState<Record<string, boolean>>({});
  const [deleteConvTarget, setDeleteConvTarget] = useState<ConversationListItem | null>(null);

  const loadConvs = useCallback(async () => {
    if (!session) return;
    setConvLoading(true);
    try {
      const { conversations } = await listConversations(session);
      const rows = conversations ?? [];
      setConvList(rows);
      setChatV2RunningByConv((prev) => {
        const next = { ...prev };
        rows.forEach((c) => {
          if (Object.prototype.hasOwnProperty.call(c, 'chat_v2_running')) {
            if (c.chat_v2_running) next[c.id] = true;
            else delete next[c.id];
          }
        });
        return next;
      });
      setChatV2UnreadByConv((prev) => {
        const next = { ...prev };
        rows.forEach((c) => {
          if (Object.prototype.hasOwnProperty.call(c, 'chat_v2_unread')) {
            if (c.chat_v2_unread) next[c.id] = true;
            else delete next[c.id];
          }
        });
        return next;
      });
    } catch {
      setConvList([]);
    } finally {
      setConvLoading(false);
    }
  }, [session]);

  useEffect(() => {
    loadConvs();
  }, [loadConvs]);

  /** inbox/stream SSE：与 ConversationListScreen 一致 */
  useEffect(() => {
    if (!session) return undefined;
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        await runInboxStream(session, ac.signal, (msg) => {
          if (cancelled) return;
          const type = msg.type;
          if (
            type === 'inbox_snapshot' &&
            msg.running &&
            typeof msg.running === 'object'
          ) {
            setChatV2RunningByConv(
              Object.fromEntries(
                Object.entries(msg.running as Record<string, unknown>).filter(
                  ([, v]) => v === true
                )
              ) as Record<string, boolean>
            );
          }
          if (
            type === 'inbox_snapshot' &&
            Object.prototype.hasOwnProperty.call(msg, 'unread') &&
            msg.unread &&
            typeof msg.unread === 'object'
          ) {
            setChatV2UnreadByConv(
              Object.fromEntries(
                Object.entries(msg.unread as Record<string, unknown>).filter(
                  ([, v]) => v === true
                )
              ) as Record<string, boolean>
            );
          }
          if (type === 'conversation_run' && msg.conversation_id != null) {
            const id = String(msg.conversation_id);
            setChatV2RunningByConv((prev) => {
              const next = { ...prev };
              if (msg.running) next[id] = true;
              else delete next[id];
              return next;
            });
          } else if (type === 'conversation_unread' && msg.conversation_id != null) {
            const id = String(msg.conversation_id);
            setChatV2UnreadByConv((prev) => {
              const next = { ...prev };
              if (msg.unread) next[id] = true;
              else delete next[id];
              return next;
            });
          }
        });
      } catch (e: unknown) {
        const name = e && typeof e === 'object' && 'name' in e ? (e as { name?: string }).name : '';
        if (name !== 'AbortError') {
          /* 断线后无自动重连；下拉刷新会同步状态 */
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [session]);

  /* ---------- 键盘高度跟踪（绝对定位浮动控件手动避让） ----------
   *  RN 的 position:absolute 子元素是相对父容器**外框**定位的，KeyboardAvoidingView 的
   *  padding 只能推动 flex/relative 子元素，对 absolute children 无效。iOS 跟 Android 都得
   *  手动加 bottom offset。KAV 仍然保留——帮 list 区域 (flex:1) 在键盘弹起时自动缩小，避免
   *  列表内容显示在键盘后面。
   *
   *  之前用过 Reanimated 的 useAnimatedKeyboard，但在 RN 0.84 / 新架构下 iOS 会闪退、Android
   *  也会抖（看着像 WindowInsets 跟 layout 有 race）。换成手动方案：Keyboard.addListener 拿事
   *  件 → 写到 SharedValue (UI 线程读) → useAnimatedStyle 输出 bottom/paddingBottom。
   *  iOS keyboardWillShow 跟键盘动画同步 fire（带 duration），withTiming 用相同时长 → 跟键盘
   *  动画同步。Android 只有 keyboardDidShow（动画结束才 fire），withTiming 在动画结束后再做
   *  ~250ms 平滑插值——不是瞬移，仍有轻微延迟。要彻底跟 Android 键盘同步需要 keyboard-controller
   *  独立 lib（新 native pod）。 */
  const kbHeightShared = useSharedValue(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    /* Android edge-to-edge 下 e.endCoordinates.height 不包含 nav bar inset（键盘 overlap nav bar
     * 那部分的高度不报）→ 我们的 bottom offset 比实际键盘顶低 insets.bottom，搜索框被切掉一半。
     * 加 insets.bottom 补回去。iOS 不需要这个补偿。 */
    const navBarFix = Platform.OS === 'android' ? insets.bottom : 0;
    const showSub = Keyboard.addListener(showEvt, (e) => {
      const d = (e as { duration?: number }).duration ?? 250;
      kbHeightShared.value = withTiming(e.endCoordinates.height + navBarFix, { duration: d });
    });
    const hideSub = Keyboard.addListener(hideEvt, (e) => {
      const d = (e as { duration?: number }).duration ?? 250;
      kbHeightShared.value = withTiming(0, { duration: d });
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [kbHeightShared, insets.bottom]);
  /* iOS：bottom 永远 0、paddingBottom 永远 12。SafeAreaView edges=['bottom'] 给 kavInner 加
   * insets.bottom 的 padding —— iOS 在键盘弹起时**自动报 insets.bottom = 0**（键盘 zone 算
   * unsafe）→ SafeAreaView padding 自动消失 → kavInner 跟着 KAV 缩到 kb top → searchWrap
   * (bottom:0) + paddingBottom 12 落到 kb 上方 12pt。无键盘时 SafeAreaView padding = 34
   * → searchWrap 在 home indicator 上方。零 JS 动画，100% 跟 iOS 键盘原生 sync。
   *
   * Android：SafeAreaView 的 insets.bottom 不随键盘变（nav bar inset 固定），adjustResize 在
   * absolute children 上不可靠，保留 manual offset (h+12) 兜底；paddingBottom 切 0。
   */
  const kbSearchWrapStyle = useAnimatedStyle(() => {
    const h = kbHeightShared.value;
    const safeBottom = Math.max(insets.bottom, 8);
    if (Platform.OS !== 'android') {
      /* iOS 调节钮：bottom 控制 searchWrap 相对 kavInner 底端的偏移。负值把搜索框拉到 safe-area
       * 里（侵入 home indicator 区域）；正值往上推。Yoga 不允许负 padding（会裁成 0），所以用
       * 负 bottom 才能"再往下"。
       * paddingBottom 4 是 searchRow 内部底部留白，跟键盘弹起场景共用（有键盘时 SafeAreaView
       * padding 自动消失、KAV 加 kbHeight padding，search 离键盘 4pt）。 */
      return {
        bottom: -8,
        paddingBottom: 2,
      };
    }
    return {
      bottom: h > 0 ? h + 12 : 0,
      paddingBottom: h > 0 ? 0 : safeBottom,
    };
  });
  /* bottomFade 三个独立调节钮（iOS）：
   *   FADE_BOTTOM_BELOW_KAV: fade 底端离 kavInner 底端的距离（值越大 → fade 底端越下沉，
   *     侵入 safe-area 越多）。等价于 wrapper 的 `bottom: -N`。
   *   FADE_TOP_ABOVE_KAV: fade 顶端离 kavInner 底端的距离（值越大 → fade 顶端越上，渐变越长）。
   *   FADE_SOLID_HEIGHT: wrapper 底端那段「纯不透明」实色块高度。0 = 纯渐变到底，没实色块。
   * 总高 = FADE_TOP_ABOVE_KAV + FADE_BOTTOM_BELOW_KAV；gradient 区高 = 总高 - FADE_SOLID_HEIGHT。 */
  const FADE_BOTTOM_BELOW_KAV = 38;
  const FADE_TOP_ABOVE_KAV = 68;
  const FADE_SOLID_HEIGHT = Math.max(insets.bottom, 8);
  const kbBottomFadeStyle = useAnimatedStyle(() => {
    const h = kbHeightShared.value;
    return { bottom: Platform.OS === 'android' ? h : -FADE_BOTTOM_BELOW_KAV };
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
      await Promise.all([loadTasks(true), loadProjects(true), loadConvs()]);
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
  }, [clearError, loadTasks, loadProjects, loadConvs]);

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

  /* ---------- 跳转 ---------- */
  const onTaskPress = useCallback(
    (task: TaskItem) => navigation.navigate('TaskDetail', { taskId: task.id }),
    [navigation]
  );

  /** 对话行点击：作为二级页 push 出来，返回箭头回到今日页（与抽屉 Recents 的「顶层切换」区分开） */
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
      const { id } = await createConversation(session);
      navigation.navigate('Chat', { conversationId: id, conversationTitle: '新对话' });
      loadConvs();
    } catch (e) {
      Alert.alert('新建对话失败', e instanceof Error ? e.message : String(e));
    }
  }, [session, navigation, loadConvs]);

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
      setConvList((prev) => prev.filter((c) => c.id !== conv.id));
      setChatV2RunningByConv((prev) => {
        const next = { ...prev };
        delete next[conv.id];
        return next;
      });
      setChatV2UnreadByConv((prev) => {
        const next = { ...prev };
        delete next[conv.id];
        return next;
      });
    } catch (e) {
      Alert.alert('删除失败', e instanceof Error ? e.message : '请稍后重试');
    }
  }, [session, deleteConvTarget]);

  /* ---------- 渲染 ---------- */
  if (!session) {
    return (
      <View style={styles.centered}>
        <Text style={styles.placeholderText}>请先登录</Text>
      </View>
    );
  }

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  const taskLoading = isLoadingTasks && todayTasks.length === 0;
  const showEndToday = shouldShowEndTodayButton();

  /** 列表头：filter 段头 */
  const ListHeader = (
    <View style={styles.taskHeaderWrap}>
      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>
          今日 {filteredTodayTasks.length} 个任务
        </Text>
        <TouchableOpacity
          style={styles.smallCircleBtn}
          onPress={() => setFilterVisible(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="filter-outline" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {errorMessage ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
    </View>
  );

  /** 列表尾：[结束今天 | 新建任务] 同行 + 对话段 */
  const ListFooter = (
    <View style={styles.footerWrap}>
      <View style={styles.taskActionRow}>
        {showEndToday ? (
          <TouchableOpacity style={styles.endTodayBtn} onPress={endToday} activeOpacity={0.8}>
            <Text style={styles.endTodayText}>结束今天</Text>
          </TouchableOpacity>
        ) : (
          <View />
        )}
        <TouchableOpacity style={styles.pillBtn} onPress={onCreateTask} activeOpacity={0.85}>
          <Ionicons name="add" size={20} color={colors.onPrimary} />
          <Text style={styles.pillBtnText}>新建任务</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>对话</Text>
        <View style={{ flex: 1 }} />
      </View>

      {convLoading && convList.length === 0 ? (
        <View style={styles.convLoading}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
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
        convList.map((c) => (
          <TouchableOpacity
            key={c.id}
            style={styles.convRow}
            onPress={() => onConvPress(c)}
            onLongPress={() => setDeleteConvTarget(c)}
            activeOpacity={0.7}
          >
            <View style={styles.convRowMain}>
              <View style={styles.convRowTitle}>
                <Text style={styles.convRowText} numberOfLines={1}>
                  {(c.title && c.title.trim()) || '新对话'}
                </Text>
                {chatV2RunningByConv[c.id] ? (
                  <InboxRunSpinner />
                ) : chatV2UnreadByConv[c.id] ? (
                  <InboxUnreadCheck />
                ) : null}
              </View>
              {c.updated_at ? (
                <Text style={styles.convRowMeta} numberOfLines={1}>
                  {formatTime(c.updated_at)}
                </Text>
              ) : null}
            </View>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={colors.textMuted}
            />
          </TouchableOpacity>
        ))
      )}

      {/* 留出空间不让搜索框遮内容 */}
      <View style={{ height: 80 }} />
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
    <KeyboardAvoidingView
      style={styles.kavInner}
      /* Android 不传 behavior：AndroidManifest 已设 windowSoftInputMode=adjustResize，系统会
       *  自己 resize 整个 window，再叠 KAV "height" 会双重处理，关键盘时残留高度不归零导致
       *  bottom 漂移。iOS 必须 padding（无 adjustResize 等价物）。 */
      behavior={Platform.select({ ios: 'padding', android: undefined })}
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
          iosSfSymbol={{ name: 'calendar', size: 16, color: colors.textSecondary }}
        >
          <Ionicons name="calendar-outline" size={22} color={colors.textSecondary} />
        </AnimatedCircleButton>
      </View>

      {/* 主列表 */}
      {taskLoading ? (
        <View style={[styles.centered, { paddingTop: headerHeight }]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>加载中...</Text>
        </View>
      ) : (
        <DraggableFlatList<ListRow>
          containerStyle={{ flex: 1 }}
          data={localTaskOrder}
          keyExtractor={(item) => item.id}
          onDragEnd={({ data }) => setLocalTaskOrder(data)}
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
           * 键盘弹起时 = 0（键盘自己占了底部空间，不再需要 safe-area inset）。 */
          kbSearchWrapStyle,
        ]}
      >
        <View style={styles.searchRow}>
          {IS_IOS_LIQUID_GLASS ? (
            <BouncyGlassCard
              style={[styles.searchInputBoxFlex, styles.searchInputBoxGlass]}
              cornerRadius={26}
              interactive
            >
              <Ionicons name="search" size={18} color={colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                placeholder="搜索任务或对话"
                placeholderTextColor={colors.placeholder}
                returnKeyType="search"
              />
            </BouncyGlassCard>
          ) : (
            <View style={[styles.searchInputBox, styles.searchInputBoxFlex]}>
              <Ionicons name="search" size={18} color={colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                placeholder="搜索任务或对话"
                placeholderTextColor={colors.placeholder}
                returnKeyType="search"
              />
            </View>
          )}
          <Fab ionicon="add" sfSymbol="plus" onPress={onCreateChat} />
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
    loadingText: { marginTop: 12, fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted },
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
    },
    sectionTitle: { fontSize: 14, fontWeight: '600', color: c.textSecondary },
    errorBar: { backgroundColor: c.errorBg, padding: 12, borderRadius: 8, marginBottom: 8 },
    errorText: { fontSize: 14, color: c.danger, textAlign: 'center' },
    taskEmpty: { paddingVertical: 32, alignItems: 'center' },
    taskEmptyText: {
      marginTop: 8,
      fontSize: TASK_FONT_SIZE_SMALL,
      color: c.placeholder,
    },
    /** 整列表横向缩进 22pt（footerWrap/headerWrap 原本各自 16；统一收到容器一级，让
     *  "今日 X 个任务"段头、各任务行、结束今天/新建任务行、"对话"段头与各 conv 行
     *  全部对齐到 x=22，跟顶栏左上角圆形汉堡按钮（x=16 起）左沿对齐 + 圆形视觉权重 ~6。
     *  ProjectScreen 同类列表为 20，这里略再深一档。 */
    listContent: { paddingHorizontal: 22, paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
    footerWrap: { paddingTop: 12 },
    taskActionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    endTodayBtn: {
      paddingHorizontal: 20,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderRadius: 20,
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
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    convRowMain: { flex: 1, minWidth: 0 },
    convRowTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    convRowText: { flex: 1, minWidth: 0, fontSize: 15, color: c.textPrimary, fontWeight: '500' },
    convRowMeta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
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
    /* 搜索 + FAB 单行：搜索拿 flex:1，FAB 紧贴右侧。alignItems: center 让两者垂直居中。 */
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    searchInputBoxFlex: { flex: 1 },
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
       paddingVertical 去掉——固定高度下 alignItems: center 已经把 icon + 输入框居中。 */
    searchInputBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.surface,
      ...shadowMenu,
    },
    /* iOS 26 glass 路径下的 search 卡片样式：保留 row + padding + gap，不要 bg/shadow
       —— 玻璃材质 + system 折光由 BouncyGlassCard 内部 UIVisualEffectView 提供。
       height: 52 跟 FAB 等高（cornerRadius: 26 在 BouncyGlassCard prop 上传）。 */
    searchInputBoxGlass: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      height: 52,
    },
    searchInput: { flex: 1, fontSize: 15, color: c.textPrimary, padding: 0 },
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

