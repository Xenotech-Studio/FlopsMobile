/**
 * DocsSidebar
 *
 * FlowDoc 文档树侧栏。后端返回的是「DFS 顺序扁平 + level 字段」的列表，本组件按
 * 折叠状态过滤后扁平展示。文件夹支持 chevron 展开/收起；文档点击 = onSelect。
 *
 * 视觉上对齐 ConversationListScreen 的列表风格（细分割线、左对齐 icon + 名）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { FlowDocTreeItem } from '../../api';
import { LIST_ROW_TITLE_SIZE } from '../../theme/typography';
import { DocTreeIcon, getDocTreeGlyph } from './DocTreeIcons';

const INDENT_PX = 14;
/* 行内点击分界几何：箭头左缩进 + chevron 宽 + 「箭头→类型图标」空档(GAP)。
 * 点击分界取空档中点：中点往左(含箭头)=折叠展开，往右(含类型图标+名字)=选中/打开。 */
const ARROW_PAD_LEFT = 10; // 箭头左缩进（与原 chevronBox 居中时的箭头位置一致，不移动箭头）
const ARROW_W = 14; // chevron 图标宽
const GAP = 8; // 箭头右缘 → 类型图标 的空档；调这个改间距，分界自动取其中点
const ICON_LEFT = ARROW_PAD_LEFT + ARROW_W + GAP; // 类型图标左缘（相对行内缩进起点）
const ROW_MARGIN_H = 8; // 行左右内缩（选中高亮不贯穿两边）；折叠触摸区左 hitSlop 据此延伸到屏幕左缘
/** 文档树展开状态本地缓存 key（只存 expanded=true 的文件夹 id，默认全折叠）。 */
const EXPANDED_STORAGE_KEY = 'docsTreeExpandedV1';

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

type DocTreeRowProps = {
  item: FlowDocTreeItem;
  isExpanded: boolean;
  isSelected: boolean;
  colors: AppColors;
  styles: ReturnType<typeof createStyles>;
  selectedBg: string;
  /** 折叠/展开按下时的短暂背景变暗色（触摸反馈）。 */
  pressedBg: string;
  /** dismiss 进度驱动选中高亮淡出：卡片位移 tx 在 [dismissFrom, dismissTo]（半开位→屏外）时 opacity 1→0。
   *  iPad 不传 selectionTx → 高亮恒亮（无抽屉式 dismiss）。 */
  selectionTx?: SharedValue<number>;
  dismissFrom: number;
  dismissTo: number;
  onToggle: (id: string, level: number) => void;
  onSelect: (item: FlowDocTreeItem) => void;
};

/** 单行（抽成组件以便用 useAnimatedStyle 让选中高亮背景随 dismiss 进度淡出）。 */
const DocTreeRow = React.memo(function DocTreeRow({
  item,
  isExpanded,
  isSelected,
  colors,
  styles,
  selectedBg,
  pressedBg,
  selectionTx,
  dismissFrom,
  dismissTo,
  onToggle,
  onSelect,
}: DocTreeRowProps) {
  const level = item.level ?? 0;
  /* 缩进按「去掉根目录这一层」算：原 level 1（顶层内容）→ 0 不缩进。 */
  const indentLevel = Math.max(0, level - 1);
  /* toggleZone 左缘到屏幕左缘的距离（行内缩进起点 = row 左边距 + 缩进）。
   *  折叠区用 marginLeft:-baseLeft 真正延伸到屏幕边缘，paddingLeft 补回让箭头位置不变（不靠 hitSlop 跨父）。 */
  const baseLeft = ROW_MARGIN_H + indentLevel * INDENT_PX;
  const isFolder = item.type === 'folder' || item.type === 'cooperateInbox';
  const hasChildren = (item.children?.length ?? 0) > 0;
  const isEmpty = item.isEmpty !== false;
  /* 可展开 = 文件夹 或 有子项的文档（文档也带箭头、能折叠，默认折叠）。 */
  const canExpand = isFolder || hasChildren;
  const iconColor = isFolder ? colors.textMuted : colors.textPrimary;
  /* 类型图标：有自定义 SVG 用 DocTreeIcon，否则（transcription/webpage/paper）回退 Ionicons。 */
  const typeIcon = getDocTreeGlyph(item.type, hasChildren, isExpanded, isEmpty) ? (
    <DocTreeIcon
      type={item.type}
      hasChildren={hasChildren}
      isExpanded={isExpanded}
      isEmpty={isEmpty}
      size={16}
      color={iconColor}
      style={styles.itemIcon}
    />
  ) : (
    <Ionicons
      name={iconNameFor(item.type)}
      size={16}
      color={iconColor}
      style={styles.itemIcon}
    />
  );
  const nameText = (
    <Text style={styles.itemName} numberOfLines={1}>
      {item.name?.trim() || defaultNameFor(item.type)}
    </Text>
  );

  /* 选中高亮背景层 opacity：dismiss（tx 从 from→to）时 1→0，衔接关闭后无选中；无 tx 恒亮。 */
  const highlightStyle = useAnimatedStyle(() => {
    if (!selectionTx) return { opacity: 1 };
    const span = dismissTo - dismissFrom;
    const p =
      span > 0
        ? Math.min(1, Math.max(0, (selectionTx.value - dismissFrom) / span))
        : 0;
    return { opacity: 1 - p };
  });

  /* 高亮 = 独立背景层（在 touchable 之下、pointerEvents none 不挡点击），只它做 opacity 渐隐，不影响内容。 */
  const highlight = isSelected ? (
    <Animated.View
      pointerEvents="none"
      style={[styles.rowSelectedBg, { backgroundColor: selectedBg }, highlightStyle]}
    />
  ) : null;

  /* 文件夹/有子文档：「箭头 + 左半空档」=折叠区，「右半空档 + 图标 + 名字」=选中区（点击分界在空档中点）。
     无子项：整行=选中区。两区并列独立 touchable（不嵌套）。 */
  if (canExpand) {
    return (
      <View style={[styles.row, { paddingLeft: indentLevel * INDENT_PX }]}>
        {highlight}
        <Pressable
          /* 上下 hitSlop 补到接近行高；左右不需要——toggleZone 自身已真实延伸到屏幕左缘。 */
          hitSlop={{ top: 12, bottom: 12, left: 0, right: 0 }}
          onPress={() => onToggle(item.id, level)}
          /* marginLeft:-baseLeft 让折叠区左缘真正到屏幕边缘；paddingLeft 补回 baseLeft 让箭头位置不变。 */
          style={[
            styles.toggleZone,
            { marginLeft: -baseLeft, paddingLeft: baseLeft + ARROW_PAD_LEFT },
          ]}
        >
          {({ pressed }) => (
            <>
              {/* 变暗块：左缘内缩到箭头附近（不随触摸区延伸到屏幕左缘），只它做按下反馈。 */}
              <View
                pointerEvents="none"
                style={[
                  styles.togglePressBg,
                  { left: baseLeft + ARROW_PAD_LEFT - 4 },
                  pressed && { backgroundColor: pressedBg },
                ]}
              />
              <Ionicons
                name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                size={ARROW_W}
                color={colors.textMuted}
              />
            </>
          )}
        </Pressable>
        <TouchableOpacity
          activeOpacity={0.6}
          style={styles.selectZone}
          onPress={() => onSelect(item)}
        >
          {typeIcon}
          {nameText}
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={[styles.row, { paddingLeft: indentLevel * INDENT_PX }]}>
      {highlight}
      <TouchableOpacity
        activeOpacity={0.6}
        style={styles.rowSelectZone}
        onPress={() => onSelect(item)}
      >
        {typeIcon}
        {nameText}
      </TouchableOpacity>
    </View>
  );
});

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
  /** 容器背景色覆盖。默认 surface（iPad 侧栏）；手机端传 'transparent' 让目录只由最底层背景供色（单层）。 */
  backgroundColor?: string;
  /** 抽屉式 dismiss 进度：卡片位移 tx 在 [dismissFrom,dismissTo]（半开位→屏外）时选中高亮 1→0 渐隐。
   *  手机端传（衔接关闭后无选中）；iPad 不传 → 高亮恒亮。 */
  selectionTx?: SharedValue<number>;
  dismissFrom?: number;
  dismissTo?: number;
};

export function DocsSidebar({
  items,
  selectedId,
  loading,
  refreshing,
  error,
  onRefresh,
  onSelect,
  backgroundColor,
  selectionTx,
  dismissFrom = 0,
  dismissTo = 1,
}: DocsSidebarProps) {
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  /* 选中高亮底色（比之前 #e1e1e4 淡一点）；浅色用比画布略深的灰，深色用 surfaceMuted。 */
  const selectedBg = isDark ? colors.surfaceMuted : '#ebebed';
  /* 折叠/展开按下的短暂背景变暗反馈色。 */
  const pressedBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  /** 文件夹展开状态：默认全折叠（空 = 都没展开）。本地缓存，启动时读回。 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /* 内容高度 / 可视高度：内容不到可视区 200% 时不显示滚动条（短列表不必要的进度条）。 */
  const [contentH, setContentH] = useState(0);
  const [layoutH, setLayoutH] = useState(0);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(EXPANDED_STORAGE_KEY)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === 'object') setExpanded(obj as Record<string, boolean>);
        } catch {
          /* 损坏忽略，回退全折叠 */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  /** 某文件夹是否展开：有显式缓存用缓存，否则按默认——根目录(level 0)默认展开、更深默认折叠。 */
  const isExpandedFor = useCallback(
    (id: string, level: number) => expanded[id] ?? level === 0,
    [expanded],
  );
  /** 切换文件夹展开/折叠 + 写回本地缓存。回到该层默认值时删除条目（键集合保持精简）。 */
  const toggleExpanded = useCallback((id: string, level: number) => {
    setExpanded((prev) => {
      const cur = prev[id] ?? level === 0;
      const nextVal = !cur;
      const def = level === 0; // 该层默认展开态
      const next = { ...prev };
      if (nextVal === def) delete next[id];
      else next[id] = nextVal;
      AsyncStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  /** 未展开的文件夹底下所有后代都不显示。后端给的是 DFS 顺序 + level，
   *  一遇到未展开 folder（level=L），跳过后续 level>L 的项；下一次 level<=L 时恢复显示。 */
  const visibleItems = useMemo(() => {
    const out: FlowDocTreeItem[] = [];
    let hideUntilLevelAtOrBelow: number | null = null;
    for (const it of items) {
      const level = it.level ?? 0;
      if (hideUntilLevelAtOrBelow != null) {
        if (level > hideUntilLevelAtOrBelow) continue;
        hideUntilLevelAtOrBelow = null;
      }
      /* 根目录(level 0)：不渲染该行；其子项当作顶层显示。根恒展开（不设 hide、跳过 push）。 */
      if (level === 0) continue;
      out.push(it);
      /* 可展开 = 文件夹 或 有子项的文档；折叠时隐藏其后代。 */
      const canExpand =
        it.type === 'folder' ||
        it.type === 'cooperateInbox' ||
        (it.children?.length ?? 0) > 0;
      if (canExpand && !isExpandedFor(it.id, level)) {
        hideUntilLevelAtOrBelow = level;
      }
    }
    return out;
  }, [items, isExpandedFor]);

  const renderItem = useCallback(
    ({ item }: { item: FlowDocTreeItem }) => {
      const level = item.level ?? 0;
      return (
        <DocTreeRow
          item={item}
          isExpanded={isExpandedFor(item.id, level)}
          isSelected={selectedId === item.id}
          colors={colors}
          styles={styles}
          selectedBg={selectedBg}
          pressedBg={pressedBg}
          selectionTx={selectionTx}
          dismissFrom={dismissFrom}
          dismissTo={dismissTo}
          onToggle={toggleExpanded}
          onSelect={onSelect}
        />
      );
    },
    [
      isExpandedFor,
      toggleExpanded,
      colors,
      styles,
      selectedBg,
      pressedBg,
      selectionTx,
      dismissFrom,
      dismissTo,
      onSelect,
      selectedId,
    ],
  );

  return (
    <View
      style={[
        styles.container,
        backgroundColor != null ? { backgroundColor } : null,
      ]}
    >
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
          onContentSizeChange={(_w, h) => setContentH(h)}
          onLayout={(e) => setLayoutH(e.nativeEvent.layout.height)}
          /* 内容不到可视区 200% 时不显示滚动条。 */
          showsVerticalScrollIndicator={layoutH > 0 && contentH > layoutH * 2}
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
    listContent: { paddingTop: 4, paddingBottom: 64 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingRight: 12,
      /* 左右内缩：选中高亮是个不贯穿整行两边的圆角矩形（对齐全局抽屉 MenuRow）；圆角在高亮层上。 */
      marginHorizontal: ROW_MARGIN_H,
    },
    /* 选中高亮背景层：absoluteFill + 圆角，opacity 由行组件随 dismiss 进度渐隐；底色 = selectedBg。 */
    rowSelectedBg: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: 12,
      borderCurve: 'continuous',
    },
    /** 可展开项的「折叠区」：箭头 + 左半空档；点这里展开/收起（右缘 = 空档中点 = 分界）。 */
    toggleZone: {
      flexDirection: 'row',
      alignItems: 'center',
      /* paddingLeft 由行组件按缩进 inline 给（配合 marginLeft 延伸到屏幕左缘）。 */
      paddingRight: GAP / 2,
      /* 变暗块高度 = 内容 + 上下 paddingVertical（矮于整行、在行内垂直居中）。改这个调高矮。 */
      paddingVertical: 5,
    },
    /* 按下变暗块：填满 toggleZone 高度，但左缘 inline 内缩到箭头附近 → 不随触摸区延伸到屏幕左缘；圆角块。 */
    togglePressBg: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: 0,
      borderRadius: 8,
      borderCurve: 'continuous',
    },
    /** 可展开项的「选中区」：右半空档 + 类型图标 + 名字，flex 吃满；点这里打开。 */
    selectZone: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'stretch',
      paddingLeft: GAP / 2,
    },
    /** 不可展开项（无子项）的「打开区」：整行打开；paddingLeft 让图标与可展开项图标左缘对齐。 */
    rowSelectZone: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'stretch',
      paddingLeft: ICON_LEFT,
    },
    itemIcon: { marginRight: 8 },
    itemName: {
      flex: 1,
      fontSize: LIST_ROW_TITLE_SIZE,
      color: c.textPrimary,
    },
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
