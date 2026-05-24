/**
 * DocsScreen —— 抽屉里"文档"条目对应的顶层页（替代旧 DocsHomeScreen）。
 *
 * 与旧版相比：
 *  - 删除内部左缘 sidebar + backdrop + 左缘开 sidebar 手势（这套由抽屉接管）。
 *  - header 左上角放两个圆钮：[汉堡（开抽屉）] + [目录（开 DocsTreeSheet）]，右上角"更多"菜单保留。
 *  - 主区行为保留：默认选根 folder → FolderView；选中 doc → DocBodyView；其余 DocBodyView 占位。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { getFlowDocTree, type FlowDocTreeItem } from '../api';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { DocsTreeSheet } from '../components/DocsTreeSheet';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { shadowCircleButtonThemed, shadowMenu } from '../theme/shadows';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { FolderView } from './docs/FolderView';
import { DocBodyView, type DocBodyViewHandle } from './docs/DocBodyView';
import { HamburgerButton } from './shell/HamburgerButton';
import { HeaderCircleButton } from '../components/HeaderCircleButton';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const FOLDER_LIKE_TYPES = new Set(['folder', 'cooperateInbox']);

export function DocsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [tree, setTree] = useState<FlowDocTreeItem[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeRefreshing, setTreeRefreshing] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [treeSheetVisible, setTreeSheetVisible] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const docBodyRef = useRef<DocBodyViewHandle | null>(null);

  const byId = useMemo(() => {
    const m = new Map<string, FlowDocTreeItem>();
    for (const it of tree) m.set(it.id, it);
    return m;
  }, [tree]);

  const selectedItem = selectedId ? byId.get(selectedId) || null : null;

  const selectedChildren = useMemo(() => {
    if (!selectedItem) return [];
    const ids = selectedItem.children ?? [];
    return ids
      .map((id) => byId.get(id))
      .filter((it): it is FlowDocTreeItem => it != null);
  }, [selectedItem, byId]);

  const loadTree = useCallback(
    async (isRefresh: boolean) => {
      if (!session) return;
      if (isRefresh) setTreeRefreshing(true);
      else setTreeLoading(true);
      setTreeError(null);
      try {
        const next = await getFlowDocTree(session);
        setTree(next);
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
    [session]
  );

  useEffect(() => {
    loadTree(false);
  }, [loadTree]);

  const onPickItem = useCallback((item: FlowDocTreeItem) => {
    setSelectedId(item.id);
  }, []);

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

  /** "更多"按钮的彩蛋：长按 ≥ 3s 跳 SlateRNSpike 开发测试页 */
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
    if (secretFiredRef.current) return;
    setOptionsOpen((v) => !v);
  }, []);
  useEffect(() => {
    return () => {
      if (secretTimerRef.current) clearTimeout(secretTimerRef.current);
    };
  }, []);

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;

  if (!session) return null;

  return (
    <View style={styles.container}>
      {/* 主区 */}
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

      {/* 顶部 header */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        <View style={styles.headerLeft}>
          <HamburgerButton />
          <HeaderCircleButton
            ionicon="list-outline"
            sfSymbol="list.bullet"
            iconSize={24}
            onPress={() => setTreeSheetVisible(true)}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          />
        </View>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
            {headerTitle}
          </Text>
        </View>
        {/* ⋯ 没用 HeaderCircleButton 是因为这里有个 3s 长按 secret（onPressIn/Out 计时
            跳 SlateRNSpike dev 页），HeaderCircleButton/AnimatedCircleButton 的 native
            iOS 路径不暴露 press-in/out 信号，特殊化保留 TouchableOpacity。 */}
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={onOptionsPress}
          onPressIn={onOptionsPressIn}
          onPressOut={onOptionsPressOut}
          activeOpacity={0.7}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          delayLongPress={4000}
        >
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* 更多菜单 */}
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
              <TouchableOpacity style={styles.optionsItem} onPress={onCopyMarkdown}>
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

      <DocsTreeSheet
        visible={treeSheetVisible}
        onClose={() => setTreeSheetVisible(false)}
        items={tree}
        selectedId={selectedId}
        loading={treeLoading}
        refreshing={treeRefreshing}
        error={treeError}
        onRefresh={() => loadTree(true)}
        onSelect={onPickItem}
      />
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
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  });
}

