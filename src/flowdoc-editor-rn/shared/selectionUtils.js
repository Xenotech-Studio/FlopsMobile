import { Range, Editor, Node } from 'slate'

/**
 * 检查选区是否有效（非空且非折叠）
 * @param {Object} selection - Slate 选区对象
 * @returns {boolean} 选区是否有效
 */
export const isValidSelection = (selection) => {
  if (!selection) return false
  if (Range.isCollapsed(selection)) return false
  
  // 检查路径或偏移量是否不同
  const hasSelection = selection.anchor.path.join(',') !== selection.focus.path.join(',') ||
                       selection.anchor.offset !== selection.focus.offset
  
  return hasSelection
}

/**
 * 检查选区是否折叠（光标位置，无选中文本）
 * @param {Object} selection - Slate 选区对象
 * @returns {boolean} 选区是否折叠
 */
export const isCollapsedSelection = (selection) => {
  if (!selection) return true
  return Range.isCollapsed(selection)
}

/**
 * 从选区获取顶层块路径（文档的第一层路径）
 * @param {Object} selection - Slate 选区对象
 * @returns {Array|null} 顶层块路径，如果选区无效则返回 null
 */
export const getTopLevelBlockPath = (selection) => {
  if (!selection) return null
  
  try {
    const anchorPath = selection.anchor.path
    if (anchorPath.length > 0) {
      return anchorPath.slice(0, 1)
    }
  } catch (e) {
    // 忽略错误
  }
  
  return null
}

/**
 * 从选区获取光标所在的块级节点
 * @param {Object} editor - Slate 编辑器实例
 * @param {Object} selection - Slate 选区对象（可选，默认使用 editor.selection）
 * @returns {Object|null} { node, path } 或 null
 */
export const getBlockAtSelection = (editor, selection = null) => {
  const sel = selection || editor.selection
  if (!sel) return null
  
  try {
    // 获取光标所在的块级节点
    const [match] = Array.from(
      Editor.nodes(editor, {
        match: n => !Node.isText(n) && Editor.isBlock(editor, n),
        mode: 'lowest', // 使用 lowest 模式获取最内层的块级节点
        at: sel,
      })
    )
    
    if (match) {
      const [node, path] = match
      return { node, path }
    }
  } catch (e) {
    // 忽略错误
  }
  
  return null
}

/**
 * 获取选区覆盖的所有顶层块路径
 * @param {Object} editor - Slate 编辑器实例
 * @param {Object} selection - Slate 选区对象（可选，默认使用 editor.selection）
 * @returns {Array} 顶层块路径数组
 */
export const getSelectedBlockPaths = (editor, selection = null) => {
  const sel = selection || editor.selection
  if (!sel) return []
  
  const blockPaths = []
  try {
    for (const [node, path] of Editor.nodes(editor, {
      match: n => !Node.isText(n) && Editor.isBlock(editor, n),
      at: sel,
    })) {
      const blockPath = path.slice(0, 1)
      // 避免重复添加相同的顶层块路径
      if (!blockPaths.some(p => p[0] === blockPath[0])) {
        blockPaths.push(blockPath)
      }
    }
  } catch (e) {
    // 忽略错误
  }
  
  return blockPaths
}
