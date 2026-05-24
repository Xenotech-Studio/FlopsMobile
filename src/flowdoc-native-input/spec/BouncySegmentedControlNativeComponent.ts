/**
 * Fabric codegen spec for BouncySegmentedControl (iOS only).
 *
 * 用途：原生 UISegmentedControl 包装。iOS 26+ 自动 Liquid Glass material + 系统切换
 * 动画；iOS 15..25 是常规 UISegmentedControl 视觉。
 *
 * 设计：
 *  - segmentsJson 用 JSON 字符串传 segments 数组，避开 codegen 对嵌套 array<record> 的
 *    脆弱支持（同 BouncyButton menuActionsJson / FlowDocInput initialContent 同模式）。
 *  - 每段可指定 title 或 sfSymbolName（系统限制：单 segment 只能显示 image 或 title 二选
 *    一，给了 title 优先用 title）。
 *  - selectedIndex 双向：JS 传进来 → native 设；用户点切 → onSegmentChange 回 JS。
 *
 * Android 不实现此组件，JS 侧上层用 IS_IOS_LIQUID_GLASS 决定是否走 native。
 */
import type { HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';
import type {
  DirectEventHandler,
  Int32,
  WithDefault,
} from 'react-native/Libraries/Types/CodegenTypes';

type SegmentChangeEvent = Readonly<{ index: Int32 }>;

interface NativeProps extends ViewProps {
  /** JSON-encoded segments array.
   *  Schema:
   *    [
   *      {"id": "chats",    "title": "Chats"},
   *      {"id": "tasks",    "sfSymbolName": "list.bullet"},
   *      {"id": "calendar", "title": "Calendar"}
   *    ]
   *  id 必填（仅 JS 端用来映射 index → key；native 不消费）；title / sfSymbolName 至少给一个，
   *  两者都给优先 title（UISegmentedControl 单 segment 限制）。空字符串 / "[]" = 清空。 */
  segmentsJson?: WithDefault<string, ''>;
  /** 当前选中段的 0-based index。-1 = 无选中（UISegmentedControlNoSegment）。 */
  selectedIndex?: WithDefault<Int32, 0>;
  /** 选中段的 tint 色（selectedSegmentTintColor），"#RRGGBB" / "#AARRGGBB"。空 = 系统默认。 */
  tintColorHex?: WithDefault<string, ''>;
  /** 用户切换段时触发；index 是新选中段的 0-based 索引。 */
  onSegmentChange?: DirectEventHandler<SegmentChangeEvent>;
}

export default codegenNativeComponent<NativeProps>(
  'BouncySegmentedControl',
) as HostComponent<NativeProps>;
