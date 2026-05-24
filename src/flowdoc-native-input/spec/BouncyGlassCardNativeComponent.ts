/**
 * Fabric codegen spec for BouncyGlassCard (iOS only).
 *
 * 通用 Liquid Glass 卡片容器：native 持 UIVisualEffectView + UIGlassEffect，React 子 view
 * 会 mount 到 effectView.contentView 内，系统 interactive glass scale 时跟卡片一起形变。
 *
 * 适合场景：
 *  - 底部漂浮搜索框（包 RN TextInput）
 *  - 浮层卡片（包任意 RN 内容）
 *  - 任何想要"卡片是玻璃材质 + 按下整体放大"的容器
 *
 * iOS < 26 / Android 没有 UIGlassEffect，native 端 effectView.effect = nil（透明 container），
 * JS callsite 应当自行做 fallback 视觉。
 */
import type { HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';
import type {
  DirectEventHandler,
  Double,
  WithDefault,
} from 'react-native/Libraries/Types/CodegenTypes';

type PressEvent = Readonly<{}>;

interface NativeProps extends ViewProps {
  /** 是否启用 interactive glass（按下时 system 自带 scale + 折光 + onPress emit）。
   *  默认 true。设 false 时纯展示玻璃材质、无按下反馈、不发 onPress。 */
  interactive?: WithDefault<boolean, true>;
  /** 卡片圆角（pt）。默认 0。Capsule 形状传 height/2 即可。 */
  cornerRadius?: WithDefault<Double, 0>;
  /** 玻璃 tint 色，"#RRGGBB" / "#AARRGGBB" hex。空 = 系统默认（无 tint）。 */
  tintColorHex?: WithDefault<string, ''>;
  /** tap 识别（仅 interactive=true 时触发）。tap 不会 cancel children 的 touch，所以 wrap
   *  TextInput 时键盘还能正常 focus。
   *  名字不能用 `onPress`——会跟 RN 内置 Pressable / TouchableHighlight 注册的 `topPress`
   *  在 ReactNativeViewConfigRegistry 撞 topic 名，触发
   *  "Event cannot be both direct and bubbling: topPress"。 */
  onGlassPress?: DirectEventHandler<PressEvent>;
}

export default codegenNativeComponent<NativeProps>('BouncyGlassCard') as HostComponent<NativeProps>;
