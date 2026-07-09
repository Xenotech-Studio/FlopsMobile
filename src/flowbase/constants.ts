/**
 * FlowBase Mobile 全局统一的 UI 元素高度：表格行 / 表头 / page tab chip / 视图 chip /
 * RecordSheet 头部按钮 / 新建记录按钮，全部引用这一个值，改这里即整体调整。
 */
export const FB_ROW_HEIGHT = 34;

/** 半高圆角 → 药丸形，跟 FB_ROW_HEIGHT 联动（chip / 按钮统一用它）。 */
export const FB_ROW_RADIUS = FB_ROW_HEIGHT / 2;
