/**
 * Fabric codegen spec for BouncyButtonView (iOS only).
 *
 * 用途：顶栏 / 任何需要"原生 iOS 按钮按下放大、松手回弹"质感的圆按钮。
 * iOS 26+ 走 UIButton + glassButtonConfiguration（Liquid Glass material + 系统
 * interactive scale + bend），整条 touch → 动画跑在 UI 线程 + Core Animation。
 * iOS 15..25 走 legacy 路径（手写 spring scale + 白圈兜底）。
 *
 * Android 端不实现此组件；JS 侧 AnimatedCircleButton 通过 Platform.OS 走 Reanimated
 * 兜底实现。
 *
 * 可选 native UIMenu：iOS 26+ 走 glass 路径时，传 menuActionsJson（非空）会让 UIButton
 * 启用 `showsMenuAsPrimaryAction`，按下直接弹原生 UIMenu。选中条目通过 onMenuAction 上报
 * 对应 actionId。menuActionsJson 为空时按钮恢复 onBouncyPress 普通按钮语义。
 *
 * Note: 文件放在 src/flowdoc-native-input/spec/ 是因为这是当前 codegenConfig.jsSrcsDir
 * 指向的目录；codegen 会扫该目录所有 *.ts 文件，多组件可以共存。
 */
import type { HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';
import type {
  DirectEventHandler,
  Double,
  WithDefault,
} from 'react-native/Libraries/Types/CodegenTypes';

type PressEvent = Readonly<{}>;
type MenuActionEvent = Readonly<{ actionId: string }>;

interface NativeProps extends ViewProps {
  /** 按下放大到多少（默认 1.12） */
  pressScale?: WithDefault<Double, 1.12>;
  /** disabled=true 整个按钮不响应 touch（不变色，需 JS 端自己做 opacity） */
  bouncyDisabled?: WithDefault<boolean, false>;
  /** JSON-encoded list of UIMenu actions. 空字符串 / "[]" 表示按钮走普通 onBouncyPress 流程。
   *  非空时（仅 iOS 26+ glass 路径生效）UIButton 的 menu 属性会被设置 + showsMenuAsPrimaryAction=YES。
   *
   *  Schema:
   *    [
   *      {"id": "info",  "title": "会话信息"},
   *      {"id": "diag",  "title": "复制诊断", "destructive": false, "disabled": false}
   *    ]
   *  字段 id / title 必填；destructive / disabled 可选，默认 false。 */
  menuActionsJson?: WithDefault<string, ''>;
  /** SF Symbol 名称（iOS 26+ glass 路径生效）。非空时 native 通过
   *  `[UIImage systemImageNamed:]` 把图标设进 UIButton.configuration.image——icon 成为
   *  按钮 native content 的一部分，系统 interactive glass scale 时 icon 100% 跟动，
   *  不再需要 JS 子 view + 手动 layer transform 那套兜底。
   *  空字符串 = 不设 image，由 JS 子 view（Ionicons 等）承担显示。 */
  sfSymbolName?: WithDefault<string, ''>;
  /** SF Symbol 渲染 point size（默认 22，跟 Ionicons size=22 视觉大致对齐） */
  sfSymbolPointSize?: WithDefault<Double, 22>;
  /** SF Symbol 着色，"#RRGGBB" / "#AARRGGBB" hex；空字符串 = 系统默认（label color） */
  sfSymbolColorHex?: WithDefault<string, ''>;
  /** 按钮 native 文字内容（iOS 26+ glass 路径生效）。非空时 native 设进
   *  UIButton.configuration.title。文字是 UIButton native content 的一部分，跟 SF Symbol
   *  一样会参与系统 interactive glass scale。可以跟 sfSymbolName 同时存在（image + title 并列）。
   *  空字符串 = 不设 title。 */
  nativeTitle?: WithDefault<string, ''>;
  /** native title 颜色 hex，空 = 系统 label color */
  nativeTitleColorHex?: WithDefault<string, ''>;
  /** iOS 16+ 内置 spinner（iOS 26+ glass 路径生效）。true 时 UIButton 自动用系统
   *  UIActivityIndicatorView 取代 title/image，spinner 也跟着 interactive glass scale。
   *  使用场景：button 提交中、loading 中等。 */
  showsActivityIndicator?: WithDefault<boolean, false>;
  /** tap 识别成功（手指在 view 内松开）时触发。menu 模式下不发——UIButton 把 tap 转给
   *  UIMenu 弹出，emit 走 onMenuAction。 */
  onBouncyPress?: DirectEventHandler<PressEvent>;
  /** 用户在原生 UIMenu 里选中一条 action 时触发；actionId = menuActionsJson 里对应条目的 id */
  onMenuAction?: DirectEventHandler<MenuActionEvent>;
}

export default codegenNativeComponent<NativeProps>(
  'BouncyButtonView',
) as HostComponent<NativeProps>;
