/**
 * DrawerShell —— 全局抽屉外壳。
 *
 * 视觉模型（参考 Claude 移动 app）：
 *  - 抽屉静止渲染在主页面背后（不是浮在上面）。
 *  - 主页面在 reanimated shared value 驱动下 translateX 向右，露出抽屉。
 *  - 主页面同时 morph 出圆角 + 阴影 + 半透明黑色遮罩（progress 越大越暗）。
 *  - 即使最大展开也保留约 64dp peek 让用户能点空白处或滑回。
 *
 * 手势：
 *  - 抽屉关闭时：屏左缘 24dp（iOS）/ 56dp（Android）热区上的 Pan，向右滑触发展开。
 *  - 抽屉打开时：覆盖主页面的遮罩接管，向左滑或点空白 = 关闭。
 *  - 与现有 ConversationList 左缘右滑开 Profile 的手势参数一致：activeOffsetX(10)、failOffsetY([-24, 24])、阈值 60。
 *
 * 路由模型：
 *  - 顶层 active 状态（today / project / docs）由本组件内 useState 持有。
 *  - 通过 React.key 强制主页面在切顶层时 unmount/remount（依据 user 决定：「不保留状态」）。
 *  - 子页（Chat、TaskDetail、设置类）仍由 RootStack push 出去，不归本组件管。
 *
 * Profile：
 *  - 由抽屉底栏头像按钮通过 BottomSheetModalRef 唤起；本组件 mount 它并 expose presentProfileSheet。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import type { DrawerActive } from '../../navigation/types';
import { useAppTheme } from '../../context/ThemeContext';
import { DrawerProvider, type DrawerHandle } from './DrawerContext';
import { DrawerContent } from './DrawerContent';
import { ProfileSheet } from './ProfileSheet';
import { TodayScreen } from '../TodayScreen';
import { ProjectScreen } from '../ProjectScreen';
import { DocsScreen } from '../DocsScreen';
import { ChatScreen } from '../ChatScreen';
import { SystemGestureExclusionView } from '../../components/SystemGestureExclusionView';
import { subscribeClientOutdated } from '../../utils/clientCompatBus';
import { getScreenCornerRadius } from '../../utils/screenInfo';
import { HEADER_CIRCLE_BTN_SIZE } from '../../theme/layout';

/** 抽屉完全展开时主页面右侧保留的 peek 宽度 */
const PEEK_WIDTH = 64;
/** 主页面在最大展开时圆角的兜底值（无法推断屏幕圆角的设备） */
const MAIN_RADIUS_FALLBACK = 24;
/** 通过 safe-area top inset 推断 iOS 设备屏幕物理圆角；Android 用保守默认值。
 *  - top inset ≥ 59：灵动岛设备（iPhone 14 Pro+ / 15+ / 16）：屏幕圆角约 55pt
 *  - top inset ≥ 44：刘海设备（iPhone X – 14 普通 / iPhone 15）：屏幕圆角约 47pt
 *  - 其它（含 iPhone SE 等矩形屏）：0 */
function inferScreenCornerRadius(topInset: number): number {
  if (Platform.OS === 'ios') {
    if (topInset >= 59) return 55;
    if (topInset >= 44) return 47;
    return 0;
  }
  return MAIN_RADIUS_FALLBACK;
}
/** 抽屉自身 dim 上限：progress=0 时最暗、progress=1 时全亮（参考 Claude app 的「刚拉开抽屉偏暗、展开到位才完全显形」效果） */
const DRAWER_DIM_AT_CLOSED = 0.55;
/** 左缘热区宽度（与现有左缘开 Profile 一致） */
const LEFT_EDGE_STRIP_WIDTH = Platform.OS === 'android' ? 56 : 24;
/** 抽屉触发阈值（与现有左缘手势一致） */
const SWIPE_THRESHOLD = 60;
/** Pan 激活的 x 位移阈值（避免与子组件竖向滚动争用） */
const PAN_ACTIVE_OFFSET_X = 10;
/** Pan 失败的 y 偏移上限 */
const PAN_FAIL_OFFSET_Y = 24;

const SPRING_CONFIG = {
  damping: 18,
  stiffness: 200,
  mass: 0.7,
  overshootClamping: false,
} as const;

export function DrawerShell() {
  const { width: winWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();

  /** Android 通过 native module 异步读出来的屏幕物理圆角；iOS 始终为 0（走 inferScreenCornerRadius 查表兜底） */
  const [nativeCornerRadius, setNativeCornerRadius] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getScreenCornerRadius().then((v) => {
      if (!cancelled) setNativeCornerRadius(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 主页面完全展开时的圆角：优先用 native 实测（仅 Android 12+），否则用 inferScreenCornerRadius 查表兜底 */
  const mainRadiusOpen = useMemo(
    () => (nativeCornerRadius > 0 ? nativeCornerRadius : inferScreenCornerRadius(insets.top)),
    [nativeCornerRadius, insets.top]
  );

  /** 抽屉展开比例：0 = 关闭，1 = 完全展开。reanimated shared value，UI 线程驱动动画。 */
  const progress = useSharedValue(0);
  /** JS 侧记录当前是否「展开（含正在展开）」，用来切手势挂载 / pointerEvents */
  const [isOpen, setIsOpen] = useState(false);

  /** active 顶层页 */
  const [active, setActive] = useState<DrawerActive>({ kind: 'today' });

  /** ProfileSheet 引用 */
  const profileSheetRef = useRef<BottomSheetModal>(null);

  /** 主页面 translateX 最大值 = 屏宽 - peek */
  const maxTranslateX = winWidth - PEEK_WIDTH;

  /** 打开 / 关闭操作（带 spring 动画） */
  const open = useCallback(() => {
    setIsOpen(true);
    progress.value = withSpring(1, SPRING_CONFIG);
  }, [progress]);

  const close = useCallback(() => {
    progress.value = withSpring(0, SPRING_CONFIG);
    setIsOpen(false);
  }, [progress]);

  const presentProfileSheet = useCallback(() => {
    profileSheetRef.current?.present();
  }, []);

  /** 服务器 426：Android 上自动 present ProfileSheet（sheet 内部也订阅总线，会同步打开 about modal）。
   *  iOS 不自动 present —— iOS 的 UpgradeRequiredOverlay 只展示「我知道了」，用户可手动进 Profile 看横幅。 */
  useEffect(() => {
    return subscribeClientOutdated(() => {
      if (Platform.OS === 'android') {
        profileSheetRef.current?.present();
      }
    });
  }, []);

  /** DrawerContent 点条目：切顶层页 + 关抽屉 */
  const setActiveAndClose = useCallback(
    (next: DrawerActive) => {
      setActive(next);
      close();
    },
    [close]
  );

  /** UI 线程：progress 自动归位时同步 JS 侧 isOpen，保证手势挂载切换准确 */
  useAnimatedReaction(
    () => progress.value,
    (v, prev) => {
      'worklet';
      if (prev == null) return;
      if (prev > 0.02 && v <= 0.02) {
        runOnJS(setIsOpen)(false);
      } else if (prev < 0.98 && v >= 0.98) {
        runOnJS(setIsOpen)(true);
      }
    }
  );

  /** 左缘开抽屉手势：仅 isOpen=false 时挂载 */
  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(PAN_ACTIVE_OFFSET_X)
        .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
        .onUpdate((e) => {
          'worklet';
          const t = Math.max(0, e.translationX);
          progress.value = Math.min(1, t / maxTranslateX);
        })
        .onEnd((e) => {
          'worklet';
          const opening = e.translationX > SWIPE_THRESHOLD || e.velocityX > 500;
          progress.value = withSpring(opening ? 1 : 0, SPRING_CONFIG);
          runOnJS(setIsOpen)(opening);
        })
        .onFinalize(() => {
          'worklet';
          // 兜底：手势失败 / 取消时若 progress 卡在中间，snap 到最近端
          if (progress.value > 0 && progress.value < 1) {
            const opening = progress.value > 0.5;
            progress.value = withSpring(opening ? 1 : 0, SPRING_CONFIG);
            runOnJS(setIsOpen)(opening);
          }
        }),
    [maxTranslateX, progress]
  );

  /** 关抽屉手势：覆盖主页面的遮罩接管，仅 isOpen=true 时生效 */
  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(-PAN_ACTIVE_OFFSET_X)
        .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
        .onUpdate((e) => {
          'worklet';
          const t = e.translationX;
          progress.value = Math.max(0, Math.min(1, 1 + t / maxTranslateX));
        })
        .onEnd((e) => {
          'worklet';
          const closing = e.translationX < -SWIPE_THRESHOLD || e.velocityX < -500;
          progress.value = withSpring(closing ? 0 : 1, SPRING_CONFIG);
          runOnJS(setIsOpen)(!closing);
        })
        .onFinalize(() => {
          'worklet';
          if (progress.value > 0 && progress.value < 1) {
            const opening = progress.value > 0.5;
            progress.value = withSpring(opening ? 1 : 0, SPRING_CONFIG);
            runOnJS(setIsOpen)(opening);
          }
        }),
    [maxTranslateX, progress]
  );

  /** 拖动 / 打开时启用 Android elevation；progress 离开 0 即开，回到 0 即关。
   *  Android 不能用 reanimated 动态 elevation（会闪烁），故走 JS state。iOS 的 shadowOpacity 走下方
   *  animatedShadowStyle 跟 progress 平滑变。 */
  const [shadowOn, setShadowOn] = useState(false);
  useAnimatedReaction(
    () => progress.value > 0.005,
    (curr, prev) => {
      'worklet';
      if (prev == null) return;
      if (curr !== prev) runOnJS(setShadowOn)(curr);
    }
  );

  /** 外层：transform（shadow 也挂在外层，外层不能 overflow:hidden 否则阴影被裁掉） */
  const animatedMainOuterStyle = useAnimatedStyle(() => {
    const tx = progress.value * maxTranslateX;
    return {
      transform: [{ translateX: tx }],
    };
  });

  /** 内层：borderRadius（内层 overflow:hidden 用来裁剪 children；shadow 不放这里）
   *  整个抽屉过程恒定为设备物理圆角；关闭时主页面铺满屏幕，圆角跟设备自身的
   *  屏幕圆角重合不可见，所以 progress=0 → 1 整段保持同一个值，不再插值。 */
  const animatedMainInnerStyle = useAnimatedStyle(() => {
    return {
      borderRadius: mainRadiusOpen,
    };
  });

  /** iOS：主页面阴影随 progress 平滑显隐（progress=0 完全无阴影，progress 一离开 0 就拉到峰值）。
   *  参考 Claude app：阴影很柔和、低不透明，仅作边缘层次提示而不是强黑边。 */
  const animatedShadowStyle = useAnimatedStyle(() => {
    return {
      shadowOpacity: interpolate(
        progress.value,
        [0, 0.05, 1],
        [0, 0.08, 0.08],
        Extrapolation.CLAMP
      ),
    };
  });

  /** 抽屉 dim：progress=0 时最暗、progress=1 时全亮（抽屉本体上叠一层黑色，不再压暗主页） */
  const animatedDrawerDimStyle = useAnimatedStyle(() => ({
    opacity: (1 - progress.value) * DRAWER_DIM_AT_CLOSED,
  }));

  /** 拼装 DrawerHandle */
  const handle = useMemo<DrawerHandle>(
    () => ({
      open,
      close,
      active,
      setActive: setActiveAndClose,
      presentProfileSheet,
    }),
    [open, close, active, setActiveAndClose, presentProfileSheet]
  );

  /** 渲染 active 顶层页：用 key 强制 unmount/remount（user 定的「不保留状态」） */
  const activeElement = useMemo(() => {
    switch (active.kind) {
      case 'today':
        return <TodayScreen key="today" />;
      case 'project':
        return (
          <ProjectScreen
            key={`project-${active.projectId}`}
            projectId={active.projectId}
            projectName={active.projectName}
          />
        );
      case 'docs':
        return <DocsScreen key="docs" />;
      case 'chat':
        return (
          <ChatScreen
            key={`chat-${active.conversationId ?? `new-${active.nonce ?? 0}`}`}
            inDrawer
            conversationIdOverride={active.conversationId}
            conversationTitleOverride={active.conversationTitle}
          />
        );
    }
  }, [active]);

  return (
    <DrawerProvider value={handle}>
      <View style={[styles.root, { backgroundColor: colors.drawerBackground }]}>
        {/* 背后：抽屉本体（静止，不做 transform）；上叠 dim 层，刚拉开偏暗、展开到位才完全显形 */}
        <View style={styles.drawerBack} pointerEvents={isOpen ? 'auto' : 'none'}>
          <DrawerContent />
          <Animated.View
            style={[styles.drawerDim, animatedDrawerDimStyle]}
            pointerEvents="none"
          />
        </View>

        {/* 前面：主页面。
         *  外层只做 translateX + shadow（不能 overflow:hidden，否则阴影被裁掉）。
         *  内层做 borderRadius + overflow:hidden 来裁剪子内容。 */}
        <Animated.View
          style={[
            styles.mainOuter,
            animatedMainOuterStyle,
            Platform.OS === 'ios'
              ? [
                  {
                    shadowColor: '#000',
                    shadowOffset: { width: -1, height: 0 },
                    shadowRadius: 8,
                  },
                  animatedShadowStyle,
                ]
              : null,
          ]}
        >
          <Animated.View
            style={[
              styles.mainInner,
              { backgroundColor: colors.chatScreenBackground },
              animatedMainInnerStyle,
              /* Android：elevation 必须挂在有 backgroundColor 的 View 上才会渲染阴影；
                 之前挂在 mainOuter（透明）上等于没效果。挪到 mainInner 配合 borderRadius
                 让阴影按圆角卡片形状投在抽屉上。elevation 调到 16 让阴影明显可见，
                 Android 9+ 用 shadowColor 给阴影加点饱和度。 */
              Platform.OS === 'android' && shadowOn
                ? { elevation: 16, shadowColor: '#000' }
                : null,
            ]}
          >
            {activeElement}

            {/* 透明手势捕获层：isOpen 时接管点击关 + 左滑关；不做任何压暗效果 */}
            {isOpen ? (
              <GestureDetector gesture={closeGesture}>
                <View
                  style={StyleSheet.absoluteFill}
                  onTouchEnd={close}
                />
              </GestureDetector>
            ) : null}
          </Animated.View>
        </Animated.View>

        {/* 左缘手势条：仅抽屉关闭时挂载；SystemGestureExclusionView 让 Android 不抢系统返回。
         *  top 让出 topBar 整片区域：Android 上这条 strip 宽 56dp 且 elevation:24，会盖住
         *  topBar 左上的 HamburgerButton（左沿 ~16dp 起、宽 52dp），box-only 把 tap 吞掉
         *  就出现「汉堡键点不动」。让 strip 从 topBar 下方开始即可，左滑唤起仍可用。 */}
        {!isOpen ? (
          <GestureDetector gesture={openGesture}>
            <SystemGestureExclusionView
              style={[
                styles.leftEdge,
                {
                  width: LEFT_EDGE_STRIP_WIDTH,
                  top: insets.top + HEADER_CIRCLE_BTN_SIZE + 20,
                },
              ]}
              pointerEvents="box-only"
              collapsable={false}
            />
          </GestureDetector>
        ) : null}

        {/* ProfileSheet 由本层 host；抽屉底栏头像通过 ref 调起 */}
        <ProfileSheet sheetRef={profileSheetRef} />
      </View>
    </DrawerProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  drawerBack: {
    ...StyleSheet.absoluteFillObject,
  },
  /** 外层：fill 容器，承载 transform + shadow；不能 overflow:hidden（否则阴影被裁掉） */
  mainOuter: {
    ...StyleSheet.absoluteFillObject,
  },
  /** 内层：承载 borderRadius + overflow:hidden 来裁剪 children；shadow 不放这里 */
  mainInner: {
    flex: 1,
    overflow: 'hidden',
  },
  drawerDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  leftEdge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 50,
    ...(Platform.OS === 'android' ? { elevation: 24 } : null),
  },
});
