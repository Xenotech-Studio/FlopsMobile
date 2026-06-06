/**
 * DocTreeIcons —— 文档树条目图标，移植自 web 版（FlowDoc src/icons/Icons.jsx）同款 SVG。
 *
 * 按 web DocTreeSidebar 的判定规则随状态切换：
 *  文件夹/收件箱：展开 → FolderOpen；折叠且有子项 → FolderClosed；折叠且空 → FolderEmpty。
 *  文档：
 *    有子项 + 折叠：isEmpty? WithChildrenEmpty : WithChildren
 *    有子项 + 展开：isEmpty? WithChildrenEmptyOpened : WithChildrenOpened
 *    无子项：       isEmpty? FileTextEmpty : FileText
 *  transcription / webpage / paper 不在此处（getDocTreeGlyph 返回 null，调用方回退 Ionicons）。
 *
 * isEmpty 取自后端 tree 字段 item.isEmpty（!== false 视为空，与 web 一致）。
 */
import React from 'react';
import Svg, { Path } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';

type Glyph = { viewBox: string; paths: string[] };

/* —— 与 web Icons.jsx 完全一致的 path 数据 —— */
const FOLDER_EMPTY: Glyph = {
  viewBox: '0 0 24 24',
  paths: [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  ],
};
const FOLDER_CLOSED: Glyph = {
  viewBox: '0 0 24 24',
  paths: [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    'M2 10h20',
  ],
};
const FOLDER_OPEN: Glyph = {
  viewBox: '0 0 24 24',
  paths: [
    'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
  ],
};
const FILE_EMPTY: Glyph = {
  viewBox: '0 0 24 24',
  paths: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
  ],
};
const FILE_TEXT: Glyph = {
  viewBox: '0 0 24 24',
  paths: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
};
const FILE_WC_EMPTY: Glyph = {
  viewBox: '0 0 24 28',
  paths: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M23 7v17a2 2 0 0 1 -2 2H6',
  ],
};
const FILE_WC: Glyph = {
  viewBox: '0 0 24 28',
  paths: [
    'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M13 2v4a2 2 0 0 0 2 2h4',
    'M9 9H7',
    'M15 13H7',
    'M15 17H7',
    'M23 7v17a2 2 0 0 1 -2 2H6',
  ],
};
const FILE_WC_EMPTY_OPEN: Glyph = {
  viewBox: '0 0 26 28',
  paths: [
    'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M13 2v4a2 2 0 0 0 2 2h4',
    'M 23 9.25 l 3 3 l -2.5 12 a 2 2 0 0 1 -2 2 l -10 -1.5',
  ],
};
const FILE_WC_OPEN: Glyph = {
  viewBox: '0 0 26 28',
  paths: [
    'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M13 2v4a2 2 0 0 0 2 2h4',
    'M9 9H7',
    'M15 13H7',
    'M15 17H7',
    'M 23 9.25 l 3 3 l -2.5 12 a 2 2 0 0 1 -2 2 l -10 -1.5',
  ],
};

const FOLDER_LIKE = new Set(['folder', 'cooperateInbox']);
/** 这几类不在自定义 SVG 集合里（web 用 lucide），调用方回退 Ionicons。 */
const IONICON_TYPES = new Set(['transcription', 'webpage', 'paper']);

/** 按 web 规则解析图标；返回 null 表示该类型走 Ionicons 回退。 */
export function getDocTreeGlyph(
  type: string,
  hasChildren: boolean,
  isExpanded: boolean,
  isEmpty: boolean
): Glyph | null {
  if (FOLDER_LIKE.has(type)) {
    if (isExpanded) return FOLDER_OPEN;
    return hasChildren ? FOLDER_CLOSED : FOLDER_EMPTY;
  }
  if (IONICON_TYPES.has(type)) return null;
  // 文档（document / 未知类型默认走文档）
  if (hasChildren && !isExpanded) return isEmpty ? FILE_WC_EMPTY : FILE_WC;
  if (hasChildren && isExpanded) return isEmpty ? FILE_WC_EMPTY_OPEN : FILE_WC_OPEN;
  return isEmpty ? FILE_EMPTY : FILE_TEXT;
}

export type DocTreeIconProps = {
  type: string;
  hasChildren: boolean;
  isExpanded: boolean;
  isEmpty: boolean;
  size?: number;
  color: string;
  style?: StyleProp<ViewStyle>;
};

/** 渲染文档树图标；若该类型无自定义 SVG（transcription/webpage/paper）返回 null。 */
export function DocTreeIcon({
  type,
  hasChildren,
  isExpanded,
  isEmpty,
  size = 16,
  color,
  style,
}: DocTreeIconProps) {
  const g = getDocTreeGlyph(type, hasChildren, isExpanded, isEmpty);
  if (!g) return null;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={g.viewBox}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {g.paths.map((d, i) => (
        <Path key={i} d={d} />
      ))}
    </Svg>
  );
}
