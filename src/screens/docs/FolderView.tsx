/**
 * FolderView
 *
 * 文件夹页：顶部大 folder icon + 标题，下面是该文件夹的直接子项列表。
 * 对齐 web 版 src/tree/FolderView.jsx 的视觉与点击语义。
 * 子项 click 通过 props 上抛给 DocsHomeScreen 做主区切换。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { FlowDocTreeItem } from '../../api';

const FOLDER_LIKE_TYPES = new Set(['folder', 'cooperateInbox']);

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
    case 'document':
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

export type FolderViewProps = {
  folder: FlowDocTreeItem;
  /** 该 folder 的直接子项（由 caller 从 tree 里筛出来传进来） */
  items: FlowDocTreeItem[];
  onSelect: (item: FlowDocTreeItem) => void;
};

export function FolderView({ folder, items, onSelect }: FolderViewProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.titleRow}>
        <Ionicons
          name="folder-outline"
          size={28}
          color={colors.textPrimary}
          style={styles.titleIcon}
        />
        <Text style={styles.title} numberOfLines={2}>
          {folder.name?.trim() || defaultNameFor(folder.type)}
        </Text>
      </View>

      {items.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>此文件夹为空</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {items.map((child) => (
            <TouchableOpacity
              key={child.id}
              activeOpacity={0.6}
              style={styles.itemRow}
              onPress={() => onSelect(child)}
            >
              <Ionicons
                name={iconNameFor(child.type)}
                size={18}
                color={
                  FOLDER_LIKE_TYPES.has(child.type)
                    ? colors.textMuted
                    : colors.textPrimary
                }
                style={styles.itemIcon}
              />
              <Text style={styles.itemTitle} numberOfLines={1}>
                {child.name?.trim() || defaultNameFor(child.type)}
              </Text>
              {child.accessRole === 'collaborator' && child.ownerNickname ? (
                <Text style={styles.itemOwner} numberOfLines={1}>
                  · {child.ownerNickname}
                </Text>
              ) : null}
              <Ionicons
                name="chevron-forward"
                size={16}
                color={colors.placeholder}
                style={styles.itemChevron}
              />
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 80,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 18,
    },
    titleIcon: { marginRight: 10 },
    title: {
      flex: 1,
      fontSize: 22,
      fontWeight: '700',
      color: c.textHeader,
    },
    list: {},
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    itemIcon: { marginRight: 12 },
    itemTitle: {
      flex: 1,
      fontSize: 15,
      color: c.textPrimary,
    },
    itemOwner: {
      marginLeft: 8,
      maxWidth: 120,
      fontSize: 12,
      color: c.textMuted,
    },
    itemChevron: { marginLeft: 6 },
    emptyBox: {
      paddingTop: 48,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: c.placeholder,
    },
  });
}
