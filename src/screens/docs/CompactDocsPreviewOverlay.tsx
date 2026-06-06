/**
 * CompactDocsPreviewOverlay —— 手机端「文档预览」抽屉式前景层。
 *
 * 关系（与手机顶层抽屉同构）：预览页 = 抽屉的「主页面」(前景、可右移)，文档目录树 = 背景面板。
 * 复用 DrawerShell compact 分支同一套 reanimated 机制，并多出一个「继续右滑彻底 dismiss」相位。
 *
 * 单一 shared value `tx`（0..winWidth）三个停靠位：
 *  - tx = 0           → 完整预览（盖住目录）。打开后的静息态。
 *  - tx = maxTranslateX → 半开（目录露出左侧、预览 peek 右侧；蒙白 + 投影 + 描边 + 圆角）。
 *  - tx = winWidth    → 完全移出 → 调 onDismiss() 卸载。
 * 蒙白/阴影/描边/圆角由 peek = clamp(tx/maxTranslateX, 0, 1) 驱动（0=完整、1=半开）。
 *
 * 仅手机端（compact）渲染；iPad 用整页 DocPreview 路由（不挂本组件）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  interpolate,
  interpolateColor,
  Extrapolation,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { FlowDocTreeItem } from '../../api';
import {
  getScreenCornerRadiusSync,
  inferScreenCornerRadius,
  isSquareScreen,
} from '../../utils/screenInfo';
import { SHADOW_COLOR } from '../../theme/shadows';
import { DocPreviewScreen } from './DocPreviewScreen';
import { docsTreeStore } from './docsTreeStore';

/** 文件夹类项：选中时停在半开（不关抽屉、只更新右卡片内容）；文档类停在完整（关抽屉进入）。 */
const FOLDER_LIKE_TYPES = new Set(['folder', 'cooperateInbox']);

/* ── 与 DrawerShell 同值，保证手感一致 ── */
const DRAWER_WIDTH = 300;
const MIN_PEEK_WIDTH = 56;
const SQUARE_SCREEN_CARD_RADIUS = 50;
/** 半开时白遮罩最大不透明度（半透明：内容透出来不消失，整体明显偏白）。 */
const MAIN_DIM_AT_OPEN = 0.7;
const MAIN_EDGE_COLOR_OPEN =
  Platform.OS === 'android' ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.10)';
const SPRING_CONFIG = {
  damping: 28,
  stiffness: 360,
  mass: 0.5,
  overshootClamping: false,
} as const;
const SWIPE_THRESHOLD = 60;
const SWIPE_VELOCITY_THRESHOLD = 400;
const PAN_ACTIVE_OFFSET_X = 2;
const PAN_FAIL_OFFSET_Y = 80;
const LEFT_EDGE_STRIP_WIDTH = Platform.OS === 'android' ? 56 : 40;

function triggerHaptic() {
  ReactNativeHapticFeedback.trigger('impactLight', { enableVibrateFallback: true });
}

export type CompactDocsPreviewOverlayProps = {
  /** 当前预览项 id（父级 DocsScreen 的 previewId，非空时本组件才挂载）。 */
  previewId: string;
  /** 文件夹内点子项 → 原地替换 previewId（不叠层、不重新滑入）。 */
  onReplaceChild: (child: FlowDocTreeItem) => void;
  /** 预览彻底关闭（右滑/返回到底）→ 父级置 previewId=null 卸载本组件。 */
  onDismiss: () => void;
  /** 卡片横向位移 shared value，由父级 DocsScreen 持有（这样目录宽度能跟 dismiss 进度联动）。 */
  tx: SharedValue<number>;
};

export function CompactDocsPreviewOverlay({
  previewId,
  onReplaceChild,
  onDismiss,
  tx,
}: CompactDocsPreviewOverlayProps) {
  const { width: winWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /** 预览右移到此 = 半开；目录露出 maxTranslateX，预览右边 peek 出 winWidth−maxTranslateX。 */
  const maxTranslateX = Math.min(DRAWER_WIDTH, winWidth - MIN_PEEK_WIDTH);

  /** 半开态卡片圆角：方形屏固定 50，圆角屏用真实测得/查表值。 */
  const mainRadiusOpen = useMemo(() => {
    const nativeRadius = getScreenCornerRadiusSync();
    if (isSquareScreen(insets.top, nativeRadius)) return SQUARE_SCREEN_CARD_RADIUS;
    return nativeRadius && nativeRadius > 0
      ? nativeRadius
      : inferScreenCornerRadius(insets.top);
  }, [insets.top]);

  /* 挂载即从屏右滑入：文件夹停在半开（目录露出、右卡片显示文件夹内容），文档滑到完整。
   *  空依赖：子项 replace 时 previewId prop 变化但不重挂。 */
  useEffect(() => {
    tx.value = winWidth;
    const item = docsTreeStore.get(previewId);
    const isFolder = !!item && FOLDER_LIKE_TYPES.has(item.type);
    tx.value = withSpring(isFolder ? maxTranslateX : 0, SPRING_CONFIG);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 切换预览项（目录点条目 / 文件夹内点子项）→ 文件夹：停半开（不关抽屉，只更新右卡片内容）；
   *  文档：回完整（关抽屉进入）。跳过首次挂载（首挂的滑入由上面的 mount effect 负责）。 */
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const item = docsTreeStore.get(previewId);
    const isFolder = !!item && FOLDER_LIKE_TYPES.has(item.type);
    tx.value = withSpring(isFolder ? maxTranslateX : 0, SPRING_CONFIG);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId]);


  /** 半开（目录按钮 / 左缘右拖到位）。 */
  const goPeek = useCallback(() => {
    triggerHaptic();
    tx.value = withSpring(maxTranslateX, SPRING_CONFIG);
  }, [tx, maxTranslateX]);

  /** 回到完整预览（点半开预览 / 左滑回）。 */
  const goFull = useCallback(() => {
    triggerHaptic();
    tx.value = withSpring(0, SPRING_CONFIG);
  }, [tx]);

  /** 左上角目录按钮：完整态→半开；抽屉态→回完整（跟点页面其他地方一致，native 按钮浮在捕获层上
   *  接管了点击，所以这里按当前 tx 自行判断）。tx.value 在 JS 线程可读。 */
  const onDirectoryButton = useCallback(() => {
    if (tx.value > maxTranslateX * 0.5) {
      goFull();
    } else {
      goPeek();
    }
  }, [tx, maxTranslateX, goFull, goPeek]);

  /** 彻底关闭：移出屏右后置 previewId=null。 */
  const dismiss = useCallback(() => {
    triggerHaptic();
    tx.value = withSpring(winWidth, SPRING_CONFIG, (finished) => {
      'worklet';
      if (finished) runOnJS(onDismiss)();
    });
  }, [tx, winWidth, onDismiss]);

  /* Android 系统返回：完整→半开、半开→dismiss。本组件仅在 preview 存在时挂载，
     listener 后挂载先触发（LIFO）→ 优先于 DrawerShell 的全局返回。 */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tx.value > maxTranslateX - 1) {
        dismiss();
      } else {
        goPeek();
      }
      return true;
    });
    return () => sub.remove();
  }, [tx, maxTranslateX, dismiss, goPeek]);

  /* ── 手势 ── */

  /** 半开捕获层的 Pan：双向拖动，松手三选一 snap 到 {完整 / 半开 / dismiss}。 */
  const peekPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-PAN_ACTIVE_OFFSET_X, PAN_ACTIVE_OFFSET_X])
        .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
        .onUpdate((e) => {
          'worklet';
          tx.value = Math.max(0, Math.min(winWidth, maxTranslateX + e.translationX));
        })
        .onEnd((e) => {
          'worklet';
          const v = e.velocityX;
          const cur = tx.value;
          let target: number;
          if (v < -SWIPE_VELOCITY_THRESHOLD) {
            target = 0; // 快速左 flick → 完整
          } else if (v > SWIPE_VELOCITY_THRESHOLD) {
            target = winWidth; // 快速右 flick → dismiss
          } else if (cur < maxTranslateX - SWIPE_THRESHOLD) {
            target = 0; // 左拖过线 → 完整
          } else if (cur > maxTranslateX + (winWidth - maxTranslateX) * 0.4) {
            target = winWidth; // 右拖过线 → dismiss
          } else {
            target = maxTranslateX; // 维持半开
          }
          runOnJS(triggerHaptic)(); // 松手 snap 咔哒反馈（同全局抽屉）
          if (target === winWidth) {
            tx.value = withSpring(
              winWidth,
              { ...SPRING_CONFIG, velocity: v },
              (finished) => {
                'worklet';
                if (finished) runOnJS(onDismiss)();
              }
            );
          } else {
            tx.value = withSpring(target, { ...SPRING_CONFIG, velocity: v });
          }
        }),
    [tx, maxTranslateX, winWidth, onDismiss]
  );

  /** iOS 左缘开 strip 的 Pan：右拖 0→maxTranslateX，松手 commit/flick → 半开 or 完整。 */
  const openPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(PAN_ACTIVE_OFFSET_X)
        .failOffsetY([-PAN_FAIL_OFFSET_Y, PAN_FAIL_OFFSET_Y])
        .onUpdate((e) => {
          'worklet';
          tx.value = Math.max(0, Math.min(maxTranslateX, e.translationX));
        })
        .onEnd((e) => {
          'worklet';
          const opening =
            tx.value > SWIPE_THRESHOLD || e.velocityX > SWIPE_VELOCITY_THRESHOLD;
          runOnJS(triggerHaptic)(); // 松手 snap 咔哒反馈（同全局抽屉）
          tx.value = withSpring(opening ? maxTranslateX : 0, {
            ...SPRING_CONFIG,
            velocity: e.velocityX,
          });
        }),
    [tx, maxTranslateX]
  );

  /* ── 动画样式（peek 在各 worklet 内由 tx 推算） ── */

  const outerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  const shadowStyle = useAnimatedStyle(() => {
    const peek = Math.min(1, Math.max(0, tx.value / maxTranslateX));
    return {
      shadowOpacity: interpolate(peek, [0, 0.05, 1], [0, 0.2, 0.2], Extrapolation.CLAMP),
    };
  });

  /** 预览基底色（完整态）。开抽屉时把背景（在内容之下）随进度渐变到纯白，文字始终在上层、不被遮挡。 */
  const baseBg = colors.chatScreenBackground;
  const innerStyle = useAnimatedStyle(() => {
    const peek = Math.min(1, Math.max(0, tx.value / maxTranslateX));
    return {
      borderRadius: interpolate(peek, [0, 0.06], [0, mainRadiusOpen * 1.05], 'clamp'),
      borderColor: interpolateColor(
        peek,
        [0, 0.06, 1],
        ['rgba(0,0,0,0)', MAIN_EDGE_COLOR_OPEN, MAIN_EDGE_COLOR_OPEN]
      ),
      /* 背景随抽屉进度渐变：peek 0→1 = chatScreenBackground → 纯白（打开到位 = 纯白卡片）。 */
      backgroundColor: interpolateColor(peek, [0, 1], [baseBg, '#ffffff']),
    };
  });

  /** 白遮罩：叠在内容之上，随开抽屉越来越白（半透明，文字透出不消失）。与背景渐变叠加。 */
  const dimStyle = useAnimatedStyle(() => {
    const peek = Math.min(1, Math.max(0, tx.value / maxTranslateX));
    return { opacity: peek * MAIN_DIM_AT_OPEN };
  });

  /* 半开捕获层激活：peek > 0.5 时接管点击（回完整）+ 拖动。 */
  const peekCaptureProps = useAnimatedProps(() => {
    const peek = Math.min(1, Math.max(0, tx.value / maxTranslateX));
    return { pointerEvents: peek > 0.5 ? ('auto' as const) : ('none' as const) };
  });
  /* iOS 左缘 strip 激活：peek < 0.5 时（接近完整）才接管右拖开。 */
  const openStripProps = useAnimatedProps(() => {
    const peek = Math.min(1, Math.max(0, tx.value / maxTranslateX));
    return { pointerEvents: peek < 0.5 ? ('box-only' as const) : ('none' as const) };
  });

  /** Android：elevation 不能用 reanimated 动态值（会闪），用 JS state 在 peek 离开 0 时开。 */
  const [shadowOn, setShadowOn] = useState(false);
  useAnimatedReaction(
    () => tx.value > 0.5,
    (curr, prev) => {
      'worklet';
      if (prev == null) return;
      if (curr !== prev) runOnJS(setShadowOn)(curr);
    }
  );

  /** 左上角目录按钮随开抽屉淡出（峰值 opacity 1−0.7=0.3），融入渐变到纯白的卡片背景。 */
  const headerLeftStyle = useAnimatedStyle(() => {
    const peek = Math.min(1, Math.max(0, tx.value / maxTranslateX));
    return { opacity: 1 - peek * MAIN_DIM_AT_OPEN };
  });

  return (
    <Animated.View
      style={[
        styles.outer,
        outerStyle,
        Platform.OS === 'ios'
          ? [
              {
                shadowColor: SHADOW_COLOR,
                shadowOffset: { width: -3, height: 0 },
                shadowRadius: 12,
              },
              shadowStyle,
            ]
          : null,
      ]}
    >
      <Animated.View
        style={[
          styles.inner,
          innerStyle,
          Platform.OS === 'android' && shadowOn
            ? { elevation: 28, shadowColor: SHADOW_COLOR }
            : null,
        ]}
      >
        <DocPreviewScreen
          id={previewId}
          onGoDirectory={onDirectoryButton}
          onSelectChild={onReplaceChild}
          headerLeftStyle={headerLeftStyle}
        />

        {/* 白遮罩：叠在内容之上、随开抽屉变白；半透明，文字透出不消失（与背景渐变叠加）。 */}
        <Animated.View style={[styles.dim, dimStyle]} pointerEvents="none" />

        {/* 半开捕获层：点回完整 + 拖动 snap。 */}
        <GestureDetector gesture={peekPan}>
          <Animated.View
            style={StyleSheet.absoluteFill}
            animatedProps={peekCaptureProps}
            onTouchEnd={goFull}
          />
        </GestureDetector>

        {/* iOS 左缘开 strip：右拖露目录（半开）。Android 不挂（靠目录按钮 + 系统返回）。 */}
        {Platform.OS === 'ios' ? (
          <GestureDetector gesture={openPan}>
            <Animated.View
              style={[styles.leftEdge, { width: LEFT_EDGE_STRIP_WIDTH }]}
              animatedProps={openStripProps}
              collapsable={false}
            />
          </GestureDetector>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

function createStyles(_c: AppColors) {
  return StyleSheet.create({
    outer: { ...StyleSheet.absoluteFillObject },
    inner: {
      flex: 1,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
    },
    dim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#ffffff' },
    leftEdge: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  });
}
