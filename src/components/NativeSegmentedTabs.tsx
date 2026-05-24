/**
 * iOS 26+ Liquid Glass tab capsule —— 原生 UISegmentedControl 包装。
 *
 * 适用场景：底部 / 任何"4 段以内、capsule 形态、互斥选择"的 tab。当前 callsite =
 * ProjectScreen 底部 Chats/Tasks/Calendar/Flow。
 *
 * 范围限制：
 *   - 仅 iOS 26+ 渲染 native（自动 Liquid Glass + 系统切换动画）
 *   - iOS < 26 / Android：返回 null，由上层 callsite 用 IS_IOS_LIQUID_GLASS 兜底自绘
 *   - UISegmentedControl 单 segment 只显示 image 或 title 二选一，title 优先；callsite
 *     需保证 segments 字段同质（要么全 title 要么全 image），混着用视觉不齐
 */
import React, { useCallback, useMemo } from 'react';
import { type StyleProp, type ViewStyle, type NativeSyntheticEvent } from 'react-native';
import BouncySegmentedControl from '../flowdoc-native-input/spec/BouncySegmentedControlNativeComponent';

export type NativeSegmentedTab<K extends string = string> = {
  /** JS 端用来映射 onChange 回调；native 不消费 */
  key: K;
  /** 段标题（建议给——系统限制 image/title 二选一，title 优先） */
  title?: string;
  /** SF Symbol icon 名字（仅当 title 没给时生效） */
  sfSymbol?: string;
};

type Props<K extends string> = {
  segments: ReadonlyArray<NativeSegmentedTab<K>>;
  selectedKey: K;
  onChange: (key: K) => void;
  /** 选中段的 tint 色（hex），缺省走系统 */
  tintColor?: string;
  style?: StyleProp<ViewStyle>;
};

export function NativeSegmentedTabs<K extends string>({
  segments,
  selectedKey,
  onChange,
  tintColor,
  style,
}: Props<K>) {
  const segmentsJson = useMemo(() => {
    return JSON.stringify(
      segments.map((s) => ({
        id: s.key,
        ...(s.title ? { title: s.title } : null),
        ...(s.sfSymbol ? { sfSymbolName: s.sfSymbol } : null),
      })),
    );
  }, [segments]);

  const selectedIndex = useMemo(() => {
    const i = segments.findIndex((s) => s.key === selectedKey);
    return i >= 0 ? i : 0;
  }, [segments, selectedKey]);

  const handleChange = useCallback(
    (e: NativeSyntheticEvent<Readonly<{ index: number }>>) => {
      const idx = e.nativeEvent.index;
      const seg = segments[idx];
      if (seg) onChange(seg.key);
    },
    [segments, onChange],
  );

  return (
    <BouncySegmentedControl
      style={style}
      segmentsJson={segmentsJson}
      selectedIndex={selectedIndex}
      tintColorHex={tintColor ?? ''}
      onSegmentChange={handleChange}
    />
  );
}
