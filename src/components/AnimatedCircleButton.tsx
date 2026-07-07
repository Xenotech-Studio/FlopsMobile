/**
 * 顶栏圆按钮（汉堡 / 返回 / + / 筛选 / 日历 / ⋯ 等）通用的按下反馈。
 *
 * iOS 26+：走 BouncyButtonNative 原生组件，内部托管真 UIButton +
 *   `[UIButtonConfiguration glassButtonConfiguration]`——Liquid Glass material +
 *   按下时 scale + 折光 + spring + bend 全部由系统接管。我们这边的"白圈 + 阴影"样式
 *   会被自动剥掉，让玻璃做背景（这是用户决定的设计：iOS 26 上完全交给玻璃）。
 *
 * iOS 15..25：走 BouncyButtonNative 的 legacy 路径，UIView + 手写 spring scale，
 *   保留白圈 + 阴影视觉。
 *
 * Android：走 Reanimated worklet + RNGH GestureDetector，worklet 在 UI 线程触发
 *   withSpring，是 RN 侧能做到的最接近原生的方案。
 *
 * 对外 API：onPress / disabled / hitSlop / style / pressScale。
 */
import React, { useCallback, useMemo } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import BouncyButtonNative from '../flowdoc-native-input/spec/BouncyButtonViewNativeComponent';

export type AnimatedCircleButtonMenuAction = {
  /** 选中时回调里收到的 id；JS 侧自己保证唯一 */
  id: string;
  /** 菜单显示的标题（必填） */
  title: string;
  /** SF Symbol 名（左侧图标），如 'speaker.wave.2'。空/缺省 = 无图标 */
  image?: string;
  /** 勾选态：'on' 显示 ✓、'off' 不显示。用于把菜单项当开关（切换后重建 UIMenu 生效） */
  state?: 'on' | 'off' | 'mixed';
  /** 在该项前起一条分隔线（native 把它之前 / 之后拆成两个 displayInline 区段，中间画线） */
  sectionBreakBefore?: boolean;
  /** 显示成"危险/红字"风格 */
  destructive?: boolean;
  /** 灰掉不可选 */
  disabled?: boolean;
};

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 按下放大到多少（默认 1.12）。iOS 26+ glass 路径下不生效（系统决定缩放幅度） */
  pressScale?: number;
  onPress?: () => void;
  disabled?: boolean;
  /** Android 路径有效；iOS 原生路径不消费 hitSlop——touch 区域以 view bounds 为准 */
  hitSlop?:
    | number
    | { top?: number; bottom?: number; left?: number; right?: number };
  /** iOS 26+ glass 路径上的"按下直接弹原生 UIMenu"模式。
   *  传非空数组时，UIButton 会 set menu + showsMenuAsPrimaryAction=YES——按下不发 onPress，
   *  改发 onMenuAction(actionId)。空数组 / 未传 = 普通 onPress 按钮。
   *  在 iOS < 26 / Android 上此 prop 被忽略——上层应当走 MenuView / 自绘 popover。 */
  menuActions?: ReadonlyArray<AnimatedCircleButtonMenuAction>;
  /** 用户从 UIMenu 选中一条 action 时触发（仅 iOS 26+ glass + menuActions 非空时） */
  onMenuAction?: (actionId: string) => void;
  /** iOS 26+ glass + menuActions 非空时：UIButton 即将弹出 UIMenu（touchDown 时序）。
   *  callsite 可以借此做"让位"类的 UI 联动。其它路径（iOS<26 / Android / 无 menuActions）不发。
   *  上层若要在 iOS<26 / Android 上做同款联动，自己监听 MenuView/Modal 的 onOpen 即可。 */
  onMenuWillShow?: () => void;
  /** menu 关闭（选项触发 / 外部 tap dismiss）后触发。与 onMenuWillShow 成对。仅 iOS 26+ glass。 */
  onMenuDidDismiss?: () => void;
  /** iOS 26+ glass 路径下用 SF Symbol 作为按钮 icon，直接进 UIButton.configuration.image。
   *  好处：icon 是 UIButton native content 的一部分，系统 interactive glass scale + menu
   *  morph 时 icon 100% 跟动，绝不脱节。
   *  在 iOS < 26 / Android 上此 prop 被忽略，由 children（通常是 Ionicons）渲染。 */
  iosSfSymbol?: {
    name: string;
    /** point size（默认 22）。 */
    size?: number;
    /** "#RRGGBB" / "#AARRGGBB"。缺省走 system label color。 */
    color?: string;
  };
  /** iOS 26+ glass 路径下用 native title 作为按钮文字内容（UIButton.configuration.title）。
   *  跟 iosSfSymbol 一样，文字是 UIButton native content 的一部分，跟 button 一起 scale。
   *  可以跟 iosSfSymbol 共存（image + title 并列）。 */
  iosNativeTitle?: {
    text: string;
    /** "#RRGGBB" / "#AARRGGBB"。缺省走 system label color。 */
    color?: string;
  };
  /** iOS 26+ glass 路径下用 UIButton 内置 spinner（iOS 16+ API）取代 image/title。
   *  适合 "loading / submitting" 状态。spinner 也跟着 button 一起 scale。 */
  iosShowsSpinner?: boolean;
  /** iOS 26+ glass 路径下给玻璃材质上色（"#RRGGBB" / "#AARRGGBB"）。空 = 默认无 tint
   *  半透明玻璃。深色按钮（如选中 tab / primary action）传一个跟 UI 主色一致的 hex 即可。
   *  跟 `iosGlassProminent` 配合：`true` 走 prominent (有实色块感)，`false` 走 regular (淡 tint 半透明)。
   *  在 iOS < 26 / Android 上忽略。 */
  iosGlassTintColor?: string;
  /** iOS 26+ glass 路径下选 prominent vs regular。默认 false。
   *  prominent 适合需要强烈视觉权重的「主操作 / 选中态」，regular 适合次要按钮。
   *  iOS < 26 / Android 忽略。 */
  iosGlassProminent?: boolean;
  /** iOS 强制走 Reanimated worklet 路径（跟 Android 同款）—— bypass iOS 26 glass material。
   *  适合不需要玻璃质感的次要按钮，需要：
   *    - 完全自定义 bg 色（包括 solid 浅灰、纯黑等 glass 给不出来的色）
   *    - 不要 glass material 固有的 drop shadow
   *    - React children 自由 mixed-font / 多 Text 组合
   *  仍有 UI 线程 bouncy press 反馈（withSpring on shared value），只是没玻璃材质。 */
  iosForceWorklet?: boolean;
  /** 控制是否渲染 React children（iOS < 26 / Android fallback content）。默认 auto——
   *  当任何 ios native content prop（iosSfSymbol / iosNativeTitle / iosShowsSpinner）在
   *  iOS 26+ glass 路径上生效时，自动不渲染 children；其它情况渲染。
   *  显式传 'always' / 'never' 可覆盖（少见，主要给同时想画 native title + 自定义 React
   *  badge 的场景）。 */
  childrenRendering?: 'auto' | 'always' | 'never';
};

const PRESS_SPRING = { mass: 1, stiffness: 400, damping: 40 };
const RELEASE_SPRING = { mass: 1, stiffness: 220, damping: 14 };

/* iOS 26+ 判定：让 BouncyButton 走 Liquid Glass 路径。Platform.Version 在 iOS 上是
   字符串形式的主版本号（"26.0" / "26" 都可能），用 parseFloat 兜底；非 iOS 时直接 false。
   export 出来给上层 screen 决定走原生 UIMenu (iOS 26+) 还是 MenuView fallback (iOS 24/25)。 */
export const IS_IOS_LIQUID_GLASS =
  Platform.OS === 'ios' && parseFloat(String(Platform.Version)) >= 26;

// 一次性诊断输出：跑起来后看 metro 日志，确认 JS 这边走的是哪条路
if (__DEV__) {
  console.log(
    '[AnimatedCircleButton] Platform.OS=', Platform.OS,
    'Platform.Version=', Platform.Version,
    'IS_IOS_LIQUID_GLASS=', IS_IOS_LIQUID_GLASS,
  );
}

export function AnimatedCircleButton(props: Props) {
  /* iosForceWorklet=true：iOS 也走 Reanimated worklet 路径（跟 Android 一致）—— 适合不需要
   * 玻璃质感的次要按钮（如 folder tab），可自由控制纯 bg 色 / shadow / mixed-font children
   * 而不被 iOS 26 glass material 的固有 drop shadow / 单一 title 限制。仍然有 native-feel
   * bouncy（worklet 在 UI 线程跑）。 */
  if (Platform.OS === 'ios' && !props.iosForceWorklet) {
    return <IosNativeBouncy {...props} />;
  }
  return <AndroidWorkletBouncy {...props} />;
}

// MARK: - iOS native path

/* iOS 26+ 下剥掉调用方传进来的 backgroundColor / shadow* / elevation，把视觉完全交给
   系统 glass material。size / borderRadius / 居中布局等保留——它们决定按钮的"形状"
   和"位置"，跟材质无关。 */
function stripForGlass(style?: StyleProp<ViewStyle>): ViewStyle | undefined {
  if (!style) return undefined;
  const flat = StyleSheet.flatten(style) as ViewStyle | undefined;
  if (!flat) return undefined;
  const {
    backgroundColor: _bg,
    shadowColor: _sc,
    shadowOffset: _so,
    shadowOpacity: _sop,
    shadowRadius: _sr,
    elevation: _el,
    borderColor: _bc,
    borderWidth: _bw,
    borderTopWidth: _btw,
    borderBottomWidth: _bbw,
    borderLeftWidth: _blw,
    borderRightWidth: _brw,
    ...rest
  } = flat as ViewStyle & { elevation?: number };
  return rest;
}

function IosNativeBouncy({
  children,
  style,
  pressScale = 1.12,
  onPress,
  disabled,
  menuActions,
  onMenuAction,
  onMenuWillShow,
  onMenuDidDismiss,
  iosSfSymbol,
  iosNativeTitle,
  iosShowsSpinner,
  iosGlassTintColor,
  iosGlassProminent,
  childrenRendering = 'auto',
}: Props) {
  const handleNativePress = useCallback(
    (_e: NativeSyntheticEvent<Readonly<{}>>) => {
      onPress?.();
    },
    [onPress],
  );
  const handleNativeMenuAction = useCallback(
    (e: NativeSyntheticEvent<Readonly<{ actionId: string }>>) => {
      onMenuAction?.(e.nativeEvent.actionId);
    },
    [onMenuAction],
  );
  const handleNativeMenuWillShow = useCallback(
    (_e: NativeSyntheticEvent<Readonly<{}>>) => {
      onMenuWillShow?.();
    },
    [onMenuWillShow],
  );
  const handleNativeMenuDidDismiss = useCallback(
    (_e: NativeSyntheticEvent<Readonly<{}>>) => {
      onMenuDidDismiss?.();
    },
    [onMenuDidDismiss],
  );
  const finalStyle = IS_IOS_LIQUID_GLASS ? stripForGlass(style) : style;
  /* menuActions 仅在 iOS 26+ glass 路径上生效（原生 UIButton.menu）。其它情况上层应当走
     MenuView / 自绘 popover，所以这里不序列化避免噪声。
     用 useMemo 缓存 JSON 字符串：menuActions 通常是稳定数组，避免每渲染 stringify 触发 native
     的 menuActionsJson diff（diff 不等就会重建 UIMenu，里面用户已经展开的弹层会被吞）。 */
  const menuActionsJson = useMemo(() => {
    if (!IS_IOS_LIQUID_GLASS) return '';
    if (!menuActions || menuActions.length === 0) return '';
    return JSON.stringify(
      menuActions.map((a) => ({
        id: a.id,
        title: a.title,
        ...(a.image ? { image: a.image } : null),
        ...(a.state ? { state: a.state } : null),
        ...(a.sectionBreakBefore ? { sectionBreakBefore: true } : null),
        ...(a.destructive ? { destructive: true } : null),
        ...(a.disabled ? { disabled: true } : null),
      })),
    );
  }, [menuActions]);
  /* iOS 26+ glass 路径下 native content 三件套：SF Symbol image / native title / spinner。
     任一存在时让 UIButton 自己画。
     但 React children 我们**始终渲染**（除非 callsite 显式 childrenRendering='never'）——
     原因：Yoga 用 children 测量 button 的 intrinsic size（width/height）。如果不渲染，
     button 被压成最小 size（只剩 padding），native title 就被截断成 1-2 字。
     iOS 26 有 native content 时给 children 套一个 opacity:0 wrapper，视觉隐藏但仍贡献
     layout sizing。iOS<26 / Android 没 native content，children 完全可见（fallback 路径）。 */
  const hasNativeSymbol =
    IS_IOS_LIQUID_GLASS && !!iosSfSymbol && iosSfSymbol.name.length > 0;
  const hasNativeTitle =
    IS_IOS_LIQUID_GLASS && !!iosNativeTitle && iosNativeTitle.text.length > 0;
  const hasSpinner = IS_IOS_LIQUID_GLASS && !!iosShowsSpinner;
  const usingAnyNativeContent = hasNativeSymbol || hasNativeTitle || hasSpinner;
  const shouldRenderChildren = childrenRendering !== 'never';
  /* 仅 iOS 26 + 有 native content 时把 children 套 opacity:0 wrapper —— layout 还在，视觉
     消失，让 UIButton 的 native content 独占可见性。 */
  const hideChildrenForNativeContent = IS_IOS_LIQUID_GLASS && usingAnyNativeContent;
  return (
    <BouncyButtonNative
      style={finalStyle}
      pressScale={pressScale}
      bouncyDisabled={!!disabled}
      menuActionsJson={menuActionsJson}
      sfSymbolName={hasNativeSymbol ? iosSfSymbol!.name : ''}
      sfSymbolPointSize={hasNativeSymbol ? (iosSfSymbol!.size ?? 22) : 22}
      sfSymbolColorHex={hasNativeSymbol ? (iosSfSymbol!.color ?? '') : ''}
      nativeTitle={hasNativeTitle ? iosNativeTitle!.text : ''}
      nativeTitleColorHex={hasNativeTitle ? (iosNativeTitle!.color ?? '') : ''}
      showsActivityIndicator={hasSpinner}
      glassTintColorHex={IS_IOS_LIQUID_GLASS ? (iosGlassTintColor ?? '') : ''}
      glassProminent={IS_IOS_LIQUID_GLASS ? !!iosGlassProminent : false}
      onBouncyPress={handleNativePress}
      onMenuAction={handleNativeMenuAction}
      onMenuWillShow={handleNativeMenuWillShow}
      onMenuDidDismiss={handleNativeMenuDidDismiss}
    >
      {shouldRenderChildren ? (
        hideChildrenForNativeContent ? (
          /* opacity:0 wrapper：layout 还在，视觉消失；pointerEvents=none 避免它截 touch。
             用 absolute fill 让 wrapper 不挤占 native content 的空间（native title 在 UIButton
             自己的 content layer，跟这层 wrapper 不在同一个 layout 流里）。等等——absolute
             不参与父容器尺寸测量。所以反过来：不要 absolute，让 wrapper 正常 flex layout
             撑出父容器宽高，让 Yoga 测出来；native content 在 UIButton 自己的可视层。 */
          <View style={{ opacity: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }} pointerEvents="none">
            {children}
          </View>
        ) : (
          children
        )
      ) : null}
    </BouncyButtonNative>
  );
}

// MARK: - Android (Reanimated worklet) path

function AndroidWorkletBouncy({
  children,
  style,
  /* Android 默认 1.4（iOS 1.12）：RN press 反馈在 Android 上由 Reanimated worklet
   * 自己驱动，没有系统级触觉/glass scale 加成，倍率不调大体感偏弱。圆形 view scale
   * 各方向均匀放大不会失真；callsite 仍可覆盖。 */
  pressScale = 1.4,
  onPress,
  disabled,
  hitSlop,
}: Props) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const gesture = useMemo(() => {
    let g = Gesture.Tap()
      .enabled(!disabled)
      .maxDuration(10000)
      /* maxDistance 放大：按下后手指在按钮范围内略微移动不要判定 tap 失败而回弹缩小——
       * 跟 iOS legacy（touchesMoved 不动、保持放大）一致。只在手指真正离开按钮(shouldCancelWhenOutside
       * 默认 true)或松手时才结束。父级 ScrollView/Pan 抢走手势仍会 cancel → onFinalize 正常回弹。 */
      .maxDistance(10000)
      .onBegin(() => {
        'worklet';
        scale.value = withSpring(pressScale, PRESS_SPRING);
      })
      .onFinalize(() => {
        'worklet';
        scale.value = withSpring(1, RELEASE_SPRING);
      })
      .onEnd((_e, success) => {
        'worklet';
        if (success && onPress) {
          runOnJS(onPress)();
        }
      });
    if (hitSlop !== undefined) {
      g = g.hitSlop(hitSlop as any);
    }
    return g;
  }, [disabled, onPress, hitSlop, pressScale, scale]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[style, animatedStyle]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
