import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Alert,
  Modal,
  Pressable,
  Platform,
  Vibration,
  useWindowDimensions,
} from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue, runOnUI, runOnJS } from 'react-native-reanimated';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import {
  listConversations,
  deleteConversation,
  runInboxStream,
  type ConversationListItem,
} from '../api';
import type { RootStackParamList } from '../navigation/types';
import { shadowFabThemed, shadowMenu, shadowCircleButtonThemed } from '../theme/shadows';
import { LIST_PADDING_BOTTOM_WITH_FOOTER, HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { PullToRefreshRing } from '../components/PullToRefreshRing';
import { InboxRunSpinner, InboxUnreadCheck } from '../components/InboxListIndicators';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

/** iOS 左缘条宽度；Android 略加宽便于在系统返回热区内抢到手势 */
const EDGE_WIDTH = 24;
const LEFT_EDGE_STRIP_WIDTH = Platform.OS === 'android' ? 40 : EDGE_WIDTH;
const PULL_RING_THRESHOLD = 125;
const SWIPE_THRESHOLD = 60;

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return isoString;
  }
}

export function ConversationListScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createConversationListStyles(colors), [colors]);
  const rootNav = navigation.getParent() as NavigationProp<RootStackParamList> | undefined;
  const [list, setList] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [deleteConvTarget, setDeleteConvTarget] = useState<ConversationListItem | null>(null);
  /** 与 Web 侧栏一致：GET /conversations 的 chat_v2_running + inbox/stream SSE */
  const [chatV2RunningByConv, setChatV2RunningByConv] = useState<Record<string, boolean>>({});
  const [chatV2UnreadByConv, setChatV2UnreadByConv] = useState<Record<string, boolean>>({});

  const pullDistanceShared = useSharedValue(0);
  const refreshingShared = useSharedValue(false);

  React.useEffect(() => {
    refreshingShared.value = refreshing;
  }, [refreshing, refreshingShared]);

  const MIN_REFRESH_DURATION_MS = 1000;
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async (isRefresh = false) => {
    if (!session) return;
    const startedAt = isRefresh ? Date.now() : 0;
    if (isRefresh) {
      setRefreshing(true);
      if (Platform.OS === 'android') {
        Vibration.vibrate(15);
      } else {
        ReactNativeHapticFeedback.trigger('impactHeavy', { enableVibrateFallback: true });
      }
    } else {
      setLoading(true);
    }
    try {
      const { conversations } = await listConversations(session);
      const rows = conversations ?? [];
      setList(rows);
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
      setList([]);
    } finally {
      setLoading(false);
      if (isRefresh) {
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
    }
  }, [session]);

  React.useEffect(() => () => {
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
  }, []);

  React.useEffect(() => {
    loadList();
  }, [loadList]);

  React.useEffect(() => {
    if (!session) return undefined;
    const ac = new AbortController();
    let cancelled = false;
    const pump = async () => {
      try {
        await runInboxStream(session, ac.signal, (msg) => {
          if (cancelled) return;
          const type = msg.type;
          if (type === 'inbox_snapshot' && msg.running && typeof msg.running === 'object') {
            setChatV2RunningByConv(
              Object.fromEntries(
                Object.entries(msg.running as Record<string, unknown>).filter(([, v]) => v === true)
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
                Object.entries(msg.unread as Record<string, unknown>).filter(([, v]) => v === true)
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
          /* 断线后无自动重连；用户下拉刷新列表会同步 running 标记 */
        }
      }
    };
    pump();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [session]);

  const onRefresh = useCallback(() => loadList(true), [loadList]);

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

  const onPressItem = useCallback(
    (conv: ConversationListItem) => {
      (rootNav as NavigationProp<RootStackParamList> | undefined)?.navigate('Chat', {
        conversationId: conv.id,
        conversationTitle: (conv.title && conv.title.trim()) || '新对话',
      });
    },
    [rootNav]
  );

  const onNewConversation = useCallback(() => {
    setMenuVisible(false);
    rootNav?.navigate('Chat', undefined);
  }, [rootNav]);

  const openProfileFromLeftEdge = useCallback(() => {
    (rootNav as NavigationProp<RootStackParamList> | undefined)?.navigate('Profile');
  }, [rootNav]);

  /** 仅左缘条接收手势：在此区域内右滑即等价于「从左缘滑入」；用 RNGH 减轻与 Android 系统返回争用 */
  const leftEdgeOpenProfileGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(10)
        .failOffsetY([-24, 24])
        .onEnd((e) => {
          'worklet';
          if (e.translationX > SWIPE_THRESHOLD) {
            runOnJS(openProfileFromLeftEdge)();
          }
        }),
    [openProfileFromLeftEdge]
  );

  const closeDeleteConvModal = useCallback(() => setDeleteConvTarget(null), []);

  const confirmDeleteConversation = useCallback(async () => {
    if (!session || !deleteConvTarget) return;
    const conv = deleteConvTarget;
    setDeleteConvTarget(null);
    try {
      await deleteConversation(session, conv.id);
      setList((prev) => prev.filter((c) => c.id !== conv.id));
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

  const onDeleteConversation = useCallback((conv: ConversationListItem) => {
    setDeleteConvTarget(conv);
  }, []);

  if (!session) return null;

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;

  const renderItem = ({ item }: { item: ConversationListItem }) => (
    <TouchableOpacity
      style={styles.item}
      onPress={() => onPressItem(item)}
      onLongPress={() => onDeleteConversation(item)}
      activeOpacity={0.7}
    >
      <View style={styles.itemTitleRow}>
        <Text style={styles.itemTitle} numberOfLines={1}>
          {(item.title && item.title.trim()) || '新对话'}
        </Text>
        {chatV2RunningByConv[item.id] ? (
          <InboxRunSpinner />
        ) : chatV2UnreadByConv[item.id] ? (
          <InboxUnreadCheck />
        ) : null}
      </View>
      {item.updated_at ? (
        <Text style={styles.itemMeta} numberOfLines={1}>
          {formatTime(item.updated_at)}
        </Text>
      ) : null}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <GestureDetector gesture={leftEdgeOpenProfileGesture}>
        <View
          style={[styles.leftEdgeGesture, { width: LEFT_EDGE_STRIP_WIDTH }]}
          pointerEvents="box-only"
          collapsable={false}
        />
      </GestureDetector>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.conversationListBackground}
        />
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={() => rootNav?.navigate('Profile')}
          activeOpacity={0.7}
        >
          <Ionicons name="person-outline" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.topBarCenter} pointerEvents="none">
          <Text style={styles.topBarTitle}>对话</Text>
        </View>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={() => setMenuVisible(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="menu" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <Pressable style={styles.menuOverlay} onPress={() => setMenuVisible(false)}>
          <View
            style={[
              styles.menuPanel,
              {
                top: insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE + 8,
                right: 16,
                minWidth: Math.min(winWidth * 0.5, 200),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <TouchableOpacity
              style={styles.menuItem}
              onPress={onNewConversation}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={20} color={colors.textSecondary} />
              <Text style={styles.menuItemText}>新建对话</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <Modal
        visible={deleteConvTarget != null}
        transparent
        animationType="fade"
        onRequestClose={closeDeleteConvModal}
      >
        <Pressable style={styles.menuOverlay} onPress={closeDeleteConvModal}>
          <View style={styles.deleteModalCenter} pointerEvents="box-none">
            <View style={styles.deleteModalCard} onStartShouldSetResponder={() => true}>
              <Text style={styles.deleteModalTitle}>删除对话</Text>
              <Text style={styles.deleteModalBody}>
                确定要删除「
                {(deleteConvTarget?.title && deleteConvTarget.title.trim()) || '新对话'}」吗？
              </Text>
              <View style={styles.deleteModalActions}>
                <TouchableOpacity
                  style={[styles.deleteModalBtn, styles.deleteModalBtnCancel]}
                  onPress={closeDeleteConvModal}
                  activeOpacity={0.75}
                >
                  <Text style={styles.deleteModalBtnCancelText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.deleteModalBtn, styles.deleteModalBtnDanger]}
                  onPress={confirmDeleteConversation}
                  activeOpacity={0.75}
                >
                  <Text style={styles.deleteModalBtnDangerText}>删除</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Pressable>
      </Modal>

      {loading && list.length === 0 ? (
        <View style={[styles.centered, { paddingTop: headerHeight }]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>加载中...</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={list}
          keyExtractor={(item) => item.id}
          extraData={{ chatV2RunningByConv, chatV2UnreadByConv }}
          renderItem={renderItem}
          onScroll={Platform.OS === 'ios' ? handleScroll : undefined}
          scrollEventThrottle={16}
          contentContainerStyle={
            list.length === 0
              ? [styles.emptyList, { paddingTop: headerHeight, paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER }]
              : [styles.listContent, { paddingTop: headerHeight }]
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="chatbubbles-outline" size={64} color={colors.border} />
              <Text style={styles.emptyTitle}>暂无历史对话</Text>
              <Text style={styles.emptySubtitle}>点击下方「新对话」开始</Text>
            </View>
          }
          ListFooterComponent={
            list.length > 0 ? (
              <Text style={styles.footerHint}>下拉刷新 · 长按删除</Text>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
              tintColor={colors.primary}
              progressViewOffset={Platform.OS === 'android' ? headerHeight : undefined}
            />
          }
        />
      )}
      {Platform.OS === 'ios' ? (
        <View style={[styles.refreshIndicatorFixed, { top: headerHeight }]} pointerEvents="none">
          <PullToRefreshRing
            pullDistance={pullDistanceShared}
            refreshing={refreshingShared}
            threshold={PULL_RING_THRESHOLD}
            refreshingState={refreshing}
            color={colors.primary}
          />
        </View>
      ) : null}
      <TouchableOpacity style={styles.fab} onPress={onNewConversation} activeOpacity={0.85}>
        <Ionicons name="add" size={26} color={colors.textPrimary} />
      </TouchableOpacity>
    </View>
  );
}

function createConversationListStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.conversationListBackground },
    leftEdgeGesture: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      zIndex: 10,
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
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
    topBarCenter: { alignItems: 'center', flex: 1 },
    topBarTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: c.textHeader },
    menuOverlay: { flex: 1, backgroundColor: c.modalBackdrop },
    deleteModalCenter: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    deleteModalCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 20,
      width: '100%',
      maxWidth: 340,
      borderWidth: 1,
      borderColor: c.borderMuted,
      ...shadowMenu,
    },
    deleteModalTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader, marginBottom: 8 },
    deleteModalBody: { fontSize: 15, color: c.textSecondary, lineHeight: 22, marginBottom: 20 },
    deleteModalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
    deleteModalBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
    deleteModalBtnCancel: { backgroundColor: c.surfaceMuted },
    deleteModalBtnDanger: { backgroundColor: c.roseBg },
    deleteModalBtnCancelText: { fontSize: 16, color: c.textPrimary },
    deleteModalBtnDangerText: { fontSize: 16, fontWeight: '600', color: c.danger },
    menuPanel: {
      position: 'absolute',
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 8,
      ...shadowMenu,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 16,
    },
    menuItemText: { fontSize: 16, color: c.textPrimary },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    loadingText: { marginTop: 12, fontSize: 15, color: c.textMuted },
    list: { flex: 1, backgroundColor: c.conversationListBackground },
    listContent: { paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
    emptyList: { flex: 1, paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
    emptyWrap: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 60,
    },
    emptyTitle: { fontSize: 18, fontWeight: '600', color: c.textSecondary, marginTop: 16 },
    emptySubtitle: { fontSize: 14, color: c.placeholder, marginTop: 8 },
    item: {
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.conversationListSeparator,
    },
    itemTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    itemTitle: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: '600', color: c.textPrimary },
    itemMeta: { fontSize: 13, color: c.textMuted, marginTop: 4 },
    footerHint: { fontSize: 12, color: c.placeholder, textAlign: 'center', paddingVertical: 16 },
    refreshIndicatorFixed: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      zIndex: 9,
    },
    fab: {
      position: 'absolute',
      right: 20,
      bottom: 24,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
      ...shadowFabThemed(c),
    },
  });
}
