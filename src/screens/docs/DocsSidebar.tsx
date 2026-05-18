/**
 * DocsSidebar
 *
 * FlowDoc 文档树侧栏。后端返回的是「DFS 顺序扁平 + level 字段」的列表，本组件按
 * 折叠状态过滤后扁平展示。文件夹支持 chevron 展开/收起；文档点击 = onSelect。
 *
 * 视觉上对齐 ConversationListScreen 的列表风格（细分割线、左对齐 icon + 名）。
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { FlowDocTreeItem } from '../../api';

const INDENT_PX = 14;

function iconNameFor(type: string): string {
  switch (type) {
    case 'folder':
    case 'cooperateInbox':
      return 'folder-outline';
    case 'transcription':
      return 'chatbubbles-outline';
    case 'webpage':
      return 'globe-outline';
    case 'paper':
      return 'document-attach-outline';
    default:
      return 'document-text-outline';
  }
}

function defaultNameFor(type: string): string {
  switch (type) {
    case 'folder':
      return '未命名文件夹';
    case 'cooperateInbox':
      return '协作收件箱';
    case 'transcription':
      return '未命名会议听写';
    case 'paper':
      return '未命名 PDF 论文';
    default:
      return '未命名文档';
  }
}

export type DocsSidebarProps = {
  /** 文档树扁平列表，每项带 level（由后端 traverse 时算好） */
  items: FlowDocTreeItem[];
  /** 当前主区在看的 item id；用于高亮 */
  selectedId: string | null;
  /** 列表加载中（首次） */
  loading: boolean;
  /** 顶部刷新中 */
  refreshing: boolean;
  /** 顶部错误信息（拉失败时显示） */
  error: string | null;
  onRefresh: () => void;
  onSelect: (item: FlowDocTreeItem) => void;
};

export function DocsSidebar({
  items,
  selectedId,
  loading,
  refreshing,
  error,
  onRefresh,
  onSelect,
}: DocsSidebarProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  /** 折叠的文件夹底下的所有后代都不显示。后端给的是 DFS 顺序 + level，
   *  一遇到 collapsed folder（level=L），跳过后续 level>L 的项；下一次 level<=L 时恢复显示。 */
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
      const isSelected = selectedId === item.id;
      return (
        <TouchableOpacity
          activeOpacity={0.6}
          style={[
            styles.row,
            { paddingLeft: 12 + level * INDENT_PX },
            isSelected && styles.rowSelected,
          ]}
          onPress={() => onSelect(item)}
        >
          {isFolder ? (
            <TouchableOpacity
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              onPress={() => setCollapsed((p) => ({ ...p, [item.id]: !p[item.id] }))}
              style={styles.chevronBtn}
            >
              <Ionicons
                name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
                size={14}
                color={colors.textMuted}
              />
            </TouchableOpacity>
          ) : (
            <View style={styles.chevronBtn} />
          )}
          <Ionicons
            name={iconNameFor(item.type)}
            size={16}
            color={isFolder ? colors.textMuted : colors.textPrimary}
            style={styles.itemIcon}
          />
          <Text
            style={[styles.itemName, isSelected && styles.itemNameSelected]}
            numberOfLines={1}
          >
            {item.name?.trim() || defaultNameFor(item.type)}
          </Text>
        </TouchableOpacity>
      );
    },
    [collapsed, colors.textMuted, colors.textPrimary, onSelect, selectedId, styles],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>文档</Text>
      </View>
      {loading && items.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={onRefresh}>
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
              onRefresh={onRefresh}
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
    container: { flex: 1, backgroundColor: c.surface },
    header: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderMuted,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textHeader,
    },
    listContent: { paddingTop: 4, paddingBottom: 64 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingRight: 12,
    },
    rowSelected: {
      backgroundColor: c.surfaceMuted,
    },
    chevronBtn: {
      width: 18,
      height: 18,
      marginRight: 4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    itemIcon: { marginRight: 8 },
    itemName: {
      flex: 1,
      fontSize: 14,
      color: c.textPrimary,
    },
    itemNameSelected: { fontWeight: '600' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyBox: { paddingTop: 48, alignItems: 'center' },
    emptyText: { color: c.placeholder, fontSize: 13 },
    errorText: {
      color: c.placeholder,
      fontSize: 12,
      marginBottom: 10,
      textAlign: 'center',
      paddingHorizontal: 20,
    },
    retryBtn: {
      paddingVertical: 6,
      paddingHorizontal: 16,
      borderRadius: 14,
      backgroundColor: c.surfaceMuted,
    },
    retryText: { fontSize: 12, color: c.textPrimary },
  });
}
