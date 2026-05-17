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
  blur: () => void;
};

export type FlowDocInputProps = {
  initialContent?: FlowDocContent;
  textColor?: string;
  pillBackgroundColor?: string;
  pillTextColor?: string;
  fontSize?: number;
  lineHeight?: number;
  placeholder?: string;
  placeholderColor?: string;
  editable?: boolean;
  style?: ViewStyle;
  onChangeContent?: (content: FlowDocContent, pillCount: number) => void;
  onChangeSelection?: (start: number, end: number) => void;
  onPillPress?: (refKey: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
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

    return (
      <FlowDocInputNative
        ref={nativeRef}
        style={props.style}
        initialContent={initialContentJson}
        textColor={props.textColor}
        pillBackgroundColor={props.pillBackgroundColor}
        pillTextColor={props.pillTextColor}
        fontSize={props.fontSize}
        lineHeight={props.lineHeight}
        placeholder={props.placeholder}
        placeholderColor={props.placeholderColor}
        editable={props.editable}
        onChangeContent={handleContent}
        onChangeSelection={handleSelection}
        onPillPress={handlePillPress}
        onFocusNative={handleFocus}
        onBlurNative={handleBlur}
      />
    );
  },
);
FlowDocInput.displayName = 'FlowDocInput';
