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
};

export type FlowDocContentPart =
  | { type: 'text'; text: string; marks?: FlowDocMarks }
  | {
      type: 'pill';
      refKey: string;
      mention: string;
      title: string;
      isPointer: boolean;
    };

export type FlowDocContent = FlowDocContentPart[];

export type FlowDocMarkName = 'bold' | 'italic' | 'code' | 'color';

export type FlowDocInputHandle = {
  insertPill: (
    refKey: string,
    mention: string,
    title?: string,
    isPointer?: boolean,
  ) => void;
  removePill: (refKey: string) => void;
  setContent: (content: FlowDocContent) => void;
  /** 给当前选区加 mark。color 用 value 传 hex；布尔型 mark 不需要 value */
  applyMark: (mark: FlowDocMarkName, value?: string) => void;
  removeMark: (mark: FlowDocMarkName) => void;
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
  placeholder?: string;
  placeholderColor?: string;
  editable?: boolean;
  /** Enter 拆 block 语义：默认 true。code 块设 false 以保留多行 */
  enterCreatesBlock?: boolean;
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
      applyMark: (mark, value = '') => {
        if (!nativeRef.current) return;
        NativeCommands.applyMark(nativeRef.current, mark, value);
      },
      removeMark: (mark) => {
        if (!nativeRef.current) return;
        NativeCommands.removeMark(nativeRef.current, mark);
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

    const composedStyle = autoHeight
      ? [props.style, { height: Math.max(contentHeight, fallbackMinHeight) }]
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
        placeholder={props.placeholder}
        placeholderColor={props.placeholderColor}
        editable={props.editable}
        enterCreatesBlock={props.enterCreatesBlock}
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
