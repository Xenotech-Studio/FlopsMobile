/**
 * iOS 26+ floating Liquid Glass tab bar —— 独立 UITabBar 包装。
 *
 * 对比 NativeSegmentedTabs（UISegmentedControl 段选择器）：
 *   - 视觉是 floating pill + 每项 "icon 上 / title 下" stacked，跟 Apple iOS 26 系统 tab bar
 *     一致
 *   - 适合 4 项以内主分区导航；多项 UITabBar 会自动 More 按钮
 *
 * 仅 iOS 26+ 渲染 native；iOS < 26 / Android 返回 null，上层 callsite 用 IS_IOS_LIQUID_GLASS
 * 兜底自绘。
 */
import React, { useCallback, useMemo } from 'react';
import { type StyleProp, type ViewStyle, type NativeSyntheticEvent } from 'react-native';
import BouncyTabBar from '../flowdoc-native-input/spec/BouncyTabBarNativeComponent';

export type NativeTabBarItem<K extends string = string> = {
  /** JS 端用来映射 onChange 回调；native 不消费 */
  key: K;
  /** tab 标题（必填，iOS 上 title 在 icon 下方） */
  title: string;
  /** SF Symbol icon 名字（可选；iOS 26+ 上自动 stacked 在 title 之上） */
  sfSymbol?: string;
};

type Props<K extends string> = {
  items: ReadonlyArray<NativeTabBarItem<K>>;
  selectedKey: K;
  onChange: (key: K) => void;
  /** Tab item SF Symbol icon 大小（pt）。缺省走系统默认（iOS 26 上约 22-24pt）。 */
  iconSize?: number;
  /** Tab item title 文字大小（pt）。缺省走系统默认（约 10pt）。 */
  titleSize?: number;
  /** 选中段的 tint 色（icon + title 颜色），"#RRGGBB" hex。缺省走系统蓝 tint。 */
  selectedTintColor?: string;
  /** 整体高度等通过 style 传（如 `{ height: 60 }`）。alignSelf: 'stretch' 让它横向铺满。 */
  style?: StyleProp<ViewStyle>;
};

export function NativeTabBar<K extends string>({
  items,
  selectedKey,
  onChange,
  iconSize,
  titleSize,
  selectedTintColor,
  style,
}: Props<K>) {
  const itemsJson = useMemo(() => {
    return JSON.stringify(
      items.map((it) => ({
        id: it.key,
        title: it.title,
        ...(it.sfSymbol ? { sfSymbolName: it.sfSymbol } : null),
      })),
    );
  }, [items]);

  const selectedIndex = useMemo(() => {
    const i = items.findIndex((it) => it.key === selectedKey);
    return i >= 0 ? i : 0;
  }, [items, selectedKey]);

  const handleTabSelect = useCallback(
    (e: NativeSyntheticEvent<Readonly<{ index: number }>>) => {
      const idx = e.nativeEvent.index;
      const it = items[idx];
      if (it) onChange(it.key);
    },
    [items, onChange],
  );

  return (
    <BouncyTabBar
      style={style}
      itemsJson={itemsJson}
      selectedIndex={selectedIndex}
      iconPointSize={iconSize ?? 0}
      titleFontSize={titleSize ?? 0}
      selectedTintColorHex={selectedTintColor ?? ''}
      onTabSelect={handleTabSelect}
    />
  );
}
