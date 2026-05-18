/**
 * DocsListScreen
 *
 * Docs 标签首页：拉 FlowDoc 树（GET /api/flowdoc/tx/tree），按 level 展示成扁平缩进列表。
 * 文件夹只展示标题（点击暂不展开/收起 v1），文档点击进入 DocViewer。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { getFlowDocTree, type FlowDocTreeItem } from '../api';
import type { DocsStackParamList } from '../navigation/types';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

type Nav = StackNavigationProp<DocsStackParamList, 'DocsList'>;

const INDENT_PX = 16;

export function DocsListScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [items, setItems] = useState<FlowDocTreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (!session) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const tree = await getFlowDocTree(session);
        setItems(tree);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [session],
  );

  useFocusEffect(
    useCallback(() => {
      if (items.length === 0) load(false);
    }, [items.length, load]),
  );

  useEffect(() => {
    if (!session) return;
    load(false);
  }, [session, load]);

  /** 过滤掉折叠节点底下的所有后代（包括嵌套折叠的）：扁平列表上按 level 算 */
  const visibleItems = useMemo(() => {
    const out: FlowDocTreeItem[] = [];
    let hideUntilLevelAtOrBelow: number | null = null;
    for (const it of items) {
      const level = it.level ?? 0;
      if (hideUntilLevelAtOrBelow != null) {
        if (level > hideUntilLevelAtOrBelow) continue;
        hideUntilLevelAtOrBelow = null;
      }
      out.push(it);
      const isFolder = it.type === 'folder' || it.type === 'cooperateInbox';
      if (isFolder && collapsed[it.id]) {
        hideUntilLevelAtOrBelow = level;
      }
    }
    return out;
  }, [items, collapsed]);

  const renderItem = useCallback(
    ({ item }: { item: FlowDocTreeItem }) => {
      const level = item.level ?? 0;
      const isFolder = item.type === 'folder' || item.type === 'cooperateInbox';
      const isCollapsed = collapsed[item.id];
      const onPress = () => {
        if (isFolder) {
          setCollapsed((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
          return;
        }
        navigation.navigate('DocViewer', {
          docId: item.id,
          docName: item.name || '',
        });
      };
      return (
        <TouchableOpacity
          activeOpacity={0.6}
          style={[styles.row, { paddingLeft: 16 + level * INDENT_PX }]}
          onPress={onPress}
        >
          {isFolder ? (
            <Ionicons
              name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
              size={14}
              color={colors.textMuted}
              style={styles.chevron}
            />
          ) : (
            <View style={styles.chevron} />
          )}
          <Ionicons
            name={isFolder ? 'folder-outline' : 'document-text-outline'}
            size={18}
            color={isFolder ? colors.textMuted : colors.textPrimary}
            style={styles.itemIcon}
          />
          <Text style={styles.itemName} numberOfLines={1}>
            {item.name?.trim() || (isFolder ? '未命名文件夹' : '未命名文档')}
          </Text>
          {item.accessRole === 'collaborator' ? (
            <Text style={styles.shareTag} numberOfLines={1}>
              {item.ownerNickname ? `· ${item.ownerNickname}` : '· 共享'}
            </Text>
          ) : null}
        </TouchableOpacity>
      );
    },
    [collapsed, colors.textMuted, colors.textPrimary, navigation, styles],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Docs</Text>
        <TouchableOpacity
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          onPress={() => load(true)}
        >
          <Ionicons name="refresh" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load(false)}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={visibleItems}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={colors.textMuted}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>暂无文档</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 12,
    },
    title: {
      fontSize: 22,
      fontWeight: '700',
      color: c.textHeader,
    },
    listContent: {
      paddingBottom: 96,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingRight: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    chevron: {
      width: 16,
      marginRight: 6,
    },
    itemIcon: { marginRight: 10 },
    itemName: {
      flex: 1,
      fontSize: 15,
      color: c.textPrimary,
    },
    shareTag: {
      marginLeft: 8,
      maxWidth: 120,
      fontSize: 12,
      color: c.textMuted,
    },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyBox: { paddingTop: 64, alignItems: 'center' },
    emptyText: { color: c.placeholder, fontSize: 14 },
    errorText: { color: c.placeholder, fontSize: 13, marginBottom: 12, textAlign: 'center', paddingHorizontal: 24 },
    retryBtn: {
      paddingVertical: 6,
      paddingHorizontal: 18,
      borderRadius: 14,
      backgroundColor: c.surfaceMuted,
    },
    retryText: { fontSize: 13, color: c.textPrimary },
  });
}
