/**
 * Fabric codegen spec for the native FlowDocInput component.
 *
 * 设计取舍：
 * - 用 contentJson（字符串）传"text + pills 序列"以避开 codegen 对嵌套 array<record>
 *   的脆弱支持；JSON parse/stringify 的开销可忽略。
 * - 初始内容由 `initialContent` prop 设置一次；之后通过 imperative commands 修改
 *   （insertPill / removePill / setContent）。Native 是 post-mount 的 source of truth，
 *   JS 通过 `onChangeContent` 事件被动观察。
 * - 不暴露光标/选区为 prop（避免控制态光标与 IME 冲突）；通过 `onChangeSelection` 上报。
 */
import type { ColorValue, HostComponent, ViewProps } from 'react-native';
import { codegenNativeCommands, codegenNativeComponent } from 'react-native';
// Codegen 类型工具目前在 RN 0.84 仍然没有顶层 re-export，只有 deep import 可用。
// react-native 团队的 deprecation 警告对这些类型还没生效（codegen 模板里官方自己也是这样写的）。
import type {
  BubblingEventHandler,
  DirectEventHandler,
  Double,
  Int32,
  WithDefault,
} from 'react-native/Libraries/Types/CodegenTypes';

/** Native → JS：每次内容变化（用户输入 / 命令）触发。
 *  contentJson 见模块顶部说明；pillCount 是冗余便利字段。 */
type ChangeContentEvent = Readonly<{
  contentJson: string;
  pillCount: Int32;
}>;

/** Native → JS：光标 / 选区变化。offset 单位是「逻辑字符」（pill = 1 个字符） */
type ChangeSelectionEvent = Readonly<{
  start: Int32;
  end: Int32;
}>;

/** Native → JS：用户点击某个 pill */
type PillPressEvent = Readonly<{
  refKey: string;
}>;

/** Native → JS：内容尺寸变化（pt）。JS 拿来给 style.height 做内容自适应。
 *  iOS：UITextView.contentSize；Android：EditText 测量后的 height。 */
type ContentSizeEvent = Readonly<{
  width: Double;
  height: Double;
}>;

/** Native → JS：用户按 Enter（且 enterCreatesBlock=true）；native 已经吃掉了换行，
 *  把当前 block 内容（contentJson）和拆点 offset 给 JS，JS 决定怎么拆 / 插新块 */
type SplitRequestEvent = Readonly<{
  contentJson: string;
  /** 拆点：基于"逻辑字符数"（pill 算 1 个），= 拆完后前段长度 */
  offset: Int32;
}>;

/** Native → JS：用户在块首（光标 offset=0）按退格；JS 端把当前 contentJson 合并到上一块。
 *  本地 native 不删字符——JS 端做 merge + remove，再通过 remount 让 native 重读。 */
type MergeBackwardRequestEvent = Readonly<{
  contentJson: string;
}>;

interface NativeProps extends ViewProps {
  /** JSON 形式的初始内容，格式：
   *  [
   *    {"type": "text", "text": "Hello "},
   *    {"type": "pill", "refKey": "x", "mention": "@doc", "title": "...", "isPointer": false},
   *    {"type": "text", "text": " world"}
   *  ]
   *  挂载后只读，更新走 setContent 命令。 */
  initialContent?: WithDefault<string, '[]'>;
  textColor?: ColorValue;
  pillBackgroundColor?: ColorValue;
  pillTextColor?: ColorValue;
  fontSize?: WithDefault<Double, 16>;
  /** 字体行高（pt）。<=0 使用系统默认（fontSize × 1.2 左右） */
  lineHeight?: WithDefault<Double, 0>;
  /** Pill 视觉截短上限（iOS pt / Android dp）。pill 内 "icon + 两空格 + label" 的渲染
   *  宽度超过这个上限就在 label 尾部换 "…"。仅影响视觉，不动 mention_text 数据。
   *  设 <=0 视为关闭视觉截短（按文本自然宽渲染）。 */
  pillMaxLabelTextWidth?: WithDefault<Double, 140>;
  /** 字体族（如 "Menlo" 代表 code 块）。空字符串 / 缺省 = 系统字体 */
  fontFamily?: WithDefault<string, ''>;
  placeholder?: string;
  placeholderColor?: ColorValue;
  editable?: WithDefault<boolean, true>;
  /** Enter 是否当作"拆 block"语义：默认 true（paragraph/heading 等），code 块设 false */
  enterCreatesBlock?: WithDefault<boolean, true>;
  /** UITextView.textContainerInset：让 native textView frame 撑满整张卡片 / 容器，文本视觉
   *  留白通过 textContainerInset 给（不再靠外层 JS View 加 padding 把 textView 框小）。
   *  好处：UITextView 自己的 tap recognizer 覆盖整片可点区域，"卡片其它区域 = 输入框延伸"
   *  原生体感；callsite 不需要 JS 模拟 focusAtOffset(-1) 那种 hack。
   *  + 按钮等内部 UIControl 子 view 通过 native 那侧的 gesture delegate 自动过滤（命中
   *  UIControl 子树时不让 UITextView 的 tap recognizer 接 touch）。 */
  textContainerInsetTop?: WithDefault<Double, 0>;
  textContainerInsetLeft?: WithDefault<Double, 0>;
  textContainerInsetBottom?: WithDefault<Double, 0>;
  textContainerInsetRight?: WithDefault<Double, 0>;
  onChangeContent?: BubblingEventHandler<ChangeContentEvent>;
  onChangeSelection?: BubblingEventHandler<ChangeSelectionEvent>;
  onPillPress?: BubblingEventHandler<PillPressEvent>;
  onFocusNative?: BubblingEventHandler<Readonly<{}>>;
  onBlurNative?: BubblingEventHandler<Readonly<{}>>;
  /** RN 约定：onContentSizeChange 是 DirectEventHandler；用 Bubbling 会跟 TextInput 的
   *  view config 在 Android 上撞 topic 名，触发 "Event cannot be both direct and bubbling"。 */
  onContentSizeChange?: DirectEventHandler<ContentSizeEvent>;
  onSplitRequest?: BubblingEventHandler<SplitRequestEvent>;
  onMergeBackwardRequest?: BubblingEventHandler<MergeBackwardRequestEvent>;
}

type FlowDocInputViewType = HostComponent<NativeProps>;

interface NativeCommands {
  /** 在当前光标位置插入一个 pill；若光标缺失则附加到末尾。同 refKey 已存在则不重复插。 */
  insertPill: (
    viewRef: React.ElementRef<FlowDocInputViewType>,
    refKey: string,
    mention: string,
    title: string,
    isPointer: boolean,
  ) => void;
  /** 按 refKey 删除指定 pill；找不到则 no-op */
  removePill: (
    viewRef: React.ElementRef<FlowDocInputViewType>,
    refKey: string,
  ) => void;
  /** 全量替换内容（contentJson 格式同 initialContent）。光标会重置到末尾 */
  setContent: (
    viewRef: React.ElementRef<FlowDocInputViewType>,
    contentJson: string,
  ) => void;
  /** 给当前选区加上一个 mark；mark = "bold" / "italic" / "code" / "color"。
   *  color 用 value 传 hex 字符串（"#RRGGBB"）；布尔型 mark 传空串即可。
   *  无选区时 no-op。 */
  applyMark: (
    viewRef: React.ElementRef<FlowDocInputViewType>,
    mark: string,
    value: string,
  ) => void;
  /** 移除当前选区上对应 mark 的全部 span。 */
  removeMark: (
    viewRef: React.ElementRef<FlowDocInputViewType>,
    mark: string,
  ) => void;
  /** 实时语音听写：在编辑器**尾部**渲染一段灰色 pending 文字（不进已提交内容、不触发
   *  onChangeContent、不参与序列化）。反复调用整体替换这段 pending 文字，实现流式听写文字
   *  随 ASR 结果实时增删。text 为空串 = 清空 pending 文字但仍保持 pending 态。 */
  setDictationPending: (
    viewRef: React.ElementRef<FlowDocInputViewType>,
    text: string,
  ) => void;
  /** 提交 pending：把当前灰色 pending 文字转成正式内容（正常颜色），并触发一次
   *  onChangeContent；随后 pending 态清空。无 pending 时 no-op。 */
  commitDictation: (viewRef: React.ElementRef<FlowDocInputViewType>) => void;
  /** 取消 pending：直接删除当前灰色 pending 文字，不进入内容。无 pending 时 no-op。 */
  cancelDictation: (viewRef: React.ElementRef<FlowDocInputViewType>) => void;
  /** 编程式聚焦 */
  focus: (viewRef: React.ElementRef<FlowDocInputViewType>) => void;
  /** 编程式聚焦 + 把 cursor 摆到指定逻辑字符 offset（pill 算 1 个字符）。
   *  offset < 0 等同于 focus()（cursor 跑末尾，iOS 默认行为） */
  focusAtOffset: (
    viewRef: React.ElementRef<FlowDocInputViewType>,
    offset: Int32,
  ) => void;
  /** 编程式失焦 */
  blur: (viewRef: React.ElementRef<FlowDocInputViewType>) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
  supportedCommands: [
    'insertPill',
    'removePill',
    'setContent',
    'applyMark',
    'removeMark',
    'setDictationPending',
    'commitDictation',
    'cancelDictation',
    'focus',
    'focusAtOffset',
    'blur',
  ],
});

export default codegenNativeComponent<NativeProps>('FlowDocInputView');
