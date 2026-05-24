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
  if (Platform.OS === 'ios') {
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
  iosSfSymbol,
  iosNativeTitle,
  iosShowsSpinner,
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
        ...(a.destructive ? { destructive: true } : null),
        ...(a.disabled ? { disabled: true } : null),
      })),
    );
  }, [menuActions]);
  /* iOS 26+ glass 路径下 native content 三件套：SF Symbol image / native title / spinner。
     任一存在时让 UIButton 自己画，JS children 默认不渲染（避免 native content 跟 React
     overlay 叠加）。其它情况（iOS < 26 / Android）children 总是渲染。 */
  const hasNativeSymbol =
    IS_IOS_LIQUID_GLASS && !!iosSfSymbol && iosSfSymbol.name.length > 0;
  const hasNativeTitle =
    IS_IOS_LIQUID_GLASS && !!iosNativeTitle && iosNativeTitle.text.length > 0;
  const hasSpinner = IS_IOS_LIQUID_GLASS && !!iosShowsSpinner;
  const usingAnyNativeContent = hasNativeSymbol || hasNativeTitle || hasSpinner;
  const shouldRenderChildren =
    childrenRendering === 'always' ||
    (childrenRendering === 'auto' && !usingAnyNativeContent);
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
      onBouncyPress={handleNativePress}
      onMenuAction={handleNativeMenuAction}
    >
      {shouldRenderChildren ? children : null}
    </BouncyButtonNative>
  );
}

// MARK: - Android (Reanimated worklet) path

function AndroidWorkletBouncy({
  children,
  style,
  pressScale = 1.12,
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
