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
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useResponsive } from '../hooks/useResponsive';
import { useDrawer } from './shell/DrawerContext';
import {
  useGlobalSidebarOpen,
  useGlobalSidebarDrive,
  useReportDocsTreeOpen,
} from './shell/MainPaneContext';
import {
  DividerHandle,
  dividerHandleStyles,
  DIVIDER_TOGGLE_W,
  DIVIDER_TOGGLE_MARGIN,
  EDGE_INTERCEPT_LEFT,
} from './shell/DividerHandle';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { shadowCircleButtonThemed, shadowMenu } from '../theme/shadows';
import { TASK_FONT_SIZE_TITLE } from '../theme/typography';
import { HamburgerButton } from './shell/HamburgerButton';

/** iPad 文档目录树侧栏宽度（收起时动画到 0）。 */
const IPAD_TREE_WIDTH = 300;
/** 目录手柄拖动吸附阈值（与全局手柄一致的体感）。 */
const TREE_SWIPE_VELOCITY = 400;
/** 目录手柄落位 spring（接近临界阻尼，干净无回弹；同 DrawerShell 全局手柄）。 */
const TREE_SPRING = {
  damping: 28,
  stiffness: 360,
  mass: 0.5,
  overshootClamping: true,
} as const;

/** 手柄 commit 那刻的轻 haptic 预反馈（runOnJS 需稳定 function ref）。 */
function triggerTreeHandleHaptic() {
  ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
}
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

  /** 全局菜单侧栏当前是否打开（DrawerShell 下发）。决定文档页两个分界手柄的显隐。 */
  const globalSidebarOpen = useGlobalSidebarOpen();
  /** 全局侧栏跟手驱动通道（DrawerShell 下发）：在目录树侧栏上向左滑直接关全局侧栏要用。 */
  const globalDrive = useGlobalSidebarDrive();
  /** G 的 UI 线程镜像（worklet 里 onBegin 决定这次拖动是关全局还是关目录树）。 */
  const gOpenSV = useSharedValue(globalSidebarOpen);
  useEffect(() => {
    gOpenSV.value = globalSidebarOpen;
  }, [globalSidebarOpen, gOpenSV]);
  /* 把目录树开关态上报给 DrawerShell：用它判断「全局↔目录」线上的全局手柄显隐（仅 G&&T 显示）。
   *  非 iPad（手机）上报 null → DrawerShell 维持原 mainPaneSecondary 行为、不受文档页影响。 */
  useReportDocsTreeOpen(sidebarShell ? treeOpen : null);

  /** ── iPad 目录手柄（骑「目录↔预览」线，绑 treeW）：tap=toggle、拖=跟手改 treeW + 吸附。
   *  位置同全局手柄公式：left = max(MARGIN, treeW − W/2)（T 开骑线 / T 关贴正文左缘）。
   *  可见 iff !(G && T)：G&&T 时由全局手柄接管（在 全局↔目录 线上），这里隐藏。 */
  const treeHandleStyle = useAnimatedStyle(() => ({
    left: Math.max(DIVIDER_TOGGLE_MARGIN, treeW.value - DIVIDER_TOGGLE_W / 2),
  }));
  /** 拦截带位置：跟分界线同步移动，左伸 EDGE_INTERCEPT_LEFT、右伸 EDGE_INTERCEPT_RIGHT，
   *  让分界线附近一整条都能拖（不必精准摸到窄胶囊）。clamp 0：折叠态贴正文左缘。 */
  const treeInterceptStyle = useAnimatedStyle(() => ({
    left: Math.max(0, treeW.value - EDGE_INTERCEPT_LEFT),
  }));
  const treeDragStart = useSharedValue(0);
  const treeDragSettled = useSharedValue(false);
  const settleTreeState = useCallback((open: boolean) => {
    setTreeOpen(open);
  }, []);
  /** 拖动开合 treeW 的 Pan 构造器：调一次返回独立实例（GestureDetector 不能把同一 Gesture 挂两处）。
   *  胶囊本体 + 拦截带各一个实例；共享的 treeDragStart/treeDragSettled 同时刻只有一条拖动在跑。
   *  immediate（拦截带）= activeOffsetX±2 近乎落手即激活；胶囊本体 = ±6 保 tap/纵向滑不被抢。 */
  const buildTreePan = useCallback(
    (immediate: boolean) =>
      Gesture.Pan()
        .activeOffsetX(immediate ? [-2, 2] : [-6, 6])
        .failOffsetY([-12, 12])
        .onBegin(() => {
          'worklet';
          treeDragStart.value = treeW.value;
          treeDragSettled.value = false;
        })
        .onUpdate((e) => {
          'worklet';
          const w = treeDragStart.value + e.translationX;
          treeW.value = Math.max(0, Math.min(IPAD_TREE_WIDTH, w));
        })
        .onEnd((e) => {
          'worklet';
          /* 去重：胶囊/拦截带两个 Pan 在分界线处重叠，可能同时识别 → 多次 onEnd，只让第一个落位。 */
          if (treeDragSettled.value) return;
          treeDragSettled.value = true;
          const open =
            e.velocityX > TREE_SWIPE_VELOCITY
              ? true
              : e.velocityX < -TREE_SWIPE_VELOCITY
                ? false
                : treeW.value > IPAD_TREE_WIDTH / 2;
          const clampedV = Math.max(-2500, Math.min(2500, e.velocityX));
          treeW.value = withSpring(open ? IPAD_TREE_WIDTH : 0, {
            ...TREE_SPRING,
            velocity: clampedV,
          });
          runOnJS(triggerTreeHandleHaptic)();
          runOnJS(settleTreeState)(open);
        }),
    [treeW, treeDragStart, treeDragSettled, settleTreeState]
  );
  const treeHandlePan = useMemo(() => buildTreePan(false), [buildTreePan]);
  const treeInterceptPan = useMemo(() => buildTreePan(true), [buildTreePan]);
  /** 整条目录树侧栏横向拖动开合：不必精准摸到窄胶囊，侧栏任意位置横向拖即可。目标按「G + 方向」分流，
   *  在首帧 onUpdate（这时才知道方向）锁定、整段拖动只驱动同一个：
   *  - 全局侧栏开着(G)：驱动「全局侧栏」（向左滑关全局；向右已满，clamp 无效）。
   *  - 全局侧栏关着 + 向右滑：驱动「全局侧栏」从 0 跟手拉开（在目录区右滑打开全局）。
   *  - 全局侧栏关着 + 向左滑：驱动「目录树」(treeW) 关闭，跟之前一致。
   *  activeOffsetX±6 + failOffsetY 保 tap/纵向滚动/折叠不被抢。 */
  const sidebarDragTarget = useSharedValue(-1); // -1=未定, 0=目录树, 1=全局侧栏
  const sidebarDragStart = useSharedValue(0);
  const canDriveGlobal = !!globalDrive;
  const globalAnimWidth = globalDrive?.animWidth;
  const globalWidth = globalDrive?.width ?? 0;
  const settleGlobalOpen = globalDrive?.settleOpen;
  const treeSidebarPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-6, 6])
        .failOffsetY([-12, 12])
        .onBegin(() => {
          'worklet';
          treeDragSettled.value = false;
          sidebarDragTarget.value = -1;
        })
        .onUpdate((e) => {
          'worklet';
          /* 首帧按方向锁定目标。G 开 → 全局（左滑关）；G 关 + 右滑 → 全局（拉开）；其余 → 目录树。 */
          if (sidebarDragTarget.value === -1) {
            const goRight = e.translationX > 0;
            if (canDriveGlobal && globalAnimWidth && (gOpenSV.value || goRight)) {
              sidebarDragTarget.value = 1;
              sidebarDragStart.value = globalAnimWidth.value;
            } else {
              sidebarDragTarget.value = 0;
              sidebarDragStart.value = treeW.value;
            }
          }
          const next = sidebarDragStart.value + e.translationX;
          if (sidebarDragTarget.value === 1 && globalAnimWidth) {
            globalAnimWidth.value = Math.max(0, Math.min(globalWidth, next));
          } else {
            treeW.value = Math.max(0, Math.min(IPAD_TREE_WIDTH, next));
          }
        })
        .onEnd((e) => {
          'worklet';
          if (treeDragSettled.value || sidebarDragTarget.value === -1) return;
          treeDragSettled.value = true;
          const clampedV = Math.max(-2500, Math.min(2500, e.velocityX));
          if (sidebarDragTarget.value === 1 && globalAnimWidth) {
            const open =
              e.velocityX > TREE_SWIPE_VELOCITY
                ? true
                : e.velocityX < -TREE_SWIPE_VELOCITY
                  ? false
                  : globalAnimWidth.value > globalWidth / 2;
            globalAnimWidth.value = withSpring(open ? globalWidth : 0, {
              ...TREE_SPRING,
              velocity: clampedV,
            });
            runOnJS(triggerTreeHandleHaptic)();
            if (settleGlobalOpen) runOnJS(settleGlobalOpen)(open);
          } else {
            const open =
              e.velocityX > TREE_SWIPE_VELOCITY
                ? true
                : e.velocityX < -TREE_SWIPE_VELOCITY
                  ? false
                  : treeW.value > IPAD_TREE_WIDTH / 2;
            treeW.value = withSpring(open ? IPAD_TREE_WIDTH : 0, {
              ...TREE_SPRING,
              velocity: clampedV,
            });
            runOnJS(triggerTreeHandleHaptic)();
            runOnJS(settleTreeState)(open);
          }
        }),
    [
      treeW,
      treeDragSettled,
      settleTreeState,
      gOpenSV,
      sidebarDragTarget,
      sidebarDragStart,
      canDriveGlobal,
      globalAnimWidth,
      globalWidth,
      settleGlobalOpen,
    ]
  );
  /** 目录手柄显隐：!(G && T)。tap 也带 haptic（toggleTree 仅状态切换，这里补反馈）。 */
  const showTreeHandle = !(globalSidebarOpen && treeOpen);
  const onTreeHandlePress = useCallback(() => {
    triggerTreeHandleHaptic();
    toggleTree();
  }, [toggleTree]);
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
        {/* 文档目录树侧栏（第二条侧栏；左上角按钮收起 → 宽度动画到 0，内层固定宽防压缩）。
         *  整条侧栏接横向拖动开合（treeSidebarPan）：不必精准摸到窄胶囊，侧栏任意位置横向拖即可关闭。 */}
        <GestureDetector gesture={treeSidebarPan}>
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
        </GestureDetector>

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

        {/* 目录↔预览 分界手柄：绑 treeW，骑在目录树右缘（T 开）/ 贴正文左缘（T 关）。
         *  仅 !(G && T) 显示——G&&T 时由 DrawerShell 的全局手柄（全局↔目录 线）接管。
         *  绝对定位于 ipadRow（local x=0 在全局侧栏右缘）：left 公式同全局手柄。 */}
        {showTreeHandle ? (
          <>
            {/* 拦截带：分界线附近一整条(~88×104pt，竖直居中)透明可拖区，跟手柄同一套 pan
             *  → 不必精准摸到窄胶囊就能开合（对齐 全局↔主区 手柄的体验）。 */}
            <GestureDetector gesture={treeInterceptPan}>
              <Animated.View
                style={[dividerHandleStyles.edgeIntercept, treeInterceptStyle]}
              />
            </GestureDetector>

            <Animated.View
              style={[dividerHandleStyles.dividerToggle, treeHandleStyle]}
            >
              <GestureDetector gesture={treeHandlePan}>
                <DividerHandle
                  onPress={onTreeHandlePress}
                  iconColor={colors.textSecondary}
                />
              </GestureDetector>
            </Animated.View>
          </>
        ) : null}
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
