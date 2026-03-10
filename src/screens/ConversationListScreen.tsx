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
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { listConversations, deleteConversation, type ConversationListItem } from '../api';
import type { RootStackParamList } from '../navigation/types';

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
  const { session } = useSession();
  // 当前在 Main 的 Tab 里，要点进「具体聊天页」需用根 Stack 导航
  const rootNav = navigation.getParent();
  const [list, setList] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadList = useCallback(async (isRefresh = false) => {
    if (!session) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const { conversations } = await listConversations(session);
      setList(conversations ?? []);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

  React.useEffect(() => {
    loadList();
  }, [loadList]);

  const onRefresh = useCallback(() => loadList(true), [loadList]);

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
    (rootNav as NavigationProp<RootStackParamList> | undefined)?.navigate('Chat', undefined);
  }, [rootNav]);

  const swipeableRefs = useRef<Map<string, Swipeable | null>>(new Map());

  const onDeleteConversation = useCallback(
    async (conv: ConversationListItem) => {
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

  const renderLeftActions = useCallback(() => (
    <View style={styles.leftActions}>
      <View style={styles.leftActionBtn}>
        <Ionicons name="ellipsis-horizontal" size={20} color="#6b7280" />
        <Text style={styles.leftActionText}>更多</Text>
      </View>
    </View>
  ), []);

  if (!session) return null;

  const renderItem = ({ item }: { item: ConversationListItem }) => (
    <Swipeable
      ref={(ref) => {
        if (ref) swipeableRefs.current.set(item.id, ref);
        else swipeableRefs.current.delete(item.id);
      }}
      renderLeftActions={renderLeftActions}
      renderRightActions={() => (
        <TouchableOpacity
          style={styles.rightActions}
          onPress={() => onDeleteConversation(item)}
          activeOpacity={0.9}
        >
          <Ionicons name="trash-outline" size={22} color="#fff" />
          <Text style={styles.rightActionText}>删除</Text>
        </TouchableOpacity>
      )}
      friction={2}
      rightThreshold={80}
      leftThreshold={80}
    >
      <TouchableOpacity
        style={styles.item}
        onPress={() => onPressItem(item)}
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
    </Swipeable>
  );

  return (
    <View style={styles.container}>
      {loading && list.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#0f172a" />
          <Text style={styles.loadingText}>加载中...</Text>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={list.length === 0 ? styles.emptyList : styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="chatbubbles-outline" size={64} color="#d1d5db" />
              <Text style={styles.emptyTitle}>暂无历史对话</Text>
              <Text style={styles.emptySubtitle}>点击下方「新对话」开始</Text>
            </View>
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#0f172a']} />
          }
        />
      )}
      <TouchableOpacity style={styles.fab} onPress={onNewConversation} activeOpacity={0.85}>
        <Ionicons name="add" size={26} color="#111827" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 15, color: '#6b7280' },
  listContent: { paddingBottom: 100 },
  emptyList: { flex: 1, paddingBottom: 100 },
  emptyWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#374151', marginTop: 16 },
  emptySubtitle: { fontSize: 14, color: '#9ca3af', marginTop: 8 },
  leftActions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#f3f4f6',
    justifyContent: 'flex-end',
    minWidth: 88,
  },
  leftActionBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    gap: 4,
  },
  leftActionText: { fontSize: 14, color: '#6b7280' },
  rightActions: {
    backgroundColor: '#dc2626',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    minWidth: 88,
    gap: 4,
  },
  rightActionText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  item: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  itemTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
  itemMeta: { fontSize: 13, color: '#6b7280', marginTop: 4 },
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 2,
    elevation: 2,
    borderWidth: 0.5,
    borderColor: 'rgba(0,0,0,0.08)',
  },
});
