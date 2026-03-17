import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Alert,
  PanResponder,
  Modal,
  Pressable,
  Platform,
  Vibration,
  useWindowDimensions,
} from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import Animated, { useSharedValue, runOnUI } from 'react-native-reanimated';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { listConversations, deleteConversation, type ConversationListItem } from '../api';
import type { RootStackParamList } from '../navigation/types';
import { shadowFab, borderLight, shadowMenu, shadowCircleButton } from '../theme/shadows';
import { LIST_PADDING_BOTTOM_WITH_FOOTER, HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { PullToRefreshRing } from '../components/PullToRefreshRing';

const EDGE_WIDTH = 24;
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
  const rootNav = navigation.getParent() as NavigationProp<RootStackParamList> | undefined;
  const [list, setList] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);

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
      setList(conversations ?? []);
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

  const gestureStartX = useRef(0);
  const leftEdgeOpenProfile = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10,
      onPanResponderGrant: (evt) => {
        gestureStartX.current = evt.nativeEvent.pageX;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (
          gestureState.dx > SWIPE_THRESHOLD &&
          gestureStartX.current <= EDGE_WIDTH + 20
        ) {
          (rootNav as NavigationProp<RootStackParamList> | undefined)?.navigate('Profile');
        }
      },
    })
  ).current;

  const onDeleteConversation = useCallback(
    (conv: ConversationListItem) => {
      if (!session) return;
      Alert.alert('删除对话', `确定要删除「${(conv.title && conv.title.trim()) || '新对话'}」吗？`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteConversation(session, conv.id);
              setList((prev) => prev.filter((c) => c.id !== conv.id));
            } catch (e) {
              Alert.alert('删除失败', e instanceof Error ? e.message : '请稍后重试');
            }
          },
        },
      ]);
    },
    [session]
  );

  if (!session) return null;

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;

  const renderItem = ({ item }: { item: ConversationListItem }) => (
    <TouchableOpacity
      style={styles.item}
      onPress={() => onPressItem(item)}
      onLongPress={() => onDeleteConversation(item)}
      activeOpacity={0.7}
    >
      <Text style={styles.itemTitle} numberOfLines={1}>
        {(item.title && item.title.trim()) || '新对话'}
      </Text>
      {item.updated_at ? (
        <Text style={styles.itemMeta} numberOfLines={1}>
          {formatTime(item.updated_at)}
        </Text>
      ) : null}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View
        style={styles.leftEdgeGesture}
        {...leftEdgeOpenProfile.panHandlers}
        pointerEvents="box-only"
      />
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <BlurHeaderBackground style={StyleSheet.absoluteFill} topSolidHeight={insets.top + 8} />
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={() => rootNav?.navigate('Profile')}
          activeOpacity={0.7}
        >
          <Ionicons name="person-outline" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={styles.topBarCenter} pointerEvents="none">
          <Text style={styles.topBarTitle}>对话</Text>
        </View>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={() => setMenuVisible(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="menu" size={24} color="#374151" />
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
              <Ionicons name="add-circle-outline" size={20} color="#374151" />
              <Text style={styles.menuItemText}>新建对话</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {loading && list.length === 0 ? (
        <View style={[styles.centered, { paddingTop: headerHeight }]}>
          <ActivityIndicator size="large" color="#0f172a" />
          <Text style={styles.loadingText}>加载中...</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={list}
          keyExtractor={(item) => item.id}
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
              <Ionicons name="chatbubbles-outline" size={64} color="#d1d5db" />
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
              colors={['#0f172a']}
              tintColor="#0f172a"
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
            color="#0f172a"
          />
        </View>
      ) : null}
      <TouchableOpacity style={styles.fab} onPress={onNewConversation} activeOpacity={0.85}>
        <Ionicons name="add" size={26} color="#111827" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  leftEdgeGesture: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: EDGE_WIDTH,
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
    backgroundColor: '#fff',
    ...shadowCircleButton,
  },
  topBarCenter: { alignItems: 'center', flex: 1 },
  topBarTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: '#0f172a' },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  menuPanel: {
    position: 'absolute',
    backgroundColor: '#fff',
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
  menuItemText: { fontSize: 16, color: '#111827' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 15, color: '#6b7280' },
  list: { flex: 1 },
  listContent: { paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
  emptyList: { flex: 1, paddingBottom: LIST_PADDING_BOTTOM_WITH_FOOTER },
  emptyWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#374151', marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: '#9ca3af', marginTop: 8 },
  item: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  itemTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
  itemMeta: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  footerHint: { fontSize: 12, color: '#9ca3af', textAlign: 'center', paddingVertical: 16 },
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
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...borderLight,
    ...shadowFab,
  },
});
