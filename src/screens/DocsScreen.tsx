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
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { getFlowDocTree, type FlowDocTreeItem } from '../api';
import LinearGradient from 'react-native-linear-gradient';
import { BlurHeaderBackground } from '../components/BlurHeaderBackground';
import { DocsSidebar } from './docs/DocsSidebar';
import { docsTreeStore } from './docs/docsTreeStore';
import { CompactDocsPreviewOverlay } from './docs/CompactDocsPreviewOverlay';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useResponsive } from '../hooks/useResponsive';
import { useDrawer } from './shell/DrawerContext';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { shadowCircleButtonThemed, shadowMenu } from '../theme/shadows';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { HamburgerButton } from './shell/HamburgerButton';

/** DocsScreen 在 compact 下跑在 RootStack、iPad 下跑在 MainPane 嵌套栈；这里按 RootStack 类型标注，
 *  push('DocPreview') 用 as never 兼容两栈（两栈都注册了 DocPreview，运行时按平台解析）。 */
type Nav = NativeStackNavigationProp<RootStackParamList>;

/** hex(#rrggbb) → rgba 字符串（目录底部自定义长渐变遮罩用）。 */
function hexToRgba(hex: string, a: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

export function DocsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const { sidebarShell, width: winWidth } = useResponsive();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /** 手机端抽屉式预览：当前预览项 id（非空 → 渲染前景覆盖层）。iPad 走整页路由，不用它。 */
  const [previewId, setPreviewId] = useState<string | null>(null);
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

  const [optionsOpen, setOptionsOpen] = useState(false);

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

  /** 点任意条目（文件夹或文档）：
   *  - iPad（sidebarShell）：push 整页 DocPreview（右滑入）。两栈都注册了该路由，as never 兼容两栈静态类型。
   *  - 手机（compact）：置 previewId → 抽屉式前景层从屏右滑入完整预览。 */
  const onTreeSelect = useCallback(
    (item: FlowDocTreeItem) => {
      if (sidebarShell) {
        navigation.push('DocPreview' as never, { id: item.id } as never);
      } else {
        setPreviewId(item.id);
      }
    },
    [navigation, sidebarShell]
  );

  const onReload = useCallback(() => {
    setOptionsOpen(false);
    loadTree(true);
  }, [loadTree]);

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
  /** 手机端目录底部渐变遮罩带高度：较长，但用从头就开始掉透明度的缓渐变（无纯色平台、不显得遮挡多）。 */
  const dirFooterHeight = insets.bottom + 72;

  if (!session) return null;

  const sidebarEl = (
    <DocsSidebar
      items={tree}
      /* 手机端高亮当前预览的文档行（变暗高亮，对齐全局抽屉）;iPad 走路由不持有此 state → null。 */
      selectedId={sidebarShell ? null : previewId}
      loading={treeLoading}
      refreshing={treeRefreshing}
      error={treeError}
      onRefresh={() => loadTree(true)}
      onSelect={onTreeSelect}
      /* 手机端目录只由最底层 container（chatScreenBackground）供色 → 单层背景;iPad 保持 surface。 */
      backgroundColor={sidebarShell ? undefined : 'transparent'}
      /* 手机端：选中高亮随 dismiss（卡片 tx 从半开位 maxTranslateX → 屏外 winWidth）渐隐到透明。 */
      selectionTx={sidebarShell ? undefined : previewTx}
      dismissFrom={maxTranslateX}
      dismissTo={winWidth}
      /* 手机端：内容上下留出顶/底遮罩带高度，让树滚动时贯穿渐变遮罩下。 */
      contentTopInset={sidebarShell ? undefined : headerHeight}
      contentBottomInset={sidebarShell ? undefined : dirFooterHeight}
    />
  );

  return (
    <View style={styles.container}>
      {/* 主区：顶级文档树（缩进 + 文件夹 chevron 行内展开/收起）。 */}
      <View style={[styles.mainArea, sidebarShell ? { paddingTop: headerHeight } : null]}>
        {sidebarShell ? (
          /* iPad：浮动 header（下方）盖在上面，树铺满。 */
          sidebarEl
        ) : (
          /* 手机端：目录 = 汉堡行 + 树，作为「同一表面」(完整/半开都是它);无单独标题 header。
           *  预览存在时限宽到露出宽（maxTranslateX），内容不戳到 peek 出来的预览背后;刷新靠下拉。 */
          <GestureDetector gesture={dirOpenGesture}>
            <Animated.View style={[styles.compactDir, dirAnimStyle]}>
              {/* 树铺满整个目录高度，内容上下留出遮罩带高度 → 滚动时贯穿顶/底渐变遮罩下。 */}
              {sidebarEl}
              {/* 底部渐变遮罩带（内容滚到下面被柔化遮挡）。 */}
              <View
                style={[styles.compactBottomFade, { height: dirFooterHeight }]}
                pointerEvents="none"
              >
                {/* 长缓渐变：从顶端就开始掉透明度（无纯色平台），到底端才接近不透明 → 不显得遮挡多。 */}
                <LinearGradient
                  style={StyleSheet.absoluteFill}
                  colors={[
                    hexToRgba(colors.chatScreenBackground, 0),
                    hexToRgba(colors.chatScreenBackground, 0.08),
                    hexToRgba(colors.chatScreenBackground, 0.22),
                    hexToRgba(colors.chatScreenBackground, 0.45),
                    hexToRgba(colors.chatScreenBackground, 0.98),
                  ]}
                  locations={[0, 0.25, 0.5, 0.75, 1]}
                  start={{ x: 0.5, y: 0 }}
                  end={{ x: 0.5, y: 1 }}
                />
              </View>
              {/* 顶部渐变遮罩带 + 浮动汉堡；box-none 让空白处的滚动穿透给下方树。 */}
              <View
                style={[styles.compactTopBar, { paddingTop: insets.top + 8 }]}
                pointerEvents="box-none"
              >
                <BlurHeaderBackground
                  style={StyleSheet.absoluteFill}
                  topSolidHeight={insets.top + 8}
                  gradientBaseHex={colors.chatScreenBackground}
                />
                <HamburgerButton />
              </View>
            </Animated.View>
          </GestureDetector>
        )}
      </View>

      {/* iPad 浮动 header：汉堡（开/合侧栏）+「文档」标题 +「更多」。手机端无此 header。 */}
      {sidebarShell ? (
        <>
          <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
            <BlurHeaderBackground
              style={StyleSheet.absoluteFill}
              topSolidHeight={insets.top + 8}
              gradientBaseHex={colors.chatScreenBackground}
            />
            <View style={styles.headerLeft}>
              <HamburgerButton />
            </View>
            <View style={styles.headerTitleWrap}>
              <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
                文档
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

          {/* 更多菜单（iPad） */}
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
                <TouchableOpacity style={styles.optionsItem} onPress={onReload}>
                  <Ionicons
                    name="refresh"
                    size={16}
                    color={colors.textPrimary}
                    style={styles.optionsIcon}
                  />
                  <Text style={styles.optionsItemText}>刷新文档树</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : null}
        </>
      ) : null}

      {/* 手机端抽屉式预览前景层：盖住整页（含目录汉堡行），自带目录按钮 header。
       *  半开/dismiss/滑入全由它内部驱动；点条目 onReplaceChild 原地替换、右滑到底 onDismiss 卸载。 */}
      {!sidebarShell && previewId != null ? (
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
