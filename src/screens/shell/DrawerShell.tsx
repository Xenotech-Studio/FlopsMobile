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
  interpolateColor,
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
import { MiniAppListScreen } from '../MiniAppListScreen';
import { subscribeClientOutdated } from '../../utils/clientCompatBus';
import { getScreenCornerRadius, inferScreenCornerRadius, isSquareScreen } from '../../utils/screenInfo';
import { SHADOW_COLOR } from '../../theme/shadows';
import { useResponsive } from '../../hooks/useResponsive';
import { MainPaneNavigator } from '../../navigation/MainPaneNavigator';
import {
  DividerHandle,
  dividerHandleStyles,
  DIVIDER_TOGGLE_W,
  DIVIDER_TOGGLE_MARGIN,
  EDGE_INTERCEPT_LEFT,
} from './DividerHandle';
import {
  MainPaneProvider,
  useMainPaneController,
  useMainPaneIsSecondary,
  useMainPaneDocsTreeOpen,
  type MainPaneController,
} from './MainPaneContext';

/** 抽屉（左侧）展开宽度 —— 设计主值：抽屉宽度多少由这里定，右页露出多少 = 屏宽 − 此值（剩下的）。 */
const DRAWER_WIDTH = 300;
/** 右页至少保留的 peek 下限：窄屏上抽屉不至于吃满整屏，始终留一条可点空白/滑回。 */
const MIN_PEEK_WIDTH = 56;
/** 方形 / 近似方形屏（无物理圆角，按现有规则 detected===0）抽屉拉开卡片用的固定圆角。 */
const SQUARE_SCREEN_CARD_RADIUS = 50;
/** 右页卡片边缘描边全开时的颜色：Android 描边渲染更实更明显，用更淡的值。 */
const MAIN_EDGE_COLOR_OPEN = Platform.OS === 'android' ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.10)';
/** 抽屉自身 dim 上限：progress=0 时最暗、progress=1 时全亮（参考 Claude app 的「刚拉开抽屉偏暗、展开到位才完全显形」效果） */
const DRAWER_DIM_AT_CLOSED = 0.55;
/** 主页面（露出的右页）蒙白上限：progress=1（抽屉全开）时最白、progress=0 时全清。
 *  抽屉态下右页蒙一层半透明白「褪到背景」，凸显焦点在抽屉、右页是待返回的背景。 */
const MAIN_DIM_AT_OPEN = 0.6;
/** 抽屉内容限宽 = 露出区宽 − 此值。设 0：容器右缘正好贴右页左缘，灰框左右留白都由 DrawerContent 内的
 *  scrollContent.paddingHorizontal(16) 提供 → 灰框离屏左缘 / 离右页边缘相等(各 16)。
 *  露出区宽 = maxTranslateX = min(DRAWER_WIDTH, winWidth − MIN_PEEK_WIDTH)。对话标题靠 numberOfLines 在此宽度内省略。 */
const DRAWER_CONTENT_RIGHT_GAP = 2;
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

/** sidebarShell 侧栏收/展的布局过渡时长（ms）。Reanimated 在原生 UI 线程逐帧插值侧栏宽度（0↔SIDEBAR_WIDTH），
 *  主区 flex 自适应。直接写 shared value、不经 React → 零延迟。 */
const SIDEBAR_ANIM_DURATION = 280;

/* 分界线切换钮的尺寸/位置常量 + 胶囊视觉 + 拦截带 style 抽到 ./DividerHandle 共享
 * （DrawerShell 的 全局↔主区 手柄、DocsScreen 的 目录↔预览 手柄都用同一份）。 */

/** 在 MainPaneProvider 内部抓取 controller（填进 ref 供 setActive 驱动）+ 把"是否二级页"上报给
 *  DrawerShell（决定分界线切换钮是否显示）。侧栏在 Provider 外面，靠这个 grabber 桥接。不渲染 UI。 */
function MainPaneControllerGrabber({
  targetRef,
  onSecondaryChange,
  onDocsTreeOpenChange,
}: {
  targetRef: React.MutableRefObject<MainPaneController | null>;
  onSecondaryChange: (v: boolean) => void;
  onDocsTreeOpenChange: (v: boolean | null) => void;
}) {
  const ctrl = useMainPaneController();
  targetRef.current = ctrl;
  const isSecondary = useMainPaneIsSecondary();
  useEffect(() => {
    onSecondaryChange(isSecondary);
  }, [isSecondary, onSecondaryChange]);
  /* 文档页上报的目录树开关态（null=不在文档页）→ 提给 DrawerShell 判断全局手柄显隐。 */
  const docsTreeOpen = useMainPaneDocsTreeOpen();
  useEffect(() => {
    onDocsTreeOpenChange(docsTreeOpen);
  }, [docsTreeOpen, onDocsTreeOpenChange]);
  return null;
}

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

  /** 主页面完全展开时的圆角：优先用 native 实测（仅 Android 12+），否则用 inferScreenCornerRadius 查表兜底。
   *  方形 / 近似方形屏（按现有判定规则 detected===0，无物理圆角）：抽屉拉开的卡片不用真实圆角(=0 方角难看)，
   *  改用固定值 SQUARE_SCREEN_CARD_RADIUS(50)。圆角屏仍用真实测得/查表值。 */
  const mainRadiusOpen = useMemo(() => {
    /* 方形/近似方形屏判定走跟今日页搜索框「全宽」同一套 isSquareScreen（圆角 < 20）——
       关键：不能只看 detected===0，因为 Android native 实测会回一个很小的真实圆角(>0 但 <20)，
       那种屏搜索框是全宽的、卡片也该用固定 50，而不是那个小真实圆角。 */
    if (isSquareScreen(insets.top, nativeCornerRadius > 0 ? nativeCornerRadius : null)) {
      return SQUARE_SCREEN_CARD_RADIUS;
    }
    return nativeCornerRadius > 0 ? nativeCornerRadius : inferScreenCornerRadius(insets.top);
  }, [nativeCornerRadius, insets.top]);

  /** 抽屉展开比例：0 = 关闭，1 = 完全展开。reanimated shared value，UI 线程驱动动画。
   *  仅 compact（手机覆盖式抽屉）用。 */
  const progress = useSharedValue(0);

  /** 让位左缘开抽屉手势：文档板块（DocsScreen）focus 时置 true → iOS 左缘 strip 失活，
   *  把屏幕左缘让给文档自己的左缘手势（目录里开全局 / 预览里露目录），且不吞文档折叠点击。
   *  其余页面 strip 照常（保持原灵敏度）。仅 compact iOS strip 受影响。 */
  const openGestureSuppressed = useSharedValue(false);

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
  /** 纵向胶囊切换钮位置：展开时 left = 侧栏宽 − 半钮宽 → 中心骑在分界线上；
   *  折叠时（侧栏宽趋 0）被 DIVIDER_TOGGLE_MARGIN 托住 → 整个胶囊完整显示、离屏左缘有段距离。
   *  Math.max 让两态间随宽度连续过渡。 */
  const dividerToggleStyle = useAnimatedStyle(() => ({
    left: Math.max(
      DIVIDER_TOGGLE_MARGIN,
      sidebarAnimWidth.value - DIVIDER_TOGGLE_W / 2,
    ),
  }));
  /** 拖动拦截带的位置：跟手柄/分界线同步移动（不再钉死屏左缘）。
   *  分界线左侧 EDGE_INTERCEPT_LEFT、右侧 EDGE_INTERCEPT_RIGHT（盖满返回手势触发区）。
   *  折叠态 → 在左缘；展开态 → 在分界线，「中间这块」可拖关，且把分界线右边的返回触发区也盖住。
   *  clamp 到 0：折叠态 left 不为负，带紧贴屏左缘。 */
  const edgeInterceptStyle = useAnimatedStyle(() => ({
    left: Math.max(0, sidebarAnimWidth.value - EDGE_INTERCEPT_LEFT),
  }));
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

  /** ── 手柄拖动开合侧栏（完全跟手，类 iOS 抽屉手势）──
   *  拖动时 sidebarAnimWidth 直接跟手指走（UI 线程逐帧）；松手按位置过半 + 速度 flick 吸附到 0 / 满开。
   *  只在 sidebarShell 生效；手势挂在手柄外层 GestureDetector（见 render）。 */
  /** 手势起始时的侧栏宽度（手柄随侧栏移动，需记起点再叠加 translationX）。 */
  const dragStartWidth = useSharedValue(0);
  /** 一次拖动只允许一个 onEnd 落位：手柄/拦截带/侧栏三个 Pan 都由 buildHandlePan 造、在分界线处重叠，
   *  快速 flick 时可能两个同时识别 → 两次 onEnd（一个按位置吸开、一个按速度吸合）→ 松手先弹开再塌成无侧栏。
   *  用这个 shared flag 去重：onBegin 复位、onEnd 抢到才落位，后到的直接跳过。 */
  const dragSettledOnce = useSharedValue(false);
  /** 把最终态同步回 JS state（spring 落位后），供主区宽度 / DocBodyView / 旋转读。 */
  const settleSidebarState = useCallback(
    (open: boolean) => {
      setSidebarOpen(open);
    },
    [],
  );
  /** 手指落在手柄上时关掉主区返回手势、松手恢复——靠落点区分「拖手柄开侧栏」vs「页面左缘返回」，
   *  两者都保留。手柄折叠时正好在屏左缘、与返回手势触发区重叠，不这么做拖动会被返回手势抢走。 */
  const setMainPaneSwipeBack = useCallback((enabled: boolean) => {
    mainPaneControllerRef.current?.setSwipeBackEnabled(enabled);
  }, []);
  /** 拖动开合的 Pan 构造器：调一次返回一个独立实例。GestureDetector 不能把同一个 Gesture 对象挂到
   *  两个挂载点（内部 handlerTag 冲突），手柄 + 左缘拦截带各需一个实例，所以工厂化。
   *  SharedValue（dragStartWidth）跨实例共享——同一时刻只可能一条拖动在跑，状态合用没问题。 */
  const buildHandlePan = useCallback(
    (immediate: boolean) =>
      Gesture.Pan()
        /* 手柄实例：activeOffsetX±6 → 纯 tap（toggle）/纵向滑不被抢。
         *  拦截带实例（immediate）：±2 近乎落手即激活 → 抢在主区返回手势挪动卡片之前夺权，
         *  避免「页面先动一下」。拦截带是透明专用区、没有 tap 要保，可以激进。 */
        .activeOffsetX(immediate ? [-2, 2] : [-6, 6])
        .failOffsetY([-12, 12])
        .onBegin(() => {
          'worklet';
          dragStartWidth.value = sidebarAnimWidth.value;
          dragSettledOnce.value = false;
          /* 手指一落手柄就禁用返回手势 → 横向拖只开侧栏、不会触发返回。 */
          runOnJS(setMainPaneSwipeBack)(false);
        })
        .onUpdate((e) => {
          'worklet';
          /* 完全跟手：起始宽度 + 手指横向位移，clamp 到 [0, sidebarWidth]。 */
          const w = dragStartWidth.value + e.translationX;
          sidebarAnimWidth.value = Math.max(0, Math.min(sidebarWidth, w));
        })
        .onEnd((e) => {
          'worklet';
          /* 去重：手柄/拦截带/侧栏三个 Pan 在分界线处重叠，可能多个同时识别 → 多次 onEnd。
             只让第一个落位，后到的跳过。 */
          if (dragSettledOnce.value) return;
          dragSettledOnce.value = true;
          /* 吸附：速度过 flick 阈值按方向定；否则按是否过半。 */
          const flickOpen = e.velocityX > SWIPE_VELOCITY_THRESHOLD;
          const flickClose = e.velocityX < -SWIPE_VELOCITY_THRESHOLD;
          const open = flickOpen
            ? true
            : flickClose
              ? false
              : sidebarAnimWidth.value > sidebarWidth / 2;
          /* 极端 flick 速度（实测见过 -6251）灌进 spring 会数值过冲、冲过目标再回弹 → 视觉"先弹开再塌"。
             ① 注入速度 clamp 到合理区间；② overshootClamping 锁死不许冲过目标（0 / sidebarWidth）。 */
          const clampedV = Math.max(-2500, Math.min(2500, e.velocityX));
          sidebarAnimWidth.value = withSpring(open ? sidebarWidth : 0, {
            ...SPRING_CONFIG,
            overshootClamping: true,
            velocity: clampedV,
          });
          runOnJS(settleSidebarState)(open);
        })
        .onFinalize(() => {
          'worklet';
          /* 手势结束（含 cancel）恢复返回手势。 */
          runOnJS(setMainPaneSwipeBack)(true);
        }),
    [dragStartWidth, dragSettledOnce, sidebarAnimWidth, sidebarWidth, settleSidebarState, setMainPaneSwipeBack],
  );
  /** 手柄本体的拖动手势实例（保留 tap 共存阈值）。 */
  const handlePanGesture = useMemo(() => buildHandlePan(false), [buildHandlePan]);
  /** 拦截带的拖动手势实例（独立 handlerTag，近乎落手即激活，抢在返回手势挪卡片前夺权）。 */
  const edgeInterceptGesture = useMemo(() => buildHandlePan(true, 'edge'), [buildHandlePan]);
  /** 整个侧栏的拖动手势实例：在侧栏区域横向滑也能开合（跟手柄一致）。
   *  activeOffsetX±6 + failOffsetY 保证：tap 列表项、纵向 scroll DrawerContent 都不被抢，只有明确横向拖才接管。 */
  const sidebarPanGesture = useMemo(() => buildHandlePan(false, 'sidebar'), [buildHandlePan]);
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

  /** active 顶层页（compact 用；sidebarShell 下导航由主区嵌套栈接管，active 仅用于 DrawerContent 高亮） */
  const [active, setActive] = useState<DrawerActive>({ kind: 'today' });

  /** ProfileSheet 引用 */
  const profileSheetRef = useRef<BottomSheetModal>(null);

  /** sidebarShell：主区嵌套栈控制器（由 Provider 内的 grabber 填入）。compact 下保持 null。
   *  侧栏在 navigator 外面，靠这个 ref 驱动主区 push/reset。 */
  const mainPaneControllerRef = useRef<MainPaneController | null>(null);
  /** sidebarShell：主区当前是否停在二级页（对话等）。分界线切换钮只在二级页显示——
   *  一级页左上角汉堡已能开合侧栏，二级页左上角是返回键才需要这个钮兜底。grabber 上报。 */
  const [mainPaneSecondary, setMainPaneSecondary] = useState(false);
  /** sidebarShell：文档页上报的目录树开关态（null=不在文档页）。全局手柄显隐要用：
   *  G&&T 才在 全局↔目录 线上显示全局手柄；其余页面恒为 null → 维持原 mainPaneSecondary 行为。 */
  const [docsTreeOpen, setDocsTreeOpen] = useState<boolean | null>(null);

  /** 主页面 translateX 最大值 = 抽屉宽度（设计主值 DRAWER_WIDTH），即抽屉露出区宽度。
   *  窄屏夹断：抽屉宽不超过「屏宽 − 最小 peek」，保证右页始终留一条可点/可滑回的空白。 */
  const maxTranslateX = Math.min(DRAWER_WIDTH, winWidth - MIN_PEEK_WIDTH);
  /** 抽屉内容限宽：露出区宽 − 右留白。DrawerContent 包在此宽度里，高亮/标题按露出区布局，不戳右页背后。 */
  const drawerContentWidth = maxTranslateX - DRAWER_CONTENT_RIGHT_GAP;

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

  /** 文档抽屉式预览调它让位/恢复左缘开抽屉手势(写 shared value，UI 线程即时生效)。 */
  const setOpenGestureSuppressed = useCallback(
    (suppressed: boolean) => {
      openGestureSuppressed.value = suppressed;
    },
    [openGestureSuppressed]
  );

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
        /* sidebarShell：导航交给主区嵌套栈（push/reset，带右滑入动画 + 可返回），
         *  而不是原地 remount。今日/文档/项目 = reset 栈底；对话 = 在今日上 push。 */
        const ctrl = mainPaneControllerRef.current;
        if (ctrl) {
          switch (next.kind) {
            case 'today':
              ctrl.goToday();
              break;
            case 'docs':
              ctrl.goDocs();
              break;
            case 'miniApps':
              ctrl.goMiniApps();
              break;
            case 'project':
              ctrl.goProject(next.projectId, next.projectName);
              break;
            case 'chat':
              ctrl.openChat({
                conversationId: next.conversationId,
                conversationTitle: next.conversationTitle,
                createEncrypted: next.createEncrypted,
              });
              break;
          }
        }
        triggerDrawerHaptic();
        applySidebarOpen(sidebarDefaultOpen);
      } else {
        close();
      }
    },
    [close, sidebarShell, sidebarDefaultOpen, applySidebarOpen]
  );

  /** 左缘开抽屉手势：常挂载在覆盖手势条上，靠 openGestureWrapperProps 按 progress 切 pointerEvents 启停。 */
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
      /* 全开圆角偷偷比屏幕物理圆角大 5%：让卡片圆弧在视觉上「包住」屏幕圆角，两道弧不贴太近显局促。 */
      borderRadius: interpolate(progress.value, [0, 0.06], [0, mainRadiusOpen * 1.05], 'clamp'),
      /* 边缘描边：随 progress 从透明渐显到比阴影略重的黑，凸显右页卡片边。关闭态透明 → 全屏时不露线。
         Android 描边渲染更实/更明显，用更淡的值（iOS 0.10 / Android 0.04）。 */
      borderColor: interpolateColor(
        progress.value,
        [0, 0.06, 1],
        ['rgba(0,0,0,0)', MAIN_EDGE_COLOR_OPEN, MAIN_EDGE_COLOR_OPEN]
      ),
    };
  });

  /** 主页面 dim：抽屉越开右页越暗（progress=0 全亮、=1 最暗）。叠在右页内容上、不吞 touch。 */
  const animatedMainDimStyle = useAnimatedStyle(() => ({
    opacity: progress.value * MAIN_DIM_AT_OPEN,
  }));

  /** iOS：主页面阴影随 progress 平滑显隐（progress=0 完全无阴影，progress 一离开 0 就拉到峰值）。
   *  参考 Claude app：阴影很柔和、低不透明，仅作边缘层次提示而不是强黑边。 */
  const animatedShadowStyle = useAnimatedStyle(() => {
    return {
      shadowOpacity: interpolate(
        progress.value,
        [0, 0.05, 1],
        [0, 0.10, 0.10],
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
    () => ({
      pointerEvents:
        progress.value < 0.5 && !openGestureSuppressed.value
          ? ('box-only' as const)
          : ('none' as const),
    }),
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
      setOpenGestureSuppressed,
    }),
    [open, close, toggle, active, setActiveAndClose, presentProfileSheet, setOpenGestureSuppressed]
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
      case 'miniApps':
        return <MiniAppListScreen key="miniApps" />;
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
        <MainPaneProvider
          globalSidebarOpen={sidebarOpen}
          globalSidebarAnimWidth={sidebarAnimWidth}
          globalSidebarWidth={sidebarWidth}
          settleGlobalSidebarOpen={settleSidebarState}
        >
          {/* grabber：把主区嵌套栈 controller 填进 ref，供 setActiveAndClose 驱动 push/reset；
           *  同时把文档页上报的目录树开关态(docsTreeOpen)抽出来给本层（全局手柄显隐用）。 */}
          <MainPaneControllerGrabber
            targetRef={mainPaneControllerRef}
            onSecondaryChange={setMainPaneSecondary}
            onDocsTreeOpenChange={setDocsTreeOpen}
          />
          <View style={[styles.root, styles.sidebarShellRoot, { backgroundColor: colors.drawerBackground }]}>
            {/* 整个侧栏也接横向拖动开合（跟手柄一致）：activeOffsetX 保证 tap 列表项 / 纵向 scroll 不被抢。 */}
            <GestureDetector gesture={sidebarPanGesture}>
              <Animated.View
                style={[styles.sidebar, sidebarAnimStyle, { borderRightColor: colors.borderMuted }]}
              >
                <View style={{ width: sidebarWidth, flex: 1 }}>
                  <DrawerContent />
                </View>
              </Animated.View>
            </GestureDetector>
            {/* 主区：嵌套 stack navigator —— 点对话等在主区内右滑入盖住、可左滑/返回，侧栏不动 */}
            <View style={[styles.sidebarMain, { backgroundColor: colors.chatScreenBackground }]}>
              <MainPaneNavigator />
            </View>
          </View>

          {/* 骑在分界线上的纵向胶囊切换钮：跟随 sidebarAnimWidth 移动，折叠时离屏左缘有间距完整显示。
           *  仅二级页（对话等）显示——一级页左上角汉堡已能开合侧栏，二级页左上角是返回键才需要它兜底。
           *  用 AnimatedCircleButton → iOS 26+ 走 Liquid Glass material（跟顶角圆钮同款质感，
           *  系统自带投影 + 按压缩放）；iOS<26/Android 走 bouncy fallback，由 children Ionicons 渲染。
           *  形状（胶囊尺寸/圆角）由 dividerToggleBtn style 决定。 */}
          {/* 全局手柄（骑 全局↔目录 线）显隐：
           *  - 其余页面：docsTreeOpen===null → 维持原 mainPaneSecondary 行为（对话等二级页才显示）。
           *  - 文档页：仅 G(sidebarOpen) && T(docsTreeOpen) 才显示；G 关或 T 关都隐藏（目录手柄接管）。 */}
          {mainPaneSecondary || (docsTreeOpen === true && sidebarOpen) ? (
          <>
            {/* 左缘拦截带：在手柄那段高度，左缘放一条横向拖动手势区（跟手柄同一套 handlePanGesture）。
             *  它把这段 Y 的左缘 touch 接住 → 主区返回手势在此收不到 → 拖动只开侧栏、不返回（区域划分，
             *  无时序竞争，比 onBegin 临时禁用更可靠）。仅折叠态需要（展开态手柄已离开左缘），但常驻无害：
             *  展开态它在左缘、拖它一样是开合侧栏的有效区。pointerEvents 由 GestureDetector 接管。 */}
            <GestureDetector gesture={edgeInterceptGesture}>
              <Animated.View style={[dividerHandleStyles.edgeIntercept, edgeInterceptStyle]} />
            </GestureDetector>

            <Animated.View
              style={[
                dividerHandleStyles.dividerToggle,
                dividerToggleStyle,
              ]}
            >
              {/* 外层 GestureDetector 接拖动手势（完全跟手开合）；内层胶囊接 tap（toggle）。
               *  Pan 用 activeOffsetX 只在横向拖动时激活 → 纯 tap 不被抢、仍触发 toggle。 */}
              <GestureDetector gesture={handlePanGesture}>
                <DividerHandle onPress={toggle} iconColor={colors.textSecondary} />
              </GestureDetector>
            </Animated.View>
          </>
          ) : null}

          {/* ProfileSheet 仍由本层 host；侧栏底栏头像通过 ref 调起 */}
          <ProfileSheet sheetRef={profileSheetRef} />
        </MainPaneProvider>
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
            {/* 限宽到露出区：高亮/标题按露出宽度布局，不再戳到右页背后，标题提前省略。 */}
            <View style={[styles.drawerContentClip, { width: drawerContentWidth }]}>
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
                    shadowOffset: { width: -2, height: 0 },
                    shadowRadius: 4,
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

            {/* 主页面 dim：抽屉越开右页越暗，凸显焦点在抽屉。pointerEvents none 不挡下方手势捕获层。 */}
            <Animated.View
              style={[styles.mainDim, animatedMainDimStyle]}
              pointerEvents="none"
            />

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

        {/* 左缘开抽屉手势条：仅 iOS 挂载。文档板块 focus 时由 openGestureSuppressed 让位（strip 失活），
         *  把左缘交给文档自己的手势；其余页面照常用这条 strip 开抽屉（保持原灵敏度）。 */}
        {Platform.OS === 'ios' ? (
          <GestureDetector gesture={openGesture}>
            <Animated.View
              style={[styles.leftEdge, { width: LEFT_EDGE_STRIP_WIDTH }]}
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
  /* 分界线切换钮容器 / 胶囊本体 / 拦截带 style 移到 ./DividerHandle（dividerHandleStyles）。 */
  drawerBack: {
    ...StyleSheet.absoluteFillObject,
  },
  /** 外层：fill 容器，承载 transform + shadow；不能 overflow:hidden（否则阴影被裁掉） */
  mainOuter: {
    ...StyleSheet.absoluteFillObject,
  },
  /** 内层：承载 borderRadius + overflow:hidden 来裁剪 children；shadow 不放这里。
   *  borderWidth 常驻、borderColor 由 animatedMainInnerStyle 随 progress 渐显（关闭态透明）。 */
  mainInner: {
    flex: 1,
    overflow: 'hidden',
    /* Android 边线渲染更实，用 hairline；iOS 用 1pt。颜色由 animatedMainInnerStyle 渐显。 */
    borderWidth: Platform.OS === 'android' ? StyleSheet.hairlineWidth : 1,
    borderColor: 'rgba(0,0,0,0)',
    /* iOS continuous corner curve（squircle）：圆弧↔直线 G2 连续过渡，跟系统圆角同质感。
       默认 'circular' 是正圆弧、交接处曲率突变，看着「不够顺」。Android 忽略此 prop。 */
    borderCurve: 'continuous',
  },
  /** 抽屉本体限宽容器：钉左缘、撑满高、宽度由 drawerContentWidth 指定（露出区 − 右留白）。 */
  drawerContentClip: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  /** 主页面蒙白遮罩：铺满右页、纯白、opacity 由 animatedMainDimStyle 跟 progress 走（抽屉态褪到背景） */
  mainDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#fff',
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
