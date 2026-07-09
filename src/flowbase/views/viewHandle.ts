/**
 * 三种视图（grid/kanban/calendar）共用的命令式句柄：宿主 FlowBaseScreen 用一个 ref 指向当前
 * 激活视图，RecordSheet 保存/删除/presence 都经它作用到当前视图的本地行集合。
 */
import type { RowRecord } from '../types';

export type TableViewHandle = {
  /** 就地更新一行（编辑保存后）。 */
  applyRowUpdate: (row: RowRecord) => void;
  /** 新增一行（新建保存后）。 */
  prependRow: (row: RowRecord) => void;
  /** 移除一行（删除后）。 */
  removeRow: (rowId: string) => void;
  /** 广播本端选中/编辑的行（null=离开）。 */
  setLocalPresence: (rowId: string | null) => void;
};
