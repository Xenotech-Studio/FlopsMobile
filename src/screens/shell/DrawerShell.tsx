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
  BackHandler,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedProps,
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
import { subscribeClientOutdated } from '../../utils/clientCompatBus';
import { getScreenCornerRadius } from '../../utils/screenInfo';
import { SHADOW_COLOR } from '../../theme/shadows';

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
/** 左缘热区宽度。iOS 加宽到 40 让手指更容易触发（接近 iOS 原生返回手势的触发区）。 */
const LEFT_EDGE_STRIP_WIDTH = Platform.OS === 'android' ? 56 : 40;
/** 抽屉 commit 阈值：translation 或 velocity 任一过就 commit。对齐 iOS 原生返回手势体感:
 *  - 位移 60pt 约抽屉满开宽度的 18%（iOS 系统 ~30%；我们略低点适合 drawer 不是 nav back）
 *  - 速度 400pt/s 约一个明确的「轻甩」起步（iOS ~500-1000，更宽松接受不那么用力的 flick）
 *  慢速拖：得拖到 60pt 才提示「松手就成」+ 才会 commit
 *  快速扫：还没到 60pt 但速度过 400 → 一样触发 + commit */
const SWIPE_THRESHOLD = 60;
const SWIPE_VELOCITY_THRESHOLD = 400;
/** Pan 激活的 x 位移阈值。2pt 即激活。 */
const PAN_ACTIVE_OFFSET_X = 2;
/** Pan 失败的 y 偏移上限。80 让对角滑动也能成功（iOS 返回手势是基于 ratio 的，没绝对上限,
 *  我们没有 ratio 选项就直接放宽，靠 activeOffsetX 挡纯纵向动作）。 */
const PAN_FAIL_OFFSET_Y = 80;

/* Snap spring：弹开要快但末端不能有可见回弹（user 说会「卡顿一下」就是末端微弹）。
 * 取接近临界阻尼：damping ratio = damping / (2 * sqrt(stiffness * mass)) ≈ 1.0。
 * 这里 damping 28 / stiffness 360 / mass 0.5 → ratio ≈ 1.04，刚过临界，无 overshoot 干净落位。 */
const SPRING_CONFIG = {
  damping: 28,
  stiffness: 360,
  mass: 0.5,
  overshootClamping: false,
} as const;

/* 模块层稳定函数 —— runOnJS 必须接 stable function ref（不能是 worklet 内 inline closure）。
 * 手势 commit 那刻立即触发轻 haptic，跟 setIsOpen 完全解耦：之前等 useAnimatedReaction 在
 * progress 跨 0.98 时 setIsOpen → useEffect 才震，相当于动画快结束时震，感觉延迟。 */
function triggerDrawerHaptic() {
  ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
}

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
  /** 一次性 haptic flag：在 gesture 跨阈值时 fire 一次告诉用户「松手就成」，避免重复震；
   *  onBegin 重置。配套 openGesture / closeGesture 各一个。 */
  const openHapticFired = useSharedValue(false);
  const closeHapticFired = useSharedValue(false);
  /** JS 侧记录当前是否「展开（含正在展开）」，用来切手势挂载 / pointerEvents */
  const [isOpen, setIsOpen] = useState(false);

  /** active 顶层页 */
  const [active, setActive] = useState<DrawerActive>({ kind: 'today' });

  /** ProfileSheet 引用 */
  const profileSheetRef = useRef<BottomSheetModal>(null);

  /** 主页面 translateX 最大值 = 屏宽 - peek */
  const maxTranslateX = winWidth - PEEK_WIDTH;

  /** 打开 / 关闭操作（带 spring 动画 + 立即 haptic）。手势 onEnd 自己调 triggerDrawerHaptic;
   *  这里给非手势调用方（HamburgerButton 点击 / 程序式 open）也带上 haptic。 */
  const open = useCallback(() => {
    setIsOpen(true);
    progress.value = withSpring(1, SPRING_CONFIG);
    triggerDrawerHaptic();
  }, [progress]);

  const close = useCallback(() => {
    progress.value = withSpring(0, SPRING_CONFIG);
    setIsOpen(false);
    triggerDrawerHaptic();
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

  /** Android：在顶层抽屉页接住系统返回（含左缘滑动手势）：
   *  - 抽屉已开：先关抽屉。
   *  - 抽屉已关：当作"打开抽屉"，避免直接退出 app。
   *  这条只在 DrawerShell focused 时挂；用户从抽屉页 push 进 Chat / TaskDetail
   *  等子页时 DrawerShell 失焦，listener 卸下，子页的返回手势恢复 pop 默认行为。
   *  Android 系统层面 systemGestureExclusionRects 一台屏只能排除 200dp 左右，
   *  超出区域的左缘滑动仍会触发系统返回；BackHandler 在这里兜底。 */
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (isOpen) {
          close();
        } else {
          open();
        }
        return true;
      });
      return () => sub.remove();
    }, [isOpen, open, close])
  );

  /** DrawerContent 点条目：切顶层页 + 关抽屉 */
  const setActiveAndClose = useCallback(
    (next: DrawerActive) => {
      setActive(next);
      close();
    },
    [close]
  );

  /* setIsOpen 不再在 useAnimatedReaction 里跟 progress 跨阈值同步——那样会在动画快结束
   * 时（progress 跨 0.98）触发 React 重渲染 + DrawerContent fiber walk，用户能看到末端
   * 卡顿一下。现在改成 gesture 的 withSpring completion callback fire setIsOpen，spring
   * 真正完成（值到位 + 静止）才更新 state，re-render 发生在动画已经结束的不可见时间点。
   * open() / close() 程序式调用仍然直接同步 setIsOpen（那条路径还没动画启动，没卡顿风险）。 */

  /** 左缘开抽屉手势：仅 isOpen=false 时挂载 */
  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(PAN_ACTIVE_OFFSET_X)
        .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
        .onBegin(() => {
          'worklet';
          openHapticFired.value = false;
        })
        .onUpdate((e) => {
          'worklet';
          const t = Math.max(0, e.translationX);
          progress.value = Math.min(1, t / maxTranslateX);
          /* 跟 onEnd 完全一致的 commit 预测：translation 过线 OR velocity 过线 —— 慢扫够远会
             触发，快速 flick 远没拖到 translation 阈值靠速度也会触发。haptic 一次性，告诉用户
             「此刻松手就成」（确认反馈，不是事件回响）。 */
          if (
            !openHapticFired.value &&
            (e.translationX > SWIPE_THRESHOLD || e.velocityX > SWIPE_VELOCITY_THRESHOLD)
          ) {
            openHapticFired.value = true;
            runOnJS(triggerDrawerHaptic)();
          }
        })
        .onEnd((e) => {
          'worklet';
          /* commit 判定用 sticky haptic flag —— onUpdate 一旦提示「松手就成」就锁定 commit,
             不允许 user 在「过线 + 减速 + 退一点」之后 release 不 commit 的「haptic 撒谎」。
             兜底：如果 haptic 没 fire 过（gesture 极短未走完 onUpdate），看 release 时的
             translation 或 velocity 也行。 */
          const opening =
            openHapticFired.value ||
            e.translationX > SWIPE_THRESHOLD ||
            e.velocityX > SWIPE_VELOCITY_THRESHOLD;
          /* 传 velocity 让 spring 继承手势离开瞬间的速度，避免 spring 从 0 开始加速的
             「先停一下再弹」感。velocityX(pt/s) ÷ maxTranslateX 换成 progress/s。
             completion callback 触发 setIsOpen：动画真正完成（值到位 + 静止）才更新 React
             state → re-render 发生在动画已结束的不可见时间点，杜绝末端卡顿。 */
          progress.value = withSpring(
            opening ? 1 : 0,
            {
              ...SPRING_CONFIG,
              velocity: e.velocityX / maxTranslateX,
            },
            (finished) => {
              'worklet';
              if (finished) runOnJS(setIsOpen)(opening);
            }
          );
          /* haptic 已在 onUpdate 跨阈值时给过（「松手就成」的预反馈），release 时不再震。 */
        })
        .onFinalize((_e, success) => {
          'worklet';
          /* 兜底：仅当 onEnd 没正常结束（gesture 被 cancel / fail）才介入。
             之前没传 success 参数 → onEnd 后 onFinalize 总 fire，此时 spring 才刚启动
             progress.value 还很小 → 误判要关 → 反手 spring 0 盖掉 onEnd 的 OPEN 决策,
             导致用户怎么 swipe 都打不开。 */
          if (success) return;
          if (progress.value > 0 && progress.value < 1) {
            const opening = progress.value > 0.5;
            progress.value = withSpring(opening ? 1 : 0, SPRING_CONFIG);
            // setIsOpen 由 useAnimatedReaction 在 progress 跨阈值时自动同步
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
        .onBegin(() => {
          'worklet';
          closeHapticFired.value = false;
        })
        .onUpdate((e) => {
          'worklet';
          const t = e.translationX;
          progress.value = Math.max(0, Math.min(1, 1 + t / maxTranslateX));
          // 同 openGesture：translation 或 velocity 任一过 commit 阈值 → 一次性 haptic
          if (
            !closeHapticFired.value &&
            (e.translationX < -SWIPE_THRESHOLD || e.velocityX < -SWIPE_VELOCITY_THRESHOLD)
          ) {
            closeHapticFired.value = true;
            runOnJS(triggerDrawerHaptic)();
          }
        })
        .onEnd((e) => {
          'worklet';
          // 同 openGesture：用 sticky haptic flag 作为 commit 信号，避免「震过又没关」
          const closing =
            closeHapticFired.value ||
            e.translationX < -SWIPE_THRESHOLD ||
            e.velocityX < -SWIPE_VELOCITY_THRESHOLD;
          /* 同 openGesture：传 velocity 继承手势速度 + completion callback 触发 setIsOpen，
             re-render 发生在动画结束后，避免末端卡顿。haptic 已在 onUpdate 给过不重复。 */
          progress.value = withSpring(
            closing ? 0 : 1,
            {
              ...SPRING_CONFIG,
              velocity: e.velocityX / maxTranslateX,
            },
            (finished) => {
              'worklet';
              if (finished) runOnJS(setIsOpen)(!closing);
            }
          );
        })
        .onFinalize((_e, success) => {
          'worklet';
          /* 同 openGesture：只在 gesture 被 cancel / fail 时介入兜底；onEnd 正常结束就 return。 */
          if (success) return;
          if (progress.value > 0 && progress.value < 1) {
            const opening = progress.value > 0.5;
            progress.value = withSpring(opening ? 1 : 0, SPRING_CONFIG);
            // setIsOpen 由 useAnimatedReaction 在 progress 跨阈值时自动同步
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

  /* gesture wrapper pointerEvents 在 UI 线程跟 progress 切换 —— 不走 React state，避免「等
   * setIsOpen → React re-render → pointerEvents 更新」的链条。progress 跨 0.5 当作 commit
   * 临界：抽屉过半开 → close 手势激活；抽屉过半关 → open 手势激活。快速 open/close 之间
   * 不需要等动画完成 + state 更新就能接到下一次 gesture。 */
  const closeGestureWrapperProps = useAnimatedProps(
    () => ({ pointerEvents: progress.value > 0.5 ? ('auto' as const) : ('none' as const) }),
  );
  const openGestureWrapperProps = useAnimatedProps(
    () => ({ pointerEvents: progress.value < 0.5 ? ('box-only' as const) : ('none' as const) }),
  );

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
            createEncrypted={Boolean(active.createEncrypted)}
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
                    shadowColor: SHADOW_COLOR,
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
                ? { elevation: 16, shadowColor: SHADOW_COLOR }
                : null,
            ]}
          >
            {activeElement}

            {/* 透明手势捕获层：抽屉开时接管点击关 + 左滑关。
             *  pointerEvents 用 useAnimatedProps 跟 progress.value 在 UI 线程切，progress > 0.5
             *  即激活——不等 React setIsOpen，rapid open/close 之间能立即接下一个 gesture。
             *  GestureDetector 持续 attached 避免 native gesture recognizer 重建。
             *  onTouchEnd 始终绑 close —— pointerEvents='none' 时 touch 不会到，不会误触。 */}
            <GestureDetector gesture={closeGesture}>
              <Animated.View
                style={StyleSheet.absoluteFill}
                animatedProps={closeGestureWrapperProps}
                onTouchEnd={close}
              />
            </GestureDetector>
          </Animated.View>
        </Animated.View>

        {/* 左缘开抽屉手势条：仅 iOS 挂载。
         *  - iOS 没有"系统左缘 = 返回"约定，pan 是唯一的左缘开抽屉入口。
         *  - Android 改成完全靠 BackHandler 接住系统返回（含左缘滑动）→ open()，
         *    省掉这条 strip 跟 SystemGestureExclusionView，避免 strip 跟其它点击
         *    区域抢手势（曾经盖过 HamburgerButton 触发"点不动"那个 bug）；
         *    代价是 Android 失去 drag-to-peek 的跟手反馈，按下放手才弹开。 */}
        {Platform.OS === 'ios' ? (
          <GestureDetector gesture={openGesture}>
            <Animated.View
              style={[
                styles.leftEdge,
                { width: LEFT_EDGE_STRIP_WIDTH },
              ]}
              /* pointerEvents 用 useAnimatedProps 跟 progress.value 在 UI 线程切：progress < 0.5
               * 即激活（box-only），过半就让位给 closeGesture。GestureDetector 持续 attached
               * 避免 isOpen 切换时 native gesture recognizer 重建。 */
              animatedProps={openGestureWrapperProps}
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
