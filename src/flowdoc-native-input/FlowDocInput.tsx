/**
 * FlowDocInput
 *
 * React 包装层，把 codegen 出来的 native component 包成更顺手的 React API：
 * - 受控 / 非受控两种用法：通过 `initialContent` 设初始值（一次性）；之后用 imperative ref API 改
 * - 事件回调用 React 风格的 props (onChangeContent / onChangeSelection / etc)，
 *   内部把 native event 的 NativeSyntheticEvent 解开，把 contentJson 解析成结构化对象
 * - 暴露 imperative API（FlowDocInputHandle）：insertPill / removePill / setContent / focus / blur
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ViewStyle, NativeSyntheticEvent } from 'react-native';
import FlowDocInputNative, {
  Commands as NativeCommands,
} from './spec/FlowDocInputViewNativeComponent';

export type FlowDocMarks = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** CSS-like 颜色字符串，如 "#ff0000"。仅 6 位 hex 当前保证 round-trip；其它格式可能丢失 */
  color?: string;
  /** 行内链接 URL（对齐 web 行内 link）。非空时该段文本为链接：原生加下划线+链接色、可点打开 */
  link?: string;
};

export type FlowDocContentPart =
  | { type: 'text'; text: string; marks?: FlowDocMarks }
  | {
      type: 'pill';
      refKey: string;
      mention: string;
      title: string;
      isPointer: boolean;
    }
  /** 行内 LaTeX 公式：tex 源码。原生侧用 iosMath/AndroidMath 渲染成行内 image span/attachment */
  | { type: 'equation'; tex: string };

export type FlowDocContent = FlowDocContentPart[];

export type FlowDocMarkName = 'bold' | 'italic' | 'code' | 'color' | 'link';

export type FlowDocInputHandle = {
  insertPill: (
    refKey: string,
    mention: string,
    title?: string,
    isPointer?: boolean,
  ) => void;
  removePill: (refKey: string) => void;
  setContent: (content: FlowDocContent) => void;
  /** 清空内容（= setContent([])）。语义上等价但语义更明确，供 chat composer 发送后清空用 */
  clear: () => void;
  /** 给当前选区加 mark。color 用 value 传 hex；布尔型 mark 不需要 value */
  applyMark: (mark: FlowDocMarkName, value?: string) => void;
  removeMark: (mark: FlowDocMarkName) => void;
  /** 实时语音听写：在编辑器尾部渲染一段灰色 pending 文字（不进已提交内容、不触发
   *  onChangeContent）。反复调用整体替换，实现流式听写。空串 = 清空 pending 文字。 */
  setDictationPending: (text: string) => void;
  /** 提交 pending 文字为正式内容（正常颜色），触发一次 onChangeContent。无 pending 时 no-op */
  commitDictation: () => void;
  /** 丢弃 pending 文字（不进入内容）。无 pending 时 no-op */
  cancelDictation: () => void;
  focus: () => void;
  /** 聚焦并把光标放到指定逻辑字符 offset（pill 算 1 个字符）；offset<0 表示放末尾 */
  focusAtOffset: (offset: number) => void;
  blur: () => void;
};

export type FlowDocInputProps = {
  /** 自适应内容高度（默认 true）。开启时 JS 监听 native 的 onContentSizeChange，
   *  动态设 height。关闭时必须由 caller 自己给 style 设 height/minHeight。 */
  autoHeight?: boolean;
  initialContent?: FlowDocContent;
  textColor?: string;
  pillBackgroundColor?: string;
  pillTextColor?: string;
  fontSize?: number;
  /** 字体族，例如 "Menlo" 表示代码块。空 / 缺省 = 系统字体 */
  fontFamily?: string;
  lineHeight?: number;
  /** Pill 视觉截短上限（iOS pt / Android dp）；默认 140，<=0 关视觉截短 */
  pillMaxLabelTextWidth?: number;
  placeholder?: string;
  placeholderColor?: string;
  editable?: boolean;
  /** Enter 拆 block 语义：默认 true。code 块设 false 以保留多行 */
  enterCreatesBlock?: boolean;
  /** UITextView.textContainerInset：让 textView frame 撑满外层 view，文本视觉留白靠这个
   *  inset 给（不再由外层 JS View 包 padding 把 textView 框小）。设了以后 UITextView 自己
   *  的 tap recognizer 覆盖整片可点区域，tap 在内文之外的 padding 区会自动把 cursor 落到
   *  最近的文本位置（"卡片其它区域 = 输入框延伸"）。
   *  callsite 通常给 short 模式左 inset 让位 + 按钮、tall 模式给底 inset 让位。 */
  textContainerInset?: {
    top?: number;
    left?: number;
    bottom?: number;
    right?: number;
  };
  style?: ViewStyle;
  onChangeContent?: (content: FlowDocContent, pillCount: number) => void;
  onChangeSelection?: (start: number, end: number) => void;
  onPillPress?: (refKey: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** 用户按 Enter（且 enterCreatesBlock=true）：参数是当前 block 拆点前的内容 + 拆点 offset */
  onSplitRequest?: (content: FlowDocContent, offset: number) => void;
  /** 用户在块首按退格：caller 把 content 合并到上一块、然后删除本块 */
  onMergeBackwardRequest?: (content: FlowDocContent) => void;
};

function safeParseContent(json: string): FlowDocContent {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p === 'object' && typeof p.type === 'string');
  } catch {
    return [];
  }
}

export const FlowDocInput = forwardRef(
  (props: FlowDocInputProps, ref: React.ForwardedRef<FlowDocInputHandle>) => {
    const nativeRef = useRef<React.ElementRef<typeof FlowDocInputNative> | null>(null);
    const autoHeight = props.autoHeight ?? true;
    /* 内容高度（pt），由 native 测量后 emit。初始一行字号高度做兜底，避免首帧塌成 0 */
    const fallbackMinHeight = (props.fontSize ?? 16) * 1.6;
    const [contentHeight, setContentHeight] = useState<number>(fallbackMinHeight);

    const initialContentJson = useMemo(() => {
      return JSON.stringify(props.initialContent ?? []);
    }, [props.initialContent]);

    useImperativeHandle(ref, () => ({
      insertPill: (refKey, mention, title = '', isPointer = false) => {
        if (!nativeRef.current) return;
        NativeCommands.insertPill(nativeRef.current, refKey, mention, title, isPointer);
      },
      removePill: (refKey) => {
        if (!nativeRef.current) return;
        NativeCommands.removePill(nativeRef.current, refKey);
      },
      setContent: (content) => {
        if (!nativeRef.current) return;
        NativeCommands.setContent(nativeRef.current, JSON.stringify(content));
      },
      clear: () => {
        if (!nativeRef.current) return;
        /* 空文档 = 空 contentJson 数组；native applyContentJson 解析 [] → 清空 attributedText。
           走 setContent 命令而不是靠 keyed-remount 重读 initialContent —— Fabric view 回收 +
           initialContentApplied 守卫让 remount 清空不可靠，imperative 是可靠路径。 */
        NativeCommands.setContent(nativeRef.current, '[]');
      },
      applyMark: (mark, value = '') => {
        if (!nativeRef.current) return;
        NativeCommands.applyMark(nativeRef.current, mark, value);
      },
      removeMark: (mark) => {
        if (!nativeRef.current) return;
        NativeCommands.removeMark(nativeRef.current, mark);
      },
      setDictationPending: (text) => {
        if (!nativeRef.current) return;
        NativeCommands.setDictationPending(nativeRef.current, text ?? '');
      },
      commitDictation: () => {
        if (!nativeRef.current) return;
        NativeCommands.commitDictation(nativeRef.current);
      },
      cancelDictation: () => {
        if (!nativeRef.current) return;
        NativeCommands.cancelDictation(nativeRef.current);
      },
      focus: () => {
        if (!nativeRef.current) return;
        NativeCommands.focus(nativeRef.current);
      },
      focusAtOffset: (offset) => {
        if (!nativeRef.current) return;
        NativeCommands.focusAtOffset(nativeRef.current, offset);
      },
      blur: () => {
        if (!nativeRef.current) return;
        NativeCommands.blur(nativeRef.current);
      },
    }));

    const handleContent = useCallback(
      (e: NativeSyntheticEvent<{ contentJson: string; pillCount: number }>) => {
        const ne = e.nativeEvent;
        props.onChangeContent?.(safeParseContent(ne.contentJson), ne.pillCount);
      },
      [props.onChangeContent],
    );

    const handleSelection = useCallback(
      (e: NativeSyntheticEvent<{ start: number; end: number }>) => {
        props.onChangeSelection?.(e.nativeEvent.start, e.nativeEvent.end);
      },
      [props.onChangeSelection],
    );

    const handlePillPress = useCallback(
      (e: NativeSyntheticEvent<{ refKey: string }>) => {
        props.onPillPress?.(e.nativeEvent.refKey);
      },
      [props.onPillPress],
    );

    const handleFocus = useCallback(() => {
      props.onFocus?.();
    }, [props.onFocus]);

    const handleBlur = useCallback(() => {
      props.onBlur?.();
    }, [props.onBlur]);

    const handleSplitRequest = useCallback(
      (e: NativeSyntheticEvent<{ contentJson: string; offset: number }>) => {
        const content = safeParseContent(e.nativeEvent.contentJson);
        props.onSplitRequest?.(content, e.nativeEvent.offset);
      },
      [props.onSplitRequest],
    );

    const handleMergeBackwardRequest = useCallback(
      (e: NativeSyntheticEvent<{ contentJson: string }>) => {
        const content = safeParseContent(e.nativeEvent.contentJson);
        props.onMergeBackwardRequest?.(content);
      },
      [props.onMergeBackwardRequest],
    );

    const handleContentSize = useCallback(
      (e: NativeSyntheticEvent<{ width: number; height: number }>) => {
        const h = e.nativeEvent.height;
        if (h > 0) setContentHeight((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
      },
      [],
    );

    /* autoHeight 用 minHeight 而不是 height —— minHeight 给 view 提供"至少内容高度"的下界,
     * 但允许 flex 父容器把 view 拉得更高（实现"UITextView frame 撑满 card"那种用法，让
     * UITextView 自己的 tap recognizer 覆盖整片可点区域）。
     * 没 flex 拉伸的传统 callsite 行为不变（view height ≈ minHeight ≈ content height）。 */
    const composedStyle = autoHeight
      ? [props.style, { minHeight: Math.max(contentHeight, fallbackMinHeight) }]
      : props.style;

    return (
      <FlowDocInputNative
        ref={nativeRef}
        style={composedStyle}
        onContentSizeChange={autoHeight ? handleContentSize : undefined}
        initialContent={initialContentJson}
        textColor={props.textColor}
        pillBackgroundColor={props.pillBackgroundColor}
        pillTextColor={props.pillTextColor}
        fontSize={props.fontSize}
        fontFamily={props.fontFamily}
        lineHeight={props.lineHeight}
        pillMaxLabelTextWidth={props.pillMaxLabelTextWidth}
        placeholder={props.placeholder}
        placeholderColor={props.placeholderColor}
        editable={props.editable}
        enterCreatesBlock={props.enterCreatesBlock}
        textContainerInsetTop={props.textContainerInset?.top ?? 0}
        textContainerInsetLeft={props.textContainerInset?.left ?? 0}
        textContainerInsetBottom={props.textContainerInset?.bottom ?? 0}
        textContainerInsetRight={props.textContainerInset?.right ?? 0}
        onChangeContent={handleContent}
        onSplitRequest={handleSplitRequest}
        onMergeBackwardRequest={handleMergeBackwardRequest}
        onChangeSelection={handleSelection}
        onPillPress={handlePillPress}
        onFocusNative={handleFocus}
        onBlurNative={handleBlur}
      />
    );
  },
);
FlowDocInput.displayName = 'FlowDocInput';
