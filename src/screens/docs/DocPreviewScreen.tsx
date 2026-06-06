/**
 * DocPreviewScreen —— 文档下钻的"整页"预览页（替代旧 DocsScreen 内部的横向面板栈）。
 *
 * 路由参数只携带 { id }；本页用 docsTreeStore 把 id 解析成项本身 + 直接子项：
 *  - 文件夹（folder / cooperateInbox）→ FolderView，点子项 → push 更深一层 DocPreview（更深滑入）。
 *  - 文档 → DocBodyView，⋯ 菜单可"复制为 Markdown / 刷新文档"。
 *  - id 在缓存里找不到（极少：树还没加载 / 项已删）→ 占位 + 返回键。
 *
 * 平台无关：useNavigation 在 compact 下解析到 RootStack、iPad 下解析到 MainPane 嵌套栈，
 * 两栈都注册了 DocPreview，所以 push/goBack 自动落到正确的栈，整页右滑入。
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
  type StyleProp,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { type FlowDocTreeItem } from '../../api';
import { BlurHeaderBackground } from '../../components/BlurHeaderBackground';
import { docsTreeStore } from './docsTreeStore';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { RootStackParamList } from '../../navigation/types';
import { HEADER_CIRCLE_BTN_SIZE } from '../../theme/layout';
import { shadowCircleButtonThemed, shadowMenu } from '../../theme/shadows';
import { TASK_FONT_SIZE_TITLE } from '../../theme/typography';
import { FolderView } from './FolderView';
import { DocBodyView, type DocBodyViewHandle } from './DocBodyView';
import { HeaderCircleButton } from '../../components/HeaderCircleButton';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const FOLDER_LIKE_TYPES = new Set(['folder', 'cooperateInbox']);

export type DocPreviewScreenProps = {
  /** 要预览的项 id（路由参数解析后传入；DocsScreen / 上一层 DocPreview push 时携带）。 */
  id: string;
  /** 左上角目录按钮回调。默认 navigation.popToTop()（iPad 整页路由用）；
   *  手机抽屉式预览传 goPeek（半开露目录而非弹掉整页）。 */
  onGoDirectory?: () => void;
  /** 文件夹内点子项回调。默认 navigation.replace（iPad）；
   *  手机抽屉式预览传「改本地 previewId」（原地替换、不叠层、不重新滑入）。 */
  onSelectChild?: (child: FlowDocTreeItem) => void;
  /** 左上角按钮外层的动画样式（手机抽屉式：随半开降低 opacity，跟白遮罩一起变淡 = 被遮罩盖住）。
   *  native 按钮浮在白遮罩之上挡不住，靠自身变淡露出底下白遮罩来等效。 */
  headerLeftStyle?: StyleProp<ViewStyle>;
};

export function DocPreviewScreen({
  id,
  onGoDirectory,
  onSelectChild,
  headerLeftStyle,
}: DocPreviewScreenProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [optionsOpen, setOptionsOpen] = useState(false);
  const docBodyRef = useRef<DocBodyViewHandle | null>(null);

  /** 从缓存解析项 + 直接子项；缓存内容稳定（DocsScreen 加载后写入），用 id 做 memo key。 */
  const item = useMemo(() => docsTreeStore.get(id), [id]);
  const children = useMemo(() => docsTreeStore.children(id), [id]);

  const isFolder = item ? FOLDER_LIKE_TYPES.has(item.type) : false;
  const headerTitle = item
    ? item.name?.trim() || (isFolder ? '未命名文件夹' : '未命名文档')
    : '文档';

  /** 回到文档树（目录）。prop 优先(手机抽屉式 = 半开露目录)；否则整页路由 popToTop 回到树。 */
  const onGoTree = useCallback(() => {
    setOptionsOpen(false);
    if (onGoDirectory) {
      onGoDirectory();
      return;
    }
    navigation.popToTop();
  }, [navigation, onGoDirectory]);

  /** 文件夹里点子项 → prop 优先(手机抽屉式 = 改本地 previewId 原地替换)；
   *  否则整页路由 replace 切到该项预览（不叠新一层页面，栈深度不变；返回始终回树）。 */
  const onChildSelect = useCallback(
    (child: FlowDocTreeItem) => {
      if (onSelectChild) {
        onSelectChild(child);
        return;
      }
      navigation.replace('DocPreview' as never, { id: child.id } as never);
    },
    [navigation, onSelectChild]
  );

  const onCopyMarkdown = useCallback(() => {
    setOptionsOpen(false);
    docBodyRef.current?.copyMarkdown();
  }, []);

  const onReload = useCallback(() => {
    setOptionsOpen(false);
    /* 文档 → 重载正文；文件夹 → 重载文档树（让缓存/视觉刷新）。 */
    docBodyRef.current?.reload();
  }, []);

  const onOptionsPress = useCallback(() => {
    setOptionsOpen((v) => !v);
  }, []);

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;

  return (
    <View style={styles.container}>
      {/* 主区：文件夹 → FolderView；文档 → DocBodyView；找不到 → 占位。 */}
      <View style={[styles.mainArea, { paddingTop: headerHeight }]}>
        {item == null ? (
          <View style={styles.centered}>
            <Text style={styles.placeholderText}>文档不存在，请返回</Text>
          </View>
        ) : isFolder ? (
          <FolderView folder={item} items={children} onSelect={onChildSelect} />
        ) : (
          <DocBodyView ref={docBodyRef} docId={item.id} docType={item.type} />
        )}
      </View>

      {/* 顶部 header：返回键 + 标题 + ⋯ */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={colors.chatScreenBackground}
        />
        {/* 左上角=目录按钮：回到文档树（预览不叠层，等价于"返回到目录"）。
         *  外层 Animated.View 随半开降低 opacity，跟白遮罩一起变淡（native 按钮挡不住，靠变淡等效被盖）。 */}
        <Animated.View style={[styles.headerLeft, headerLeftStyle]}>
          <HeaderCircleButton
            ionicon="list-outline"
            sfSymbol="list.bullet"
            iconSize={24}
            onPress={onGoTree}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          />
        </Animated.View>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
            {headerTitle}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.circleBtn}
          onPress={onOptionsPress}
          activeOpacity={0.7}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
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
            {item && !isFolder ? (
              <>
                <TouchableOpacity style={styles.optionsItem} onPress={onCopyMarkdown}>
                  <Ionicons
                    name="copy-outline"
                    size={16}
                    color={colors.textPrimary}
                    style={styles.optionsIcon}
                  />
                  <Text style={styles.optionsItemText}>复制为 Markdown</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.optionsItem} onPress={onReload}>
                  <Ionicons
                    name="refresh"
                    size={16}
                    color={colors.textPrimary}
                    style={styles.optionsIcon}
                  />
                  <Text style={styles.optionsItemText}>刷新文档</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                style={styles.optionsItem}
                onPress={() => setOptionsOpen(false)}
              >
                <Ionicons
                  name="refresh"
                  size={16}
                  color={colors.textPrimary}
                  style={styles.optionsIcon}
                />
                <Text style={styles.optionsItemText}>刷新文档树</Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    /* 背景透明：由下层供色。整页路由(iPad)下层是 stack card(chatScreenBackground)；
     *  手机抽屉式下层是 overlay inner（背景随开抽屉进度渐变到纯白，文字在上层始终可见）。 */
    container: { flex: 1, backgroundColor: 'transparent' },
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
