/**
 * DocsHomeScreen
 *
 * Docs 标签的"一进就有文档已打开"主屏：
 *  - 顶部 ChatScreen 风格 header（BlurHeaderBackground + 两侧圆钮 + 居中标题）
 *  - 默认选中根 folder → 主区是 FolderView（folder 内容列表）
 *  - 选中 document → DocBodyView 渲染 FlowDocBlocks
 *  - 其它类型 → DocBodyView 内的"暂不支持"占位
 *  - 左缘右滑 / 点左钮 = 打开 sidebar；左滑 / 点 backdrop / 选中 item = 关闭
 *  - 右钮 = "更多"菜单，目前只放"复制为 Markdown"作示意
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { getFlowDocTree, type FlowDocTreeItem } from '../api';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { shadowCircleButtonThemed, shadowMenu } from '../theme/shadows';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { DocsSidebar } from './docs/DocsSidebar';
import { FolderView } from './docs/FolderView';
import { DocBodyView, type DocBodyViewHandle } from './docs/DocBodyView';

const SIDEBAR_WIDTH_RATIO = 0.78;
const SWIPE_OPEN_THRESHOLD = 60;
const SWIPE_CLOSE_THRESHOLD = 60;
const FOLDER_LIKE_TYPES = new Set(['folder', 'cooperateInbox']);

export function DocsHomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { width: winWidth } = useWindowDimensions();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const sidebarWidth = Math.round(winWidth * SIDEBAR_WIDTH_RATIO);

  /* tree 状态 */
  const [tree, setTree] = useState<FlowDocTreeItem[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeRefreshing, setTreeRefreshing] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  /* 当前选中的 item id（默认 = tree 里第一个根 folder） */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* 侧栏开合（Animated 控制 translateX + backdrop opacity） */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarAnim = useRef(new Animated.Value(0)).current; // 0 = closed, 1 = open
  const [optionsOpen, setOptionsOpen] = useState(false);

  const docBodyRef = useRef<DocBodyViewHandle | null>(null);

  /* 工具：以 id 索引 tree */
  const byId = useMemo(() => {
    const m = new Map<string, FlowDocTreeItem>();
    for (const it of tree) m.set(it.id, it);
    return m;
  }, [tree]);

  const selectedItem = selectedId ? byId.get(selectedId) || null : null;

  /* 选中 folder 时：根据 children id 列表挑出子项；id 在 tree 里找不到的容错跳过 */
  const selectedChildren = useMemo(() => {
    if (!selectedItem) return [];
    const ids = selectedItem.children ?? [];
    return ids
      .map((id) => byId.get(id))
      .filter((it): it is FlowDocTreeItem => it != null);
  }, [selectedItem, byId]);

  /* 拉 tree；isRefresh 控制 spinner 风格 */
  const loadTree = useCallback(
    async (isRefresh: boolean) => {
      if (!session) return;
      if (isRefresh) setTreeRefreshing(true);
      else setTreeLoading(true);
      setTreeError(null);
      try {
        const next = await getFlowDocTree(session);
        setTree(next);
        /* 首次拉到 / 当前 selectedId 失效 → 默认选根 folder（level=0 的第一个） */
        setSelectedId((cur) => {
          if (cur && next.some((it) => it.id === cur)) return cur;
          const root = next.find((it) => (it.level ?? 0) === 0) || next[0];
          return root ? root.id : null;
        });
      } catch (e) {
        setTreeError(e instanceof Error ? e.message : String(e));
      } finally {
        if (isRefresh) setTreeRefreshing(false);
        else setTreeLoading(false);
      }
    },
    [session],
  );

  useEffect(() => {
    loadTree(false);
  }, [loadTree]);

  /* 侧栏开合 → 动画 */
  useEffect(() => {
    Animated.spring(sidebarAnim, {
      toValue: sidebarOpen ? 1 : 0,
      useNativeDriver: true,
      friction: 9,
      tension: 70,
    }).start();
  }, [sidebarOpen, sidebarAnim]);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  /* 左缘 RNGH Pan：横向右滑超过阈值时打开 sidebar（参考 ConversationList → Profile） */
  const leftEdgeOpenGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(10)
        .failOffsetY([-24, 24])
        .onEnd((e) => {
          'worklet';
          if (e.translationX > SWIPE_OPEN_THRESHOLD) {
            runOnJS(openSidebar)();
          }
        }),
    [openSidebar],
  );

  /* 侧栏内部左滑关闭：PanResponder 比 RNGH 简单 + 不抢 ScrollView */
  const sidebarCloseResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        g.dx < -10 && Math.abs(g.dy) < 24,
      onPanResponderRelease: (_, g) => {
        if (g.dx < -SWIPE_CLOSE_THRESHOLD) closeSidebar();
      },
    }),
  ).current;

  /* 点 item：folder / cooperateInbox = 切主区到该文件夹；doc = 切主区到该文档；
     都自动关 sidebar */
  const onPickItem = useCallback(
    (item: FlowDocTreeItem) => {
      setSelectedId(item.id);
      closeSidebar();
    },
    [closeSidebar],
  );

  /* 顶部 header 标题：当前 item 名；没选中时给"文档" */
  const headerTitle =
    selectedItem?.name?.trim() ||
    (selectedItem?.type === 'folder' ? '未命名文件夹' : null) ||
    '文档';

  const isSelectedFolder = selectedItem
    ? FOLDER_LIKE_TYPES.has(selectedItem.type)
    : false;

  const onCopyMarkdown = useCallback(() => {
    setOptionsOpen(false);
    if (!docBodyRef.current) return;
    docBodyRef.current.copyMarkdown();
  }, []);

  const onReload = useCallback(() => {
    setOptionsOpen(false);
    if (selectedItem && !FOLDER_LIKE_TYPES.has(selectedItem.type)) {
      docBodyRef.current?.reload();
    } else {
      loadTree(true);
    }
  }, [selectedItem, loadTree]);

  /* "更多"按钮的彩蛋：长按 ≥ 3s 跳 SlateRNSpike 开发测试页；普通短按继续走切菜单 */
  const secretTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secretFiredRef = useRef(false);
  const onOptionsPressIn = useCallback(() => {
    secretFiredRef.current = false;
    if (secretTimerRef.current) clearTimeout(secretTimerRef.current);
    secretTimerRef.current = setTimeout(() => {
      secretFiredRef.current = true;
      navigation.navigate('SlateRNSpike');
    }, 3000);
  }, [navigation]);
  const onOptionsPressOut = useCallback(() => {
    if (secretTimerRef.current) {
      clearTimeout(secretTimerRef.current);
      secretTimerRef.current = null;
    }
  }, []);
  const onOptionsPress = useCallback(() => {
    if (secretFiredRef.current) return; // 已经跳走了，不再切菜单
    setOptionsOpen((v) => !v);
  }, []);
  useEffect(() => {
    return () => {
      if (secretTimerRef.current) clearTimeout(secretTimerRef.current);
    };
  }, []);

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  const sidebarTranslateX = sidebarAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-sidebarWidth, 0],
  });
  const backdropOpacity = sidebarAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.4],
  });

  if (!session) return null;

  return (
    <View style={styles.container}>
      {/* 主区（folder list 或 doc body）；顶部预留 header 高度 */}
      <View style={[styles.mainArea, { paddingTop: headerHeight }]}>
        {selectedItem == null ? (
          <View style={styles.centered}>
            <Text style={styles.placeholderText}>
              {treeLoading ? '加载中…' : treeError ? treeError : '暂无文档'}
            </Text>
          </View>
        ) : isSelectedFolder ? (
          <FolderView
            folder={selectedItem}
            items={selectedChildren}
            onSelect={(it) => setSelectedId(it.id)}
          />
        ) : (
          <DocBodyView
            ref={docBodyRef}
            docId={selectedItem.id}
            docType={selectedItem.type}
          />
        )}
      </View>

      {/* 顶部 header（绝对定位，跟 ChatScreen 一样浮在主区之上） */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={openSidebar}
          activeOpacity={0.7}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Ionicons name="menu-outline" size={26} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
            {headerTitle}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={onOptionsPress}
          onPressIn={onOptionsPressIn}
          onPressOut={onOptionsPressOut}
          activeOpacity={0.7}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          /* 关闭长按手势识别，避免系统的长按反馈打断我们自定义的 3s 计时 */
          delayLongPress={4000}
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={22}
            color={colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      {/* "更多"菜单（仅 document 类型时显示"复制为 Markdown"；folder 时显示"刷新文档树"） */}
      {optionsOpen ? (
        <>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOptionsOpen(false)}
          />
          <View
            style={[
              styles.optionsMenu,
              { top: insets.top + 8 + HEADER_CIRCLE_BTN_SIZE + 4, right: 16 },
            ]}
          >
            {selectedItem && !FOLDER_LIKE_TYPES.has(selectedItem.type) ? (
              <TouchableOpacity
                style={styles.optionsItem}
                onPress={onCopyMarkdown}
              >
                <Ionicons
                  name="copy-outline"
                  size={16}
                  color={colors.textPrimary}
                  style={styles.optionsIcon}
                />
                <Text style={styles.optionsItemText}>复制为 Markdown</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.optionsItem} onPress={onReload}>
              <Ionicons
                name="refresh"
                size={16}
                color={colors.textPrimary}
                style={styles.optionsIcon}
              />
              <Text style={styles.optionsItemText}>
                {selectedItem && !FOLDER_LIKE_TYPES.has(selectedItem.type)
                  ? '刷新文档'
                  : '刷新文档树'}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}

      {/* Backdrop（点击关闭）— 仅 sidebar 打开时可点 */}
      <Animated.View
        style={[
          styles.backdrop,
          {
            opacity: backdropOpacity,
            backgroundColor: colors.modalBackdrop,
          },
        ]}
        pointerEvents={sidebarOpen ? 'auto' : 'none'}
      >
        <TouchableWithoutFeedback onPress={closeSidebar}>
          <View style={StyleSheet.absoluteFill} />
        </TouchableWithoutFeedback>
      </Animated.View>

      {/* 侧栏：translateX 由动画驱动；内部左滑关闭由 PanResponder 处理 */}
      <Animated.View
        style={[
          styles.sidebar,
          {
            width: sidebarWidth,
            transform: [{ translateX: sidebarTranslateX }],
            paddingTop: insets.top,
          },
        ]}
        pointerEvents={sidebarOpen ? 'auto' : 'none'}
        {...sidebarCloseResponder.panHandlers}
      >
        <DocsSidebar
          items={tree}
          selectedId={selectedId}
          loading={treeLoading}
          refreshing={treeRefreshing}
          error={treeError}
          onRefresh={() => loadTree(true)}
          onSelect={onPickItem}
        />
      </Animated.View>

      {/* 左缘手势条：sidebar 关时接管打开手势；开了之后这块被 sidebar 覆盖不再相关 */}
      {!sidebarOpen ? (
        <GestureDetector gesture={leftEdgeOpenGesture}>
          <View style={styles.leftEdgeGesture} pointerEvents="box-only" />
        </GestureDetector>
      ) : null}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
    mainArea: { flex: 1 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    placeholderText: { color: c.placeholder, fontSize: 14 },
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
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
    headerTitleWrap: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
    headerTitle: {
      fontSize: TASK_FONT_SIZE_TITLE,
      fontWeight: '700',
      color: c.textHeader,
    },
    optionsMenu: {
      position: 'absolute',
      zIndex: 50,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 6,
      minWidth: 180,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
      ...shadowMenu,
    },
    optionsItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    optionsIcon: { marginRight: 10 },
    optionsItemText: { fontSize: 14, color: c.textPrimary },
    backdrop: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 20,
    },
    sidebar: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      zIndex: 30,
      backgroundColor: c.surface,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.borderMuted,
      ...(Platform.OS === 'android' ? { elevation: 24 } : null),
    },
    leftEdgeGesture: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: 24,
      zIndex: 5,
    },
  });
}
