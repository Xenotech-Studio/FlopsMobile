/**
 * docsTreeStore —— 文档树的进程级单例缓存。
 *
 * 为什么需要它：文档下钻改成了真·整页导航（push 'DocPreview'），路由参数只携带 id；
 * 但 DocPreview 要解析"这个 id 对应的项 + 它的直接子项"才能渲染文件夹/文档，而任意深度都要解析。
 * 把最新的 DFS 扁平树缓存在这里：
 *  - DocsScreen 每次 loadTree 成功后 set(next)，写入最新树。
 *  - DocPreview 用 get(id) 拿到项本身、children(id) 拿到它的直接子项（id → 对象）。
 * 这样路由参数保持最小（只传 id），不必把整棵树塞进 navigation params。
 */
import type { FlowDocTreeItem } from '../../api';

let items: FlowDocTreeItem[] = [];
let byId = new Map<string, FlowDocTreeItem>();

export const docsTreeStore = {
  /** 写入最新扁平树（DocsScreen loadTree 成功后调用）。 */
  set(next: FlowDocTreeItem[]) {
    items = next;
    byId = new Map(next.map((i) => [i.id, i]));
  },
  /** 当前缓存的扁平树（按需用）。 */
  all(): FlowDocTreeItem[] {
    return items;
  },
  /** 按 id 取项；不存在返回 null。 */
  get(id: string): FlowDocTreeItem | null {
    return byId.get(id) ?? null;
  },
  /** 取某项的直接子项（children 存的是子 id，这里映射回对象、过滤掉缺失的）。 */
  children(id: string): FlowDocTreeItem[] {
    const it = byId.get(id);
    return (it?.children ?? [])
      .map((c) => byId.get(c))
      .filter((x): x is FlowDocTreeItem => x != null);
  },
};
