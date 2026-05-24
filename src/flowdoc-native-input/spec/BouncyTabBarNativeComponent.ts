/**
 * Fabric codegen spec for BouncyTabBar (iOS only).
 *
 * 用途：独立 UITabBar 包装。iOS 26+ 自动 floating pill + Liquid Glass material；每个
 * tab item 天然 "icon 在上 / title 在下" stacked 布局。
 *
 * 适用场景：4 项以内的"主要分区"导航 tab（区别于 UISegmentedControl 的扁平段选择器）。
 *
 * 设计：itemsJson 用 JSON 字符串传 items 数组，跟 BouncySegmentedControl segmentsJson 同
 * 模式（避开 codegen 嵌套 record 数组的脆弱支持）。
 */
import type { HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';
import type {
  DirectEventHandler,
  Double,
  Int32,
  WithDefault,
} from 'react-native/Libraries/Types/CodegenTypes';

type TabSelectEvent = Readonly<{ index: Int32 }>;

interface NativeProps extends ViewProps {
  /** JSON-encoded items array.
   *  Schema:
   *    [
   *      {"id":"chats", "title":"Chats", "sfSymbolName":"bubble.left.and.bubble.right"},
   *      {"id":"tasks", "title":"Tasks", "sfSymbolName":"list.bullet"}
   *    ]
   *  id 仅 JS 端用（onTabSelect 上报 index → JS 映射回 key）；title 必填；sfSymbolName 可选。 */
  itemsJson?: WithDefault<string, ''>;
  /** 当前选中 tab 的 0-based index。-1 = 无选中（罕见）。 */
  selectedIndex?: WithDefault<Int32, 0>;
  /** 每个 tab item icon 的 SF Symbol point size。0 = 系统默认（iOS 26 上约 22-24pt）。
   *  调小会显得更紧凑，调大会让 icon 突出。建议范围 16-32。 */
  iconPointSize?: WithDefault<Double, 0>;
  /** Tab item title 的字体 size。0 = 系统默认（约 10pt）。建议范围 9-13。
   *  系统会自动处理 Dynamic Type 缩放（如果用户调大系统字体），这个值是 base size。 */
  titleFontSize?: WithDefault<Double, 0>;
  /** 选中段的 tint 色（icon + title 颜色），"#RRGGBB" / "#AARRGGBB" hex。
   *  空字符串 = 系统默认（iOS 系统蓝 tint）。非空时通过 UITabBarAppearance 覆盖
   *  selected.iconColor + selected.titleTextAttributes 的 foregroundColor。 */
  selectedTintColorHex?: WithDefault<string, ''>;
  /** 用户点击 tab item 触发；index 是新选中 tab 的 0-based 索引。 */
  onTabSelect?: DirectEventHandler<TabSelectEvent>;
}

export default codegenNativeComponent<NativeProps>('BouncyTabBar') as HostComponent<NativeProps>;
