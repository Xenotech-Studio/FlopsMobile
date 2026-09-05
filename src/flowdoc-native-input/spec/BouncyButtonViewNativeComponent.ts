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
type CapsuleSegmentEvent = Readonly<{ segmentId: string }>;

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
  /** 玻璃材质着色（iOS 26+ glass 路径）。"#RRGGBB" / "#AARRGGBB"。非空 → 通过
   *  baseBackgroundColor 给 glass material 上色；空 = 默认半透明无色玻璃。深色按钮（如
   *  highlighted tab、primary action）传一个跟 UI 主色一致的 hex 即可。
   *  跟 `glassProminent` 配合：`true` 走 prominentGlassButtonConfiguration（更"实"的有色块），
   *  `false` 走 glassButtonConfiguration（淡淡 tint 的半透明玻璃）。 */
  glassTintColorHex?: WithDefault<string, ''>;
  /** iOS 26+ glass 路径下选 prominent (实色块感) vs regular (半透明)。默认 false = regular。
   *  prominent 适合需要强烈视觉权重的「主操作 / 选中 tab」，regular 适合次要按钮 / 工具栏。 */
  glassProminent?: WithDefault<boolean, false>;
  /** tap 识别成功（手指在 view 内松开）时触发。menu 模式下不发——UIButton 把 tap 转给
   *  UIMenu 弹出，emit 走 onMenuAction。 */
  /**
   * 【玻璃胶囊模式】iOS 26+ 专属。非空（≥2 段）时，本 view 不再是一颗玻璃圆钮，而是
   * **一枚连续的 Liquid Glass 胶囊，内含并排若干格**（参考 Claude iOS 右上角那颗）：
   * 一个 UIVisualEffectView + UIGlassEffect 做胶囊本体，格子是放在它 contentView 里的
   * 普通 UIButton（各自 target-action、各自按压回弹），格间一条 hairline 分隔。
   *
   * Schema:
   *   [
   *     {"id":"collab","sfSymbol":"square.stack","badge":"3"},
   *     {"id":"menu","sfSymbol":"ellipsis","menu":true}
   *   ]
   * - id 必填，点中时经 onCapsuleSegmentPress 上报；
   * - sfSymbol 必填，格子图标（材质 tint，颜色取 sfSymbolColorHex）；
   * - badge 可选，非空时在该格右上角画一颗数字角标；
   * - menu 可选，true 的那一格挂 menuActionsJson 建出来的原生 UIMenu
   *   （showsMenuAsPrimaryAction），点它直接弹系统菜单、不发 onCapsuleSegmentPress。
   */
  glassCapsuleSegmentsJson?: WithDefault<string, ''>;
  /** 胶囊某一格被点中（menu 格除外，那格走 onMenuAction）。 */
  onCapsuleSegmentPress?: DirectEventHandler<CapsuleSegmentEvent>;
  onBouncyPress?: DirectEventHandler<PressEvent>;
  /** 用户在原生 UIMenu 里选中一条 action 时触发；actionId = menuActionsJson 里对应条目的 id */
  onMenuAction?: DirectEventHandler<MenuActionEvent>;
  /** 仅 menu 模式（iOS 26+ glass 路径，且 menuActionsJson 非空）下，UIButton 被 touch-down
   *  即将弹出 UIMenu 时触发。callsite 可以借这个事件做"为菜单让位"类的 UI 联动（例如把同
   *  行的搜索框 morph 成圆形）。不在 menu 模式下不会发。 */
  onMenuWillShow?: DirectEventHandler<PressEvent>;
  /** menu 关闭（用户选了某项 / 点 menu 外区域 dismiss / drag-out 取消）后触发。
   *  iOS UIMenu 没公开 dismiss callback，native 侧靠两条线判定 dismiss：
   *  (1) onMenuAction 触发后 → 立即视为 dismiss；
   *  (2) 定时扫 window 子 view 找 context-menu overlay，找不到时 → 视为 dismiss。
   *  与 onMenuWillShow 成对出现；非 menu 模式不发。 */
  onMenuDidDismiss?: DirectEventHandler<PressEvent>;
}

export default codegenNativeComponent<NativeProps>(
  'BouncyButtonView',
) as HostComponent<NativeProps>;
