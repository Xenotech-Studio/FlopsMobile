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
  withTiming,
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
import { getScreenCornerRadius, inferScreenCornerRadius } from '../../utils/screenInfo';
import { SHADOW_COLOR } from '../../theme/shadows';
import { useResponsive } from '../../hooks/useResponsive';

/** 抽屉完全展开时主页面右侧保留的 peek 宽度 */
const PEEK_WIDTH = 64;
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
 * 手势 commit 那刻立即触发轻 haptic，作为「松手就成」预反馈。 */
function triggerDrawerHaptic() {
  ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
}

/** sidebarShell 侧栏收/展的布局过渡时长（ms）。Reanimated LinearTransition 在原生 UI 线程插值
 *  侧栏宽度（0↔SIDEBAR_WIDTH）与主区 frame，只跑一次 Yoga（切 state 那刻），插值帧全在原生层——
 *  不像「每帧改 width」那样每帧重排右侧重列表，所以丝滑。 */
const SIDEBAR_ANIM_DURATION = 280;

export function DrawerShell() {
  const { width: winWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  /** iPad 全屏（横竖通用）：用 push 式、可收起/展开的侧栏外壳（同一棵树，旋转只改宽度，不 remount）。
   *  窄宽度（iPhone / iPad 分屏）→ sidebarShell=false → 走下方手机覆盖式动画抽屉（支持 Split View）。
   *  sidebarDefaultOpen：横屏默认展开、竖屏默认收起；旋转时此值翻转，下方 effect 把侧栏动画到对应默认态。 */
  const { sidebarShell, sidebarDefaultOpen, sidebarWidth } = useResponsive();

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

  /** 抽屉展开比例：0 = 关闭，1 = 完全展开。reanimated shared value，UI 线程驱动动画。
   *  仅 compact（手机覆盖式抽屉）用。 */
  const progress = useSharedValue(0);

  /** ── sidebarShell（iPad 原生 push 侧栏）专用 ──
   *  开合走双轨：
   *   1) imperative command `setOpen`（原生立刻起 UIView 动画，不等 React 重渲染）→ 零延迟。
   *   2) React state `sidebarOpen`（异步更新，只记逻辑态：给主区显式宽度、旋转 effect、汉堡 toggle 读）。
   *  原生侧用「prop==当前态就不重复动画」去重，所以两轨同时改不会动两次。
   *  初值跟随当前默认态（横屏开 / 竖屏关），首帧即正确。 */
  const [sidebarOpen, setSidebarOpen] = useState(sidebarDefaultOpen);

  /** ── iPad push 侧栏：UI 线程逐帧驱动侧栏宽度（最接近 Web `transition: width` 的 RN 做法）──
   *  sidebarAnimWidth 是侧栏当前宽度（px），由 Reanimated 在 UI 线程逐帧 withTiming 插值，
   *  绑到侧栏容器的 width（useAnimatedStyle）。主区 flex:1 自动吃剩余 → 跟着重排。
   *  零延迟：直接写 shared value、不经 React 重渲染（跟手机版抽屉同思路）。 */
  const sidebarAnimWidth = useSharedValue(sidebarDefaultOpen ? sidebarWidth : 0);
  const sidebarAnimStyle = useAnimatedStyle(() => ({ width: sidebarAnimWidth.value }));
  /** 开合：UI 线程逐帧动画宽度（零延迟）+ setState 仅记逻辑态（旋转/DocBodyView/toggle 读）。 */
  const applySidebarOpen = useCallback(
    (next: boolean) => {
      sidebarAnimWidth.value = withTiming(next ? sidebarWidth : 0, {
        duration: SIDEBAR_ANIM_DURATION,
      });
      setSidebarOpen(next);
    },
    [sidebarAnimWidth, sidebarWidth]
  );
  /** 旋转（横竖切换）时把侧栏带到新的默认态：横屏→展开、竖屏→收起。
   *  动画宽度 + 逻辑 state 都跟到默认态。 */
  useEffect(() => {
    if (!sidebarShell) return;
    sidebarAnimWidth.value = withTiming(sidebarDefaultOpen ? sidebarWidth : 0, {
      duration: SIDEBAR_ANIM_DURATION,
    });
    setSidebarOpen(sidebarDefaultOpen);
  }, [sidebarShell, sidebarDefaultOpen, sidebarAnimWidth, sidebarWidth]);
  /** 「commit armed」状态：translation 当前是否过了 commit 阈值。
   *  - true → release 就会 commit；onUpdate 在过线一刻 fire haptic
   *  - false → release 不 commit；onUpdate 在退线一刻 fire haptic（反悔反馈）
   *  跟着 translation 双向更新，跨边界就响。velocity 只在 release 时作为 flick 兜底。 */
  const openCommitArmed = useSharedValue(false);
  const closeCommitArmed = useSharedValue(false);
  /** 「gesture 真正发生了拖动」flag —— onUpdate fire 才置 true。onFinalize 用它判断是否
   *  纯 tap：纯 tap 时不要介入 progress（让外部 onTouchEnd→close() 自己接管），否则会
   *  snap 回开端把 close 盖掉，导致点击 peek 卡片关不掉抽屉。 */
  const openGestureMoved = useSharedValue(false);
  const closeGestureMoved = useSharedValue(false);
  /* 之前有 isOpen JS state，用来切 BackHandler 分支 / drawerBack pointerEvents。后者改成
     animatedProps→box-none 已经不需要，前者改成 BackHandler 直接读 progress.value 也不需要。
     现在所有开/关判定都走 progress.value（UI 线程真实位置），JS state 完全多余。 */

  /** active 顶层页 */
  const [active, setActive] = useState<DrawerActive>({ kind: 'today' });

  /** ProfileSheet 引用 */
  const profileSheetRef = useRef<BottomSheetModal>(null);

  /** 主页面 translateX 最大值 = 屏宽 - peek */
  const maxTranslateX = winWidth - PEEK_WIDTH;

  /** 打开 / 关闭操作。haptic 立即触发 + progress spring 动画。没 JS state 要同步，
   *  spring 不需要 completion callback。 */
  const open = useCallback(() => {
    triggerDrawerHaptic();
    /** sidebarShell：命令原生立刻展开 push 侧栏（零延迟）；compact：拉开覆盖式抽屉（reanimated）。 */
    if (sidebarShell) {
      applySidebarOpen(true);
    } else {
      progress.value = withSpring(1, SPRING_CONFIG);
    }
  }, [progress, sidebarShell, applySidebarOpen]);

  const close = useCallback(() => {
    triggerDrawerHaptic();
    if (sidebarShell) {
      applySidebarOpen(false);
    } else {
      progress.value = withSpring(0, SPRING_CONFIG);
    }
  }, [progress, sidebarShell, applySidebarOpen]);

  /** 切换开合。汉堡按钮用它。sidebarShell 走原生 command（零延迟）；compact 走 progress（读 UI 线程真实位置）。 */
  const toggle = useCallback(() => {
    triggerDrawerHaptic();
    if (sidebarShell) {
      applySidebarOpen(!sidebarOpen);
    } else {
      progress.value = withSpring(progress.value > 0.5 ? 0 : 1, SPRING_CONFIG);
    }
  }, [progress, sidebarShell, applySidebarOpen, sidebarOpen]);

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
        /* 读 progress.value 而不是 isOpen JS state：isOpen 在 spring 完成回调里才更新，关动画
           mid-flight 时 isOpen 还是 true，按返回会再调一次 close()（重启 spring + 第二次 haptic）。
           SharedValue.value 在 JS 线程也可读，反映抽屉当前真实位置。 */
        if (progress.value > 0.5) {
          close();
        } else {
          open();
        }
        return true;
      });
      return () => sub.remove();
    }, [open, close, progress])
  );

  /** DrawerContent 点条目：切顶层页，然后收侧栏。
   *  - compact：关闭覆盖式抽屉。
   *  - sidebarShell：回到当前朝向的默认态——横屏默认展开（保持展开、不收）、竖屏默认收起（收回去，
   *    像抽屉那样点完即收）。即「点条目后回到这个朝向本来的样子」。 */
  const setActiveAndClose = useCallback(
    (next: DrawerActive) => {
      setActive(next);
      if (sidebarShell) {
        triggerDrawerHaptic();
        applySidebarOpen(sidebarDefaultOpen);
      } else {
        close();
      }
    },
    [close, sidebarShell, sidebarDefaultOpen, applySidebarOpen]
  );

  /** 左缘开抽屉手势：常挂载，靠下方 openGestureWrapperProps 按 progress 切 pointerEvents 启停 */
  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(PAN_ACTIVE_OFFSET_X)
        .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
        .onBegin(() => {
          'worklet';
          openCommitArmed.value = false;
          openGestureMoved.value = false;
        })
        .onUpdate((e) => {
          'worklet';
          openGestureMoved.value = true;
          const t = Math.max(0, e.translationX);
          progress.value = Math.min(1, t / maxTranslateX);
          /* 双向 haptic：translation 双向跨 SWIPE_THRESHOLD 都响一次。「过线」=「松手就成」
             预反馈；「退线」=「反悔了」反馈，用户能感知到刚才那个确认被撤销。
             velocity 不参与 armed 状态判定（瞬时值易抖且不可逆），只在 release 时作为 flick
             兜底——快速 flick 没 haptic 但松手照样 commit。 */
          const wouldCommit = e.translationX > SWIPE_THRESHOLD;
          if (wouldCommit !== openCommitArmed.value) {
            openCommitArmed.value = wouldCommit;
            runOnJS(triggerDrawerHaptic)();
          }
        })
        .onEnd((e) => {
          'worklet';
          /* commit = armed (translation 当前过线) OR velocity 过 flick 兜底阈值。
             退线了 armed 就回 false → 不 commit（兑现「反悔」承诺）。 */
          const flick = e.velocityX > SWIPE_VELOCITY_THRESHOLD;
          const opening = openCommitArmed.value || flick;
          /* haptic：translation-armed 路径 onUpdate 已经给过预反馈；纯 flick 兜底路径
             （短快小动作没走过 ±SWIPE_THRESHOLD）onUpdate 没响过，在 release commit
             这刻补一次，否则用户感觉「抽屉自己开/关了但没反馈」。 */
          if (opening && !openCommitArmed.value) {
            runOnJS(triggerDrawerHaptic)();
          }
          /* 传 velocity 让 spring 继承手势离开瞬间的速度，避免 spring 从 0 开始加速的
             「先停一下再弹」感。velocityX(pt/s) ÷ maxTranslateX 换成 progress/s。 */
          progress.value = withSpring(opening ? 1 : 0, {
            ...SPRING_CONFIG,
            velocity: e.velocityX / maxTranslateX,
          });
        })
        .onFinalize((_e, success) => {
          'worklet';
          /* 兜底：仅当 onEnd 没正常结束（gesture 被 cancel / fail）才介入。
             之前没传 success 参数 → onEnd 后 onFinalize 总 fire，此时 spring 才刚启动
             progress.value 还很小 → 误判要关 → 反手 spring 0 盖掉 onEnd 的 OPEN 决策,
             导致用户怎么 swipe 都打不开。 */
          if (success) return;
          /* 纯 tap（onUpdate 没 fire 过）不要碰 progress —— 否则外面 onTouchEnd→close() 想关
             抽屉时会被这里看到「progress 中段、靠开端」误 snap 回 1，盖掉 close 操作。 */
          if (!openGestureMoved.value) return;
          if (progress.value > 0 && progress.value < 1) {
            const opening = progress.value > 0.5;
            progress.value = withSpring(opening ? 1 : 0, SPRING_CONFIG);
          }
        }),
    [maxTranslateX, progress]
  );

  /** 关抽屉手势 builder：左滑 commit / flick / armed 反悔 一整套逻辑。
   *  调一次返回一个 fresh Gesture.Pan() 实例。GestureDetector 不能复用同一 Gesture 对象
   *  到两个挂载点（内部 handlerTag 会冲突），所以挂在多处时各调一次拿独立实例。
   *  SharedValues（closeCommitArmed / closeGestureMoved）跨实例共享 —— 同一时刻只可能
   *  有一条 close 手势在跑，状态合用没问题。 */
  const buildCloseGesture = useCallback(
    () =>
      Gesture.Pan()
        .activeOffsetX(-PAN_ACTIVE_OFFSET_X)
        .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
        .onBegin(() => {
          'worklet';
          closeCommitArmed.value = false;
          closeGestureMoved.value = false;
        })
        .onUpdate((e) => {
          'worklet';
          closeGestureMoved.value = true;
          const t = e.translationX;
          progress.value = Math.max(0, Math.min(1, 1 + t / maxTranslateX));
          /* 同 openGesture 双向 haptic：translation 跨 -SWIPE_THRESHOLD 双向都响，
             支持反悔。velocity 不参与 armed 状态，只 release 时 flick 兜底。 */
          const wouldCommit = e.translationX < -SWIPE_THRESHOLD;
          if (wouldCommit !== closeCommitArmed.value) {
            closeCommitArmed.value = wouldCommit;
            runOnJS(triggerDrawerHaptic)();
          }
        })
        .onEnd((e) => {
          'worklet';
          // commit = armed OR 负向 flick 兜底
          const flick = e.velocityX < -SWIPE_VELOCITY_THRESHOLD;
          const closing = closeCommitArmed.value || flick;
          /* 同 openGesture：纯 flick 路径 onUpdate 没机会响 haptic（translation 没过 ±60pt），
             release commit 这刻补一次反馈。 */
          if (closing && !closeCommitArmed.value) {
            runOnJS(triggerDrawerHaptic)();
          }
          /* 同 openGesture：传 velocity 继承手势速度。 */
          progress.value = withSpring(closing ? 0 : 1, {
            ...SPRING_CONFIG,
            velocity: e.velocityX / maxTranslateX,
          });
        })
        .onFinalize((_e, success) => {
          'worklet';
          /* 同 openGesture：只在 gesture 被 cancel / fail 时介入兜底；onEnd 正常结束就 return。 */
          if (success) return;
          /* 纯 tap（onUpdate 没 fire 过）—— 抽屉开时点 peek 卡片是常见 close 路径，
             onTouchEnd 会调 close()。这里不要 snap，否则会盖掉 close 的 spring。 */
          if (!closeGestureMoved.value) return;
          if (progress.value > 0 && progress.value < 1) {
            const opening = progress.value > 0.5;
            progress.value = withSpring(opening ? 1 : 0, SPRING_CONFIG);
          }
        }),
    [maxTranslateX, progress]
  );

  /** 关抽屉手势 #1：挂在主页面 peek 卡片遮罩上（抽屉打开时主页面左滑回收） */
  const closeGesturePeek = useMemo(() => buildCloseGesture(), [buildCloseGesture]);
  /** 关抽屉手势 #2：挂在抽屉面板自身上（在抽屉内容区也能左滑关）。
   *  activeOffsetX(-2) + failOffsetY(±80) 保证：纯 tap 不会激活（仍能点列表项），
   *  纵向 scroll 超过 80pt 时 pan fail（让 ScrollView 接管 DrawerContent 内的滚动）。 */
  const closeGestureOnDrawer = useMemo(() => buildCloseGesture(), [buildCloseGesture]);

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
   *  圆角随 progress 从 0（关闭=方角）快速 ramp 到 mainRadiusOpen（打开=设备圆角）。
   *  之前恒定为设备圆角、假设关闭铺满屏时跟物理屏圆角重合不可见——但方形屏手机没有物理圆角，
   *  恒定值在关闭态就露出来了。改成关闭归 0：方形屏关闭=方角贴合屏幕；圆角屏关闭=方角内容被
   *  系统物理圆角裁掉照样圆，打开时圆角匹配设备。ramp 区间小，离开 0 的一瞬即到位、视觉无突变。 */
  const animatedMainInnerStyle = useAnimatedStyle(() => {
    return {
      borderRadius: interpolate(progress.value, [0, 0.06], [0, mainRadiusOpen], 'clamp'),
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

  /* gesture wrapper pointerEvents 在 UI 线程跟 progress 切换。progress 跨 0.5 当作 commit
   * 临界：抽屉过半开 → close 手势激活；抽屉过半关 → open 手势激活。 */
  const closeGestureWrapperProps = useAnimatedProps(
    () => ({ pointerEvents: progress.value > 0.5 ? ('auto' as const) : ('none' as const) }),
  );
  const openGestureWrapperProps = useAnimatedProps(
    () => ({ pointerEvents: progress.value < 0.5 ? ('box-only' as const) : ('none' as const) }),
  );
  /* drawerBack 固定 pointerEvents='box-none'：drawerBack 自己不吞 touch（drawer 关闭时
   *  mainOuter 完全覆盖屏幕在上层先接 touch，不会穿透），里面 GestureDetector 永远 live。
   *  早期试过按 progress 切 'auto'/'none'，关手势从 1 滑到 0.5 这刻 drawerBack 翻成 'none' →
   *  native 层祖先失活打断进行中的 pan → 跨阈值卡顿；常 live 没这问题。 */

  /** 拼装 DrawerHandle */
  const handle = useMemo<DrawerHandle>(
    () => ({
      open,
      close,
      toggle,
      active,
      setActive: setActiveAndClose,
      presentProfileSheet,
    }),
    [open, close, toggle, active, setActiveAndClose, presentProfileSheet]
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

  /* ── sidebarShell（iPad 全屏，横竖通用）：实验版——UI 线程逐帧驱动宽度 + 主区 flex reflow ──
   *  row 容器：侧栏宽度由 sidebarAnimStyle（Reanimated UI 线程逐帧 width）驱动；主区 flex:1 自动吃剩余。
   *  每帧侧栏宽度变 → Yoga 在 UI 线程重算 → 主区内容跟着 reflow（最接近 Web `transition:width`）。
   *  这就是要实测的：主区内容（轻页面 vs ChatScreen 长列表）逐帧 reflow 扛不扛得住 60fps。
   *  零延迟：直接写 shared value，不经 React。横屏默认展开 / 竖屏默认收起，汉堡 toggle。
   *  侧栏内容定宽 sidebarWidth + overflow:hidden：收起时容器宽→0 裁切滑出，DrawerContent 不被压缩塌陷。 */
  if (sidebarShell) {
    return (
      <DrawerProvider value={handle}>
        <View style={[styles.root, styles.sidebarShellRoot, { backgroundColor: colors.drawerBackground }]}>
          <Animated.View
            style={[styles.sidebar, sidebarAnimStyle, { borderRightColor: colors.borderMuted }]}
          >
            <View style={{ width: sidebarWidth, flex: 1 }}>
              <DrawerContent />
            </View>
          </Animated.View>
          <View style={[styles.sidebarMain, { backgroundColor: colors.chatScreenBackground }]}>
            {activeElement}
          </View>
        </View>
        {/* ProfileSheet 仍由本层 host；侧栏底栏头像通过 ref 调起 */}
        <ProfileSheet sheetRef={profileSheetRef} />
      </DrawerProvider>
    );
  }

  return (
    <DrawerProvider value={handle}>
      <View style={[styles.root, { backgroundColor: colors.drawerBackground }]}>
        {/* 背后：抽屉本体（静止，不做 transform）；上叠 dim 层，刚拉开偏暗、展开到位才完全显形。
         *  抽屉内容外面包一层 GestureDetector(closeGestureOnDrawer)：用户在抽屉区域左滑也能
         *  关抽屉。activeOffsetX(-2) 保证 tap 不被吞（DrawerContent 内的列表项点击照常），
         *  failOffsetY(±80) 保证纵向 scroll > 80pt 后 pan fail（ScrollView 接管纵向滚动）。
         *  pointerEvents="box-none" 永远 live —— 不按 progress 翻 'auto'/'none'，否则关手势
         *  从 progress=1 滑到 0.5 这刻祖先 view 失活会打断进行中的 pan，造成跨阈值卡顿。 */}
        <View style={styles.drawerBack} pointerEvents="box-none">
          <GestureDetector gesture={closeGestureOnDrawer}>
            <View style={StyleSheet.absoluteFill}>
              <DrawerContent />
            </View>
          </GestureDetector>
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
             *  即激活。GestureDetector 持续 attached 避免 native gesture recognizer 重建。
             *  onTouchEnd 始终绑 close —— pointerEvents='none' 时 touch 不会到，不会误触。 */}
            <GestureDetector gesture={closeGesturePeek}>
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
               * 即激活（box-only），过半就让位给 closeGesture。GestureDetector 持续 attached。 */
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
  /** sidebarShell：左侧栏 + 右主区，横向排列 */
  sidebarShellRoot: {
    flexDirection: 'row',
  },
  /** push 侧栏：width 在 0↔SIDEBAR_WIDTH 间切换（Reanimated LinearTransition 原生插值）；overflow:hidden 让收起时内容被裁切不溢出。
   *  右侧 hairline 分隔；背景沿用 drawerBackground（root 已铺）。 */
  sidebar: {
    overflow: 'hidden',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  /** sidebarShell 右主区：吃掉剩余宽度，overflow:hidden 裁掉内容圆角/越界 */
  sidebarMain: {
    flex: 1,
    overflow: 'hidden',
  },
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
