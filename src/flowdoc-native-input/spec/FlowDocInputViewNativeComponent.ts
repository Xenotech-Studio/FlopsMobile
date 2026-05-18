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
  onChangeContent?: BubblingEventHandler<ChangeContentEvent>;
  onChangeSelection?: BubblingEventHandler<ChangeSelectionEvent>;
  onPillPress?: BubblingEventHandler<PillPressEvent>;
  onFocusNative?: BubblingEventHandler<Readonly<{}>>;
  onBlurNative?: BubblingEventHandler<Readonly<{}>>;
  onContentSizeChange?: BubblingEventHandler<ContentSizeEvent>;
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
    'focus',
    'focusAtOffset',
    'blur',
  ],
});

export default codegenNativeComponent<NativeProps>('FlowDocInputView');
