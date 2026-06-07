/**
 * DocsScreen —— 抽屉里"文档"条目对应的顶层页（替代旧 DocsHomeScreen）。
 *
 * 现版（真·整页导航）：
 *  - 顶级界面 = 文档树（DocsSidebar，带缩进 + 文件夹 chevron 行内展开/收起）。
 *  - 点任意条目（文件夹或文档）→ push 一个全新的 DocPreview 页（整页右滑入，原生风），而不是旧的
 *    "主区横向面板栈内部平移"。下钻/返回都交给 React Navigation：
 *      · compact（iPhone）：DocsScreen 直接挂在 RootNavigator 的 Main 下，useNavigation 解析到 RootStack
 *        → push('DocPreview') 走 RootStack 上注册的那条（原生栈默认右滑入）。
 *      · iPad：DocsScreen 是 MainPaneNavigator 里的 DocsRoute，useNavigation 解析到嵌套 stack
 *        → push('DocPreview') 走 MainPaneNavigator 上注册的那条（自定义 rightCardStyleInterpolator 右滑入）。
 *    两边都用同一句 navigation.push('DocPreview', { id })，按平台自动解析到对应栈。
 *  - header：汉堡（开抽屉/侧栏）+ 标题"文档" + 右上角"更多"（3s 长按 secret → SlateRNSpike；刷新文档树）。
 *  - 每次加载树成功后写入 docsTreeStore，供 DocPreview 在任意深度按 id 解析项 + 子项。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSession } from '../context/SessionContext';
import { getFlowDocTree, type FlowDocTreeItem } from '../api';
import { docsTreeStore } from './docs/docsTreeStore';
import { CompactDocsPreviewOverlay } from './docs/CompactDocsPreviewOverlay';
import { DocPreviewScreen } from './docs/DocPreviewScreen';
import { DocsDirectoryPane } from './docs/DocsDirectoryPane';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useResponsive } from '../hooks/useResponsive';
import { useDrawer } from './shell/DrawerContext';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { shadowCircleButtonThemed, shadowMenu } from '../theme/shadows';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { HamburgerButton } from './shell/HamburgerButton';

/** iPad 文档目录树侧栏宽度（收起时动画到 0）。 */
const IPAD_TREE_WIDTH = 300;
/** 上次打开的文档 id 本地缓存 key（退出再回来恢复；手机右滑关闭则清除）。 */
const LAST_OPENED_KEY = 'docsLastOpenedV1';

/** iPad 永不空选时的默认项：①第一个非空文档 → ②第一个非根文件夹 → ③都没有则 null(占位)。 */
function pickDefaultIpadSelection(tree: FlowDocTreeItem[]): string | null {
  const items = tree.filter((it) => (it.level ?? 0) > 0); // 跳过根目录
  const doc = items.find((it) => it.type === 'document' && it.isEmpty === false);
  if (doc) return doc.id;
  const folder = items.find(
    (it) => it.type === 'folder' || it.type === 'cooperateInbox'
  );
  if (folder) return folder.id;
  return null;
}

export function DocsScreen() {
  const insets = useSafeAreaInsets();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const { sidebarShell, width: winWidth } = useResponsive();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /** 手机端抽屉式预览：当前预览项 id（非空 → 渲染前景覆盖层）。 */
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** iPad master-detail：当前在右边正文区显示的项 id（点目录条目即时切换，不整页滑入）。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** iPad：目录树侧栏收起/展开（左上角按钮切换；收起后正文区变宽沉浸阅读）。 */
  const [treeOpen, setTreeOpen] = useState(true);
  const treeW = useSharedValue(IPAD_TREE_WIDTH);
  const treeAnimStyle = useAnimatedStyle(() => ({ width: treeW.value }));
  const toggleTree = useCallback(() => {
    setTreeOpen((open) => {
      const next = !open;
      treeW.value = withTiming(next ? IPAD_TREE_WIDTH : 0, { duration: 240 });
      return next;
    });
  }, [treeW]);
  /** 目录树露出宽度（手机端预览半开时目录铺到此宽，内容不戳到 peek 出来的预览背后）。 */
  const maxTranslateX = Math.min(300, winWidth - 56);
  /** 卡片位移 shared value（传给 overlay 驱动动画/手势）。目录宽度跟它联动：
   *  dismiss 卡片右移出屏时目录从露出宽平滑变到全宽，而不是关闭后瞬间变宽。 */
  const previewTx = useSharedValue(winWidth);
  /** 目录可见宽 = max(露出宽, 卡片左缘位置 tx)；完整态=maxTranslateX(被卡片盖)，
   *  dismiss(tx 从 maxTranslateX→winWidth) 随卡片右移渐变到全宽；无预览时 tx=winWidth=全宽。 */
  const dirAnimStyle = useAnimatedStyle(() => ({
    width: Math.max(maxTranslateX, previewTx.value),
  }));

  /* 手机端：文档板块自己接管屏幕左缘（不让全局抽屉的覆盖手势条吃掉折叠点击）。
   *  focus 期间让位全局 strip；目录区左缘右滑 → 打开全局抽屉（非跟手，达阈值即开）；
   *  完整预览态左缘 → overlay 自己的「露目录」。点击穿透给折叠（pan 不吞 tap）。 */
  const drawer = useDrawer();
  useFocusEffect(
    useCallback(() => {
      if (sidebarShell) return;
      drawer.setOpenGestureSuppressed?.(true);
      return () => drawer.setOpenGestureSuppressed?.(false);
    }, [sidebarShell, drawer])
  );
  const docEdgeArmed = useSharedValue(false);
  const openGlobalDrawer = useCallback(() => drawer.open(), [drawer]);
  const dirOpenGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(8)
        .failOffsetY([-12, 12])
        .onBegin((e) => {
          'worklet';
          docEdgeArmed.value = e.x <= 40; // 仅左缘起始
        })
        .onEnd((e) => {
          'worklet';
          if (!docEdgeArmed.value) return;
          if (e.translationX > 60 || e.velocityX > 500) {
            runOnJS(openGlobalDrawer)();
          }
        }),
    [docEdgeArmed, openGlobalDrawer]
  );

  const [tree, setTree] = useState<FlowDocTreeItem[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeRefreshing, setTreeRefreshing] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  const loadTree = useCallback(
    async (isRefresh: boolean) => {
      if (!session) return;
      if (isRefresh) setTreeRefreshing(true);
      else setTreeLoading(true);
      setTreeError(null);
      try {
        const next = await getFlowDocTree(session);
        setTree(next);
        /* 写入进程级缓存：DocPreview 在任意深度按 id 解析项 + 子项靠它。 */
        docsTreeStore.set(next);
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

  /* 启动恢复 + iPad 永不空选：首次树加载完成后读取上次打开的文档 id；有效则恢复，
   *  iPad 无效/为空则按规则默认选中；之后 iPad 选中失效(树刷新删项)再回落默认。 */
  const initRef = useRef(false);
  useEffect(() => {
    if (tree.length === 0) return;
    if (!initRef.current) {
      initRef.current = true;
      AsyncStorage.getItem(LAST_OPENED_KEY)
        .then((id) => {
          const valid = !!id && tree.some((it) => it.id === id);
          if (sidebarShell) {
            setSelectedId(valid ? (id as string) : pickDefaultIpadSelection(tree));
          } else if (valid) {
            setPreviewId(id as string);
          }
        })
        .catch(() => {
          if (sidebarShell) setSelectedId(pickDefaultIpadSelection(tree));
        });
      return;
    }
    if (sidebarShell) {
      const exists = selectedId != null && tree.some((it) => it.id === selectedId);
      if (!exists) setSelectedId(pickDefaultIpadSelection(tree));
    }
  }, [tree, sidebarShell, selectedId]);

  /* 持久化当前打开项：iPad=selectedId、手机=previewId。手机右滑关闭(previewId=null)→清除，
   *  下次进来全宽目录。初始恢复前不写，避免清掉缓存。 */
  useEffect(() => {
    if (!initRef.current) return;
    const id = sidebarShell ? selectedId : previewId;
    if (id) AsyncStorage.setItem(LAST_OPENED_KEY, id).catch(() => {});
    else AsyncStorage.removeItem(LAST_OPENED_KEY).catch(() => {});
  }, [sidebarShell, selectedId, previewId]);

  /** 点任意条目（文件夹或文档）：
   *  - iPad（sidebarShell）：master-detail，置 selectedId → 右边正文区即时显示（不整页滑入）。
   *  - 手机（compact）：置 previewId → 抽屉式前景层从屏右滑入完整预览。 */
  const onTreeSelect = useCallback(
    (item: FlowDocTreeItem) => {
      if (sidebarShell) {
        setSelectedId(item.id);
      } else {
        setPreviewId(item.id);
      }
    },
    [sidebarShell]
  );

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  /** 手机端目录底部渐变遮罩带高度：较长，但用从头就开始掉透明度的缓渐变（无纯色平台、不显得遮挡多）。 */
  const dirFooterHeight = insets.bottom + 72;

  if (!session) return null;

  /* ── iPad：三栏的中间 + 右栏（全局菜单侧栏在 DrawerShell 外层）。
   *  中间 = 文档目录树侧栏（含「文档」header + ⋯），右 = 正文主区(master-detail)。 */
  if (sidebarShell) {
    return (
      <View style={styles.ipadRow}>
        {/* 文档目录树侧栏（第二条侧栏；左上角按钮收起 → 宽度动画到 0，内层固定宽防压缩） */}
        <Animated.View style={[styles.ipadTreeSidebar, treeAnimStyle]}>
          <View style={styles.ipadTreeInner}>
            {/* iPad 目录树面板：复用 DocsDirectoryPane；header 只放汉堡 + 文档标题（无 ⋯）。 */}
            <DocsDirectoryPane
              items={tree}
              selectedId={selectedId}
              loading={treeLoading}
              refreshing={treeRefreshing}
              error={treeError}
              onRefresh={() => loadTree(true)}
              onSelect={onTreeSelect}
              topInset={insets.top + 8}
              headerHeight={headerHeight}
              footerHeight={dirFooterHeight}
              gradientBaseHex={colors.chatScreenBackground}
              header={
                <>
                  <View style={styles.headerLeft}>
                    <HamburgerButton />
                  </View>
                  <View style={styles.headerTitleWrap}>
                    <Text
                      style={styles.headerTitle}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      文档
                    </Text>
                  </View>
                </>
              }
            />
          </View>
        </Animated.View>

        {/* 正文主区：master-detail，直接复用 DocPreviewScreen（标题行/顶底渐变/目录按钮/⋯菜单全来自同一份）。
         *  左上角「目录」按钮(onGoDirectory)接成收起/展开目录树侧栏；点文件夹子项 → 切 selectedId。 */}
        <View style={styles.ipadContent}>
          {selectedId == null ? (
            <View style={styles.centered}>
              <Text style={styles.placeholderText}>选择一个文档以开始</Text>
            </View>
          ) : (
            <DocPreviewScreen
              id={selectedId}
              onGoDirectory={toggleTree}
              onSelectChild={(c) => setSelectedId(c.id)}
            />
          )}
        </View>
      </View>
    );
  }

  /* ── 手机端（compact）：目录 = 汉堡行 + 树（同一表面），点条目抽屉式预览。 ── */
  return (
    <View style={styles.container}>
      <View style={styles.mainArea}>
        <GestureDetector gesture={dirOpenGesture}>
          <Animated.View style={[styles.compactDir, dirAnimStyle]}>
            {/* 手机目录树面板：复用 DocsDirectoryPane；header 只放汉堡；选中高亮随 dismiss 渐隐。 */}
            <DocsDirectoryPane
              items={tree}
              selectedId={previewId}
              loading={treeLoading}
              refreshing={treeRefreshing}
              error={treeError}
              onRefresh={() => loadTree(true)}
              onSelect={onTreeSelect}
              topInset={insets.top + 8}
              headerHeight={headerHeight}
              footerHeight={dirFooterHeight}
              gradientBaseHex={colors.chatScreenBackground}
              selectionTx={previewTx}
              dismissFrom={maxTranslateX}
              dismissTo={winWidth}
              header={<HamburgerButton />}
            />
          </Animated.View>
        </GestureDetector>
      </View>

      {/* 手机端抽屉式预览前景层 */}
      {previewId != null ? (
        <CompactDocsPreviewOverlay
          previewId={previewId}
          onReplaceChild={(child) => setPreviewId(child.id)}
          onDismiss={() => setPreviewId(null)}
          tx={previewTx}
        />
      ) : null}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
    mainArea: { flex: 1 },
    /** iPad：目录树侧栏 + 正文主区 横向两栏（全局菜单侧栏在外层 DrawerShell）。 */
    ipadRow: { flex: 1, flexDirection: 'row', backgroundColor: c.chatScreenBackground },
    /** iPad 第二条侧栏：文档目录树。单层底色 = chatScreenBackground(跟手机版同源);宽度由
     *  treeAnimStyle 动画(收起→0)，overflow hidden 裁剪内层。 */
    ipadTreeSidebar: {
      backgroundColor: c.chatScreenBackground,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.borderMuted,
      overflow: 'hidden',
    },
    /** 侧栏内层固定宽 = IPAD_TREE_WIDTH：收起时外层宽→0 裁掉它，内容不被压缩变形。 */
    ipadTreeInner: { width: IPAD_TREE_WIDTH, flex: 1 },
    /** iPad 正文区左右上角按钮浮动条（绝对贴顶，左右各一）。 */
    ipadContentTopBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    /** iPad 目录树侧栏顶部 header（浮动，绝对贴顶，覆盖在树之上）：汉堡 + 文档 + ⋯。 */
    ipadTreeHeader: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    /** iPad 正文主区。 */
    ipadContent: { flex: 1, backgroundColor: c.chatScreenBackground },
    /** 手机端目录「同一表面」：汉堡行 + 树。不自带背景，透出最底层 container 的单层背景色
     *  （完整/半开露出都是它，避免多层叠色 + 不遮挡汉堡阴影）。 */
    compactDir: { flex: 1 },
    /** 顶部渐变遮罩带 + 浮动汉堡：绝对定位贴顶，覆盖在树之上；box-none 让空白处滚动穿透。 */
    compactTopBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    /** 底部渐变遮罩带：绝对定位贴底，覆盖在树之上（pointerEvents none）。 */
    compactBottomFade: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
    },
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
