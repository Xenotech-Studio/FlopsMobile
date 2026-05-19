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

/** 抽屉完全展开时主页面右侧保留的 peek 宽度 */
const PEEK_WIDTH = 64;
/** 主页面在最大展开时圆角的最终值 */
const MAIN_RADIUS_OPEN = 24;
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
  const { colors } = useAppTheme();

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

  /** 主页面容器 transform / borderRadius / 阴影 */
  const animatedMainStyle = useAnimatedStyle(() => {
    const tx = progress.value * maxTranslateX;
    const radius = interpolate(
      progress.value,
      [0, 1],
      [0, MAIN_RADIUS_OPEN],
      Extrapolation.CLAMP
    );
    return {
      transform: [{ translateX: tx }],
      borderRadius: radius,
      // shadow 走 iOS 平台样式；Android elevation 在静态 style 里恒定（动态 elevation 抖动）
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
      <View style={[styles.root, { backgroundColor: colors.backgroundSecondary }]}>
        {/* 背后：抽屉本体（静止，不做 transform）；上叠 dim 层，刚拉开偏暗、展开到位才完全显形 */}
        <View style={styles.drawerBack} pointerEvents={isOpen ? 'auto' : 'none'}>
          <DrawerContent />
          <Animated.View
            style={[styles.drawerDim, animatedDrawerDimStyle]}
            pointerEvents="none"
          />
        </View>

        {/* 前面：主页面；整体做 translateX / borderRadius / shadow（不再压暗主页，仅作为可点关闭区） */}
        <Animated.View
          style={[
            styles.mainWrap,
            { backgroundColor: colors.chatScreenBackground },
            animatedMainStyle,
            Platform.OS === 'ios' && isOpen
              ? {
                  shadowColor: '#000',
                  shadowOffset: { width: -2, height: 0 },
                  shadowOpacity: 0.18,
                  shadowRadius: 12,
                }
              : null,
            Platform.OS === 'android' && isOpen ? { elevation: 12 } : null,
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

        {/* 左缘手势条：仅抽屉关闭时挂载；SystemGestureExclusionView 让 Android 不抢系统返回 */}
        {!isOpen ? (
          <GestureDetector gesture={openGesture}>
            <SystemGestureExclusionView
              style={[
                styles.leftEdge,
                { width: LEFT_EDGE_STRIP_WIDTH },
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
  mainWrap: {
    ...StyleSheet.absoluteFillObject,
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
