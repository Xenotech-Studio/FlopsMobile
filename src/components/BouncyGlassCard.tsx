/**
 * iOS 26+ Liquid Glass 卡片容器 —— UIVisualEffectView + UIGlassEffect 包装。
 *
 * 用法：把任意 React children 包进来；iOS 26 上自动获得：
 *  - Liquid Glass material（半透明 + 折光）
 *  - 按下时系统 interactive scale + 折光（卡片 + 内部 children 一起被放大、原生动画）
 *  - 可选 onPress 回调（tap 识别，不阻挡 children 的 touch——比如 wrap 一个 TextInput
 *    时键盘还能正常 focus）
 *
 * iOS < 26 / Android：native 端 effect = nil（透明 container），上层 callsite 自己处理
 * fallback 视觉（一般用 Platform.OS / IS_IOS_LIQUID_GLASS 分支）。
 *
 * children scaling：React 子 view 由 native 端 mount 到 effectView.contentView 内，系统
 * interactive 形变带着 children 一起 scale。这是 UIVisualEffectView 公开 API 行为、稳定
 * 可靠（比之前 BouncyButton.glassButton 那种 mount-into-button 鲁棒）。
 */
import React, { useCallback } from 'react';
import { type StyleProp, type ViewStyle, type NativeSyntheticEvent } from 'react-native';
import BouncyGlassCardNative from '../flowdoc-native-input/spec/BouncyGlassCardNativeComponent';

type Props = {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 卡片圆角（pt），capsule 形态传 height/2 */
  cornerRadius?: number;
  /** 是否启用 interactive 按下反馈 + onPress emit（默认 true） */
  interactive?: boolean;
  /** 玻璃 tint 色（hex），缺省 = 系统无 tint */
  tintColor?: string;
  /** tap 触发；仅 interactive=true 生效 */
  onPress?: () => void;
};

export function BouncyGlassCard({
  children,
  style,
  cornerRadius = 0,
  interactive = true,
  tintColor,
  onPress,
}: Props) {
  const handleNativePress = useCallback(
    (_e: NativeSyntheticEvent<Readonly<{}>>) => {
      onPress?.();
    },
    [onPress],
  );
  return (
    <BouncyGlassCardNative
      style={style}
      interactive={interactive}
      cornerRadius={cornerRadius}
      tintColorHex={tintColor ?? ''}
      onGlassPress={handleNativePress}
    >
      {children}
    </BouncyGlassCardNative>
  );
}
