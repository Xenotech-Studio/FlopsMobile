/**
 * FlowDocBlocks
 *
 * 文档级渲染器：把 Slate document（FlowDocBlock[]）拆成各 block 类型，分发给对应的渲染器。
 * v1 设计原则 —— **单一 inline rendering pipeline**：所有"包含文本 + ref-pill"的 block 都
 * 用 FlowDocInput 渲染（atomic pill + marks + native selection 都白嫖一份现成实现）。
 * `editable` prop 控制读写：默认 false（viewer），设 true 即变可编辑文档。
 *
 * 非文本 block（divider / image / file_attachment）走朴素 RN 组件，简单不重复。
 *
 * 容器 block（quote / list / textblock）：内部 children 是嵌套 block，递归 FlowDocBlocks。
 *
 * v1 支持：paragraph / heading-1..6 / code / quote / divider
 * v2 待补：bulletlistblock / numberedlistblock / image / file_attachment
 */
import React, {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ImageStyle,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import Video, { type VideoRef } from 'react-native-video';
import Pdf from 'react-native-pdf';
import { WebView } from 'react-native-webview';
import Orientation from 'react-native-orientation-locker';
import { downloadAttachment } from './attachmentDownload';
import {
  hasPreviewApiSupport,
  readPreviewByUrl,
  triggerPreviewForUrl,
  type VideoPreview,
} from './previewApi';
import { Element as SlateElement, type Descendant } from 'slate';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import {
  FlowDocInput,
  type FlowDocContent,
  type FlowDocContentPart,
  type FlowDocInputHandle,
  type FlowDocMarkName,
} from './FlowDocInput';

/* ============================================================
 * 类型
 * ============================================================ */

type SlateMarkedText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  color?: string;
  link?: string;
};

type RefPillNode = {
  type: 'ref-pill';
  refKey: string;
  mention: string;
  title?: string;
  isPointer?: boolean;
  children: [{ text: '' }];
};

type SlateBlockBase<T extends string> = {
  type: T;
  children: Descendant[];
  /** web 端自主缩进级数（indent）；>0 时整块左移 indent × INDENT_STEP */
  indent?: number;
};

type ParagraphBlock = SlateBlockBase<'paragraph'>;
/** 嵌套文本块容器（对齐 web textblock）：children 头部是 inline 主文本，之后是嵌套子块。
 *  仅当 web textblock 真的带嵌套子块时才会出现；无嵌套的 textblock 解码成 paragraph。 */
type TextBlockContainer = SlateBlockBase<'textblock'>;
type HeadingBlock = SlateBlockBase<
  'heading-one' | 'heading-two' | 'heading-three' | 'heading-four' | 'heading-five' | 'heading-six'
>;
type CodeBlock = SlateBlockBase<'code'>;
type QuoteBlock = SlateBlockBase<'quote'>;
type DividerBlock = { type: 'divider'; children: [{ text: '' }]; indent?: number };
/* FlowDoc 的 listblock 结构：children 头部是 inline 内容（item 主文本），后面是嵌套 block。
   - order_in_list：web 端持久化的序号；前端不做累加，直接读
   - numberingStyle：'decimal' / 'lower-alpha' / 'upper-alpha' / 'lower-roman'；缺省时按 depth 循环
   对齐 FlopsWeb listUtils.formatListMarker 实现 */
type NumberingStyle = 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman';
type ListBlock = SlateBlockBase<'bulletlistblock' | 'numberedlistblock'> & {
  order_in_list?: number;
  numberingStyle?: NumberingStyle;
};

/** 图片 void block：children 是 [{text:''}] 占位；url 是图源（或 base64 data URL） */
type ImageBlock = {
  type: 'image';
  url?: string;
  alt?: string;
  /** 图注：web 端是纯字符串属性，移动端用自研原生引擎(FlowDocInput)渲染成只读文本 */
  caption?: string;
  width?: number;
  height?: number;
  /** 非破坏裁剪：0–1 归一化矩形（对齐 web element.crop）。需配合 width/height(自然尺寸)才能渲染 */
  crop?: { x: number; y: number; width: number; height: number };
  children: [{ text: '' }];
  indent?: number;
};

/* 表格：table > tableRow > tableCell > block[]（cell 是 mini-doc）。对齐 web flowdoc-editor-core schema。
   - align：每列对齐 'left'|'center'|'right'|null（null=默认左）
   - colWidths：每列宽度 px（null=该列用默认宽）；整字段可为 null
   - tableCell.isHeader：首行为 true */
type TableAlign = 'left' | 'center' | 'right' | null;
type TableCellBlock = {
  type: 'tableCell';
  isHeader?: boolean;
  /** 单元格背景色（web cell.bgColor，色板设的 CSS 颜色字符串） */
  bgColor?: string;
  children: Descendant[];
};
type TableRowBlock = {
  type: 'tableRow';
  children: TableCellBlock[];
};
type TableBlock = {
  type: 'table';
  align?: TableAlign[];
  colWidths?: (number | null)[] | null;
  children: Descendant[];
  indent?: number;
};

/** 文件附件 void block：url 可点击打开 */
type FileAttachmentBlock = {
  type: 'file_attachment';
  url?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
  /** web display 字段：'card'=300 卡片；'inline'=小图标+文件名链接（单行链接模式）；
   *  'preview'=块级原比例媒体预览（image 直接渲染，video/pdf 等移动端无播放器→回落大卡片） */
  display?: 'card' | 'inline' | 'preview';
  children: [{ text: '' }];
  indent?: number;
};

export type FlowDocBlock =
  | ParagraphBlock
  | TextBlockContainer
  | HeadingBlock
  | CodeBlock
  | QuoteBlock
  | DividerBlock
  | ListBlock
  | ImageBlock
  | FileAttachmentBlock
  | TableBlock;

export type FlowDocDocument = FlowDocBlock[];

/* ============================================================
 * 主组件
 * ============================================================ */

export type FlowDocBlocksProps = {
  document: FlowDocDocument;
  /** 是否可编辑。默认 false（viewer）；true 时每个文本 block 变成可编辑 input */
  editable?: boolean;
  /** 编辑模式下文本变化时回调 */
  onChange?: (doc: FlowDocDocument) => void;
  /** 点 pill 触发；不传则 pill 不可点 */
  onPillPress?: (refKey: string) => void;
  style?: ViewStyle;
  /** 虚拟化：顶层 block 用 FlatList 渲染（自带滚动，只挂可视区+缓冲）。仅 viewer(只读) 用，
   *  长文档省内存/首屏快/不全量重排。开启后本组件即滚动容器，外层别再套 ScrollView。 */
  virtualized?: boolean;
  /** 虚拟化时的列表头（如文档大标题） */
  ListHeaderComponent?: React.ReactElement | null;
  /** 虚拟化时的内容内边距样式（对应原 ScrollView contentContainerStyle） */
  contentContainerStyle?: StyleProp<ViewStyle>;
};

/** 文档可切换的 block 类型；FlowDoc 端 paragraph / heading-2..6 / code / quote 都接收同样的 inline children */
export type FlowDocConvertibleBlockType =
  | 'paragraph'
  | 'heading-two'
  | 'heading-three'
  | 'heading-four'
  | 'heading-five'
  | 'heading-six'
  | 'code'
  | 'quote'
  | 'bulletlistblock'
  | 'numberedlistblock';

export type FlowDocBlocksHandle = {
  /** 给当前 focused block 加 mark */
  applyMark: (mark: FlowDocMarkName, value?: string) => void;
  /** 给当前 focused block 去 mark */
  removeMark: (mark: FlowDocMarkName) => void;
  /** 切换 focused block 的 type；children 保持不变 */
  changeBlockType: (newType: FlowDocConvertibleBlockType) => void;
  /** 在 focused block 后插入一个新 block（默认空 paragraph） */
  insertBlockAfter: (type?: FlowDocConvertibleBlockType) => void;
  /** 编程式聚焦：传 path（数组）或 'last'（最后一个 block） */
  focus: (target?: DocPath | 'last' | 'first') => void;
  /** 当前 focused 的 block path（null = 没有焦点） */
  getFocusedPath: () => DocPath | null;
};

/** 文档级 path：纯由数字组成的数组，长度=嵌套深度。
 *  - 顶层 block index：[i]
 *  - quote 内第 j 个嵌套 block：[i, j]
 *  list 的「inline 内联部分」不算独立 path，更新时直接操作 listBlock.children 头部 inline。 */
type DocPath = number[];

/** 应用内附件预览的打开回调（对齐 web AttachmentPreviewModal：点击附件不跳浏览器，弹全屏预览）。
 *  用 Context 下发，免得在 BlockRenderer/BlockSequence/NestedBlocks 的转传链上逐层加 prop。 */
const AttachmentPreviewContext = React.createContext<
  ((block: FileAttachmentBlock) => void) | null
>(null);

/** 预览弹窗用的附件信息（与渲染块解耦的最小字段） */
type AttachmentInfo = {
  url: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

/** 按文档顺序递归收集所有带 url 的 file_attachment（含 textblock/listblock/table 嵌套），
 *  对齐 web collectDocAttachments —— 预览弹窗内可在文档全部附件间切换。 */
function collectDocAttachments(blocks: readonly unknown[], out: FileAttachmentBlock[] = []): FileAttachmentBlock[] {
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const node = b as FlowDocBlock & { children?: unknown };
    if (node.type === 'file_attachment' && typeof node.url === 'string' && node.url.trim()) {
      out.push(node as FileAttachmentBlock);
    }
    if (Array.isArray(node.children)) collectDocAttachments(node.children, out);
  }
  return out;
}

export const FlowDocBlocks = forwardRef<FlowDocBlocksHandle, FlowDocBlocksProps>(
  function FlowDocBlocks(
    {
      document,
      editable = false,
      onChange,
      onPillPress,
      style,
      virtualized,
      ListHeaderComponent,
      contentContainerStyle,
    },
    ref,
  ) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /* 结构性突变（split / insert / delete）后，native UITextView 的 textStorage 跟 JS
     doc 状态会脱节——FlowDocInput.initialContent 只在挂载时应用一次，之后改 prop
     原生不读。bump structuralGen，让所有 block 的 React key 都变 → 全部 remount →
     拿新 initialContent 重建 native 状态。代价是丢焦点，spike 阶段先接受。
     普通字符输入只走 updateBlockAtPath 不 bump，所以打字时不会闪。 */
  const [structuralGen, setStructuralGen] = React.useState(0);

  /* 应用内附件预览：点击任意附件 → 收集全文附件列表 + 定位被点的那个 → 全屏预览弹窗 */
  const [attachmentPreview, setAttachmentPreview] = React.useState<{
    list: AttachmentInfo[];
    index: number;
  } | null>(null);
  const openAttachmentPreview = React.useCallback(
    (block: FileAttachmentBlock) => {
      const all = collectDocAttachments(document);
      const idx = all.findIndex((b) => b === block);
      const list: AttachmentInfo[] = all.map((b) => ({
        url: (b.url ?? '').trim(),
        filename: b.filename,
        mimeType: b.mime_type,
        size: b.size,
      }));
      setAttachmentPreview({ list, index: Math.max(idx, 0) });
    },
    [document],
  );
  const closeAttachmentPreview = React.useCallback(() => setAttachmentPreview(null), []);

  /** 各 block 的 FlowDocInput handle 注册表，key = path.join('.') */
  const inputRefs = useRef<Map<string, FlowDocInputHandle>>(new Map());
  /** 当前 focused 的 block path（从 FlowDocInput.onFocus 上报） */
  const focusedPathRef = useRef<DocPath | null>(null);
  /** 结构性突变后要 focus 的目标 path + 光标 offset（pill 算 1 个字符）；useEffect on
   *  structuralGen 里消费。offset 缺省 / -1 = 放末尾（iOS focus 默认） */
  const pendingFocusRef = useRef<{ path: DocPath; offset: number } | null>(null);

  const registerInputRef = useCallback(
    (path: DocPath, handle: FlowDocInputHandle | null) => {
      const key = path.join('.');
      if (handle) inputRefs.current.set(key, handle);
      else inputRefs.current.delete(key);
    },
    [],
  );

  const reportFocus = useCallback((path: DocPath) => {
    focusedPathRef.current = path;
  }, []);
  const reportBlur = useCallback((path: DocPath) => {
    // 只在仍指向自己时才清；用户从 A 跳到 B 时 A.onBlur 在 B.onFocus 之后才到，避免清错
    const cur = focusedPathRef.current;
    if (cur && cur.length === path.length && cur.every((v, i) => v === path[i])) {
      focusedPathRef.current = null;
    }
  }, []);

  const updateBlockAtPath = React.useCallback(
    (path: DocPath, updater: (block: FlowDocBlock) => FlowDocBlock) => {
      if (!onChange || path.length === 0) return;
      const next = updateDocAtPath(document, path, updater);
      onChange(next);
    },
    [document, onChange],
  );

  const insertSiblingAfter = React.useCallback(
    (path: DocPath, newBlock: FlowDocBlock) => {
      if (!onChange || path.length === 0) return;
      const next = insertSiblingAfterInDoc(document, path, newBlock);
      onChange(next);
      // 焦点跳到新插入的 sibling（块通常空，offset 0 / -1 都行；选 0 表示明确开头）
      const newPath = [...path.slice(0, -1), path[path.length - 1] + 1];
      pendingFocusRef.current = { path: newPath, offset: 0 };
      setStructuralGen((g) => g + 1);
    },
    [document, onChange],
  );

  /** 原子 split：先把当前 block 用 truncate 缩成前半段，再在它后面插入 makeNewBlock() 算出的新 sibling。
     合并到一次 onChange，避免两次回调各自基于闭包旧 doc 互相覆盖。 */
  const splitBlock = React.useCallback(
    (
      path: DocPath,
      truncate: (b: FlowDocBlock) => FlowDocBlock,
      makeNewBlock: () => FlowDocBlock,
    ) => {
      if (!onChange || path.length === 0) return;
      const afterTruncate = updateDocAtPath(document, path, truncate);
      const next = insertSiblingAfterInDoc(afterTruncate, path, makeNewBlock());
      onChange(next);
      // 拆完焦点跳到后半段（新插入的 sibling），光标放到该块"开头"——也就是用户拆点之后该输入的位置
      const newPath = [...path.slice(0, -1), path[path.length - 1] + 1];
      pendingFocusRef.current = { path: newPath, offset: 0 };
      setStructuralGen((g) => g + 1);
    },
    [document, onChange],
  );

  /** 块首退格合段 */
  const mergeBackward = React.useCallback(
    (path: DocPath, currentContent: FlowDocContent) => {
      if (!onChange || path.length === 0) return;
      // 算合并接缝 = prev block 的 inline 长度（pill 算 1 char）；merge 之后光标放这
      const prevPath = [...path.slice(0, -1), path[path.length - 1] - 1];
      const prevBlock = getBlockAtPath(document, prevPath);
      const seamOffset = prevBlock ? inlineLogicalLength(prevBlock) : 0;
      const next = mergeBackwardInDoc(document, path, currentContent);
      if (next === document) return; // 没动（首块 / 无 prev）
      onChange(next);
      pendingFocusRef.current = { path: prevPath, offset: seamOffset };
      setStructuralGen((g) => g + 1);
    },
    [document, onChange],
  );

  /* 结构性突变后 remount 完成，handleRef 已经把新 FlowDocInput 注册到 inputRefs map。
     useEffect on structuralGen 此时消费 pendingFocusRef 指向的目标 block，把焦点跳过去。
     iOS UITextView focus() 会把 cursor 默认放到末尾——对合段（merge）来说体感对（接缝处），
     对 split 后段 / insert 新 paragraph 来说也合理（块本来就空 / 接近空）。 */
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    const handle = inputRefs.current.get(target.path.join('.'));
    handle?.focusAtOffset(target.offset);
  }, [structuralGen]);

  // MARK: - imperative API

  useImperativeHandle(
    ref,
    () => ({
      applyMark: (mark, value) => {
        const path = focusedPathRef.current;
        if (!path) return;
        const handle = inputRefs.current.get(path.join('.'));
        handle?.applyMark(mark, value);
      },
      removeMark: (mark) => {
        const path = focusedPathRef.current;
        if (!path) return;
        const handle = inputRefs.current.get(path.join('.'));
        handle?.removeMark(mark);
      },
      changeBlockType: (newType) => {
        const path = focusedPathRef.current;
        if (!path || !onChange) return;
        const next = updateDocAtPath(document, path, (b) =>
          ({ ...b, type: newType }) as unknown as FlowDocBlock,
        );
        onChange(next);
        // 类型切换：cursor 放该块末尾（最常见的体感是「转换完继续写」）
        pendingFocusRef.current = { path, offset: -1 };
        setStructuralGen((g) => g + 1);
      },
      insertBlockAfter: (type = 'paragraph') => {
        if (!onChange) return;
        const path = focusedPathRef.current;
        const newBlock = {
          type,
          children: [{ text: '' } as unknown as Descendant],
        } as unknown as FlowDocBlock;
        if (path && path.length > 0) {
          const next = insertSiblingAfterInDoc(document, path, newBlock);
          onChange(next);
          pendingFocusRef.current = {
            path: [...path.slice(0, -1), path[path.length - 1] + 1],
            offset: 0,
          };
        } else {
          // 没焦点：追加到末尾
          const next: FlowDocDocument = [...document, newBlock];
          onChange(next);
          pendingFocusRef.current = { path: [next.length - 1], offset: 0 };
        }
        setStructuralGen((g) => g + 1);
      },
      focus: (target) => {
        let key: string | null = null;
        if (target === 'last') {
          key = String(Math.max(0, document.length - 1));
        } else if (target === 'first') {
          key = '0';
        } else if (Array.isArray(target)) {
          key = target.join('.');
        } else {
          // 没传：尝试用 focusedPathRef
          key = focusedPathRef.current ? focusedPathRef.current.join('.') : null;
        }
        if (key == null) return;
        const handle = inputRefs.current.get(key);
        handle?.focus();
      },
      getFocusedPath: () => focusedPathRef.current,
    }),
    [document, onChange],
  );

  const previewModal = attachmentPreview ? (
    <AttachmentPreviewModal
      attachments={attachmentPreview.list}
      initialIndex={attachmentPreview.index}
      onClose={closeAttachmentPreview}
    />
  ) : null;

  // 虚拟化（仅 viewer）：顶层 block 用 FlatList 渲染，只挂可视区 + 缓冲，长文档省内存/首屏快。
  if (virtualized) {
    return (
      <AttachmentPreviewContext.Provider value={openAttachmentPreview}>
      <FlatList
        data={document}
        keyExtractor={(_item, i) => `${structuralGen}-${i}`}
        renderItem={({ item, index }) => (
          <BlockRenderer
            block={item}
            editable={editable}
            styles={styles}
            colors={colors}
            onPillPress={onPillPress}
            depth={0}
            path={[index]}
            updateBlockAtPath={updateBlockAtPath}
            insertSiblingAfter={insertSiblingAfter}
            splitBlock={splitBlock}
            mergeBackward={mergeBackward}
            registerInputRef={registerInputRef}
            reportFocus={reportFocus}
            reportBlur={reportBlur}
            structuralGen={structuralGen}
          />
        )}
        ListHeaderComponent={ListHeaderComponent ?? undefined}
        contentContainerStyle={contentContainerStyle}
        style={style}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={9}
        keyboardShouldPersistTaps="handled"
        /* 锚定可视内容：block 高度是动态的（文字 autoHeight、图片下载后才知尺寸、公式 bitmap 首帧渲染才长高），
           没有 getItemLayout 给不出确定高度。安卓 FlatList 在项高度异步变化时会跳动可视内容（iOS 原生会锚住、
           只是滚动条 thumb 随总高估计跳，无害）。mVCP 让原生帧级锚定首个可视项，上/下方项变高都补偿偏移。 */
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
      {previewModal}
      </AttachmentPreviewContext.Provider>
    );
  }

  return (
    <AttachmentPreviewContext.Provider value={openAttachmentPreview}>
    <View style={style}>
      <BlockSequence
        blocks={document as unknown as Descendant[]}
        editable={editable}
        styles={styles}
        colors={colors}
        onPillPress={onPillPress}
        depth={0}
        path={[]}
        updateBlockAtPath={updateBlockAtPath}
        insertSiblingAfter={insertSiblingAfter}
        splitBlock={splitBlock}
        mergeBackward={mergeBackward}
        registerInputRef={registerInputRef}
        reportFocus={reportFocus}
        reportBlur={reportBlur}
        structuralGen={structuralGen}
      />
      {previewModal}
    </View>
    </AttachmentPreviewContext.Provider>
  );
});
FlowDocBlocks.displayName = 'FlowDocBlocks';

/** 取 path 指向的 block，找不到返回 null */
function getBlockAtPath(
  doc: FlowDocDocument,
  path: DocPath,
): FlowDocBlock | null {
  if (path.length === 0) return null;
  let cur: unknown = doc;
  for (let i = 0; i < path.length; i++) {
    const arr = cur as unknown[];
    if (!Array.isArray(arr)) return null;
    cur = arr[path[i]];
    if (i < path.length - 1) {
      const node = cur as { children?: unknown };
      cur = node?.children;
    }
  }
  return (cur as FlowDocBlock) ?? null;
}

/** 算一个 block 的 inline 段逻辑长度（用于合段后定位光标到接缝）。
 *  pill 算 1 char；text 取 text.length；遇到嵌套 block（list 那种）就停。 */
function inlineLogicalLength(block: FlowDocBlock): number {
  if (!('children' in block) || !block.children) return 0;
  let total = 0;
  for (const c of block.children) {
    const cn = c as { type?: string; text?: string };
    if (cn.type === 'ref-pill' || cn.type === 'equation') {
      total += 1;
      continue;
    }
    if (
      cn.type &&
      (cn.type === 'paragraph' ||
        cn.type === 'bulletlistblock' ||
        cn.type === 'numberedlistblock' ||
        cn.type.startsWith('heading-') ||
        cn.type === 'code' ||
        cn.type === 'quote' ||
        cn.type === 'divider')
    ) {
      // 遇到嵌套 block，停（list block 的 inline 在前，嵌套子块在后）
      break;
    }
    if (typeof cn.text === 'string') total += cn.text.length;
  }
  return total;
}

/** 把 path 指向的 block 内容合并到上一个 sibling，再删除自己。
 *  上一个 sibling 是 void block（divider / image / file_attachment）时，只删 void、
 *  保留当前 block 的内容（视为用户想消掉那个 void）。
 *  首块（idx==0）或没有上一个 sibling 时返回原 doc 不动。 */
function mergeBackwardInDoc(
  doc: FlowDocDocument,
  path: DocPath,
  currentContent: FlowDocContent,
): FlowDocDocument {
  if (path.length === 0) return doc;
  const childIdx = path[path.length - 1];
  if (childIdx === 0) return doc;
  const parentPath = path.slice(0, -1);
  const prevIdx = childIdx - 1;

  const mutateChildren = (children: Descendant[]): Descendant[] | null => {
    const prevBlock = children[prevIdx] as FlowDocBlock | undefined;
    const currentBlock = children[childIdx] as FlowDocBlock | undefined;
    if (!prevBlock || !currentBlock) return null;
    const prevIsVoid =
      prevBlock.type === 'divider' ||
      prevBlock.type === 'image' ||
      prevBlock.type === 'file_attachment';
    const next = [...children];
    if (prevIsVoid) {
      // 删 void、保留当前块（光标本来就在当前块首，删 void 即可）
      next.splice(prevIdx, 1);
      return next;
    }
    // 普通合并：把 currentContent 追加到 prev 的 children（保留 prev 类型），删 current
    next[prevIdx] = {
      ...prevBlock,
      children: [...prevBlock.children, ...contentToInline(currentContent)],
    } as unknown as Descendant;
    next.splice(childIdx, 1);
    return next;
  };

  if (parentPath.length === 0) {
    const newChildren = mutateChildren(doc as unknown as Descendant[]);
    return newChildren ? (newChildren as unknown as FlowDocDocument) : doc;
  }
  return updateDocAtPath(doc, parentPath, (parent) => {
    const newChildren = mutateChildren(parent.children);
    if (!newChildren) return parent;
    return { ...parent, children: newChildren } as FlowDocBlock;
  });
}

/** 在 doc 中 path 指向的 block 后面插入一个新 sibling，返回新 doc（immutable） */
function insertSiblingAfterInDoc(
  doc: FlowDocDocument,
  path: DocPath,
  newBlock: FlowDocBlock,
): FlowDocDocument {
  if (path.length === 0) return doc;
  const childIdx = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  if (parentPath.length === 0) {
    const next = [...doc];
    next.splice(childIdx + 1, 0, newBlock);
    return next;
  }
  return updateDocAtPath(doc, parentPath, (parent) => {
    const newChildren = [...parent.children];
    newChildren.splice(childIdx + 1, 0, newBlock as unknown as Descendant);
    return { ...parent, children: newChildren } as FlowDocBlock;
  });
}

/** 不可变更新：把 doc 中 path 指向的 block 用 updater 算出新 block 替换 */
function updateDocAtPath(
  doc: FlowDocDocument,
  path: DocPath,
  updater: (block: FlowDocBlock) => FlowDocBlock,
): FlowDocDocument {
  if (path.length === 0) return doc;
  const [head, ...rest] = path;
  const next = [...doc];
  const target = next[head];
  if (!target) return doc;
  if (rest.length === 0) {
    next[head] = updater(target);
  } else {
    // 嵌套：把 target 当成"小 doc"（它的 children 里也是 block），递归更新
    const innerDoc = target.children as unknown as FlowDocDocument;
    const innerNext = updateDocAtPath(innerDoc, rest, updater);
    next[head] = { ...target, children: innerNext as unknown as Descendant[] } as FlowDocBlock;
  }
  return next;
}

/** 渲染一串同级的 block。
 *  path 是 *父块* 的 path；child 的 path = [...path, i + indexOffset]。
 *  indexOffset 用于 list block：父块的 children 头部 inline 段占了 inline.length 个位置，
 *  nested 子块在 children 数组里从 inline.length 起算。 */
function BlockSequence({
  blocks,
  editable,
  styles,
  colors,
  onPillPress,
  depth,
  path,
  indexOffset = 0,
  updateBlockAtPath,
  insertSiblingAfter,
  splitBlock,
  mergeBackward,
  registerInputRef,
  reportFocus,
  reportBlur,
  structuralGen,
}: {
  blocks: Descendant[];
  editable: boolean;
  styles: BlocksStyles;
  colors: AppColors;
  onPillPress?: (refKey: string) => void;
  depth: number;
  path: DocPath;
  indexOffset?: number;
  updateBlockAtPath: (path: DocPath, updater: (b: FlowDocBlock) => FlowDocBlock) => void;
  insertSiblingAfter: (path: DocPath, newBlock: FlowDocBlock) => void;
  splitBlock: (
    path: DocPath,
    truncate: (b: FlowDocBlock) => FlowDocBlock,
    makeNewBlock: () => FlowDocBlock,
  ) => void;
  mergeBackward: (path: DocPath, currentContent: FlowDocContent) => void;
  registerInputRef: (path: DocPath, handle: FlowDocInputHandle | null) => void;
  reportFocus: (path: DocPath) => void;
  reportBlur: (path: DocPath) => void;
  /** 结构性突变后会 bump，作为 key 一部分强制 remount 该 block。普通打字不变 */
  structuralGen: number;
}) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockRenderer
          key={`${structuralGen}-${i}`}
          block={b as FlowDocBlock}
          editable={editable}
          styles={styles}
          colors={colors}
          onPillPress={onPillPress}
          depth={depth}
          path={[...path, i + indexOffset]}
          updateBlockAtPath={updateBlockAtPath}
          insertSiblingAfter={insertSiblingAfter}
          splitBlock={splitBlock}
          mergeBackward={mergeBackward}
          registerInputRef={registerInputRef}
          reportFocus={reportFocus}
          reportBlur={reportBlur}
          structuralGen={structuralGen}
        />
      ))}
    </>
  );
}

/* ============================================================
 * Block dispatch
 * ============================================================ */

type RendererCtx = {
  block: FlowDocBlock;
  editable: boolean;
  styles: BlocksStyles;
  colors: AppColors;
  onPillPress?: (refKey: string) => void;
  /** 嵌套深度（影响 list bullet 样式与缩进，0 = 顶层） */
  depth: number;
  /** 自身在 doc 中的 path（顶层 = [i]，嵌套 = [..., j]） */
  path: DocPath;
  /** 更新 doc 中某 path 指向的 block（仅 editable + onChange 都给时才生效） */
  updateBlockAtPath: (path: DocPath, updater: (b: FlowDocBlock) => FlowDocBlock) => void;
  /** 在 path 指向的 block 后面插入一个新 sibling */
  insertSiblingAfter: (path: DocPath, newBlock: FlowDocBlock) => void;
  /** 原子 split：truncate 当前 block + 插新 sibling 一次 onChange 完成 */
  splitBlock: (
    path: DocPath,
    truncate: (b: FlowDocBlock) => FlowDocBlock,
    makeNewBlock: () => FlowDocBlock,
  ) => void;
  /** 块首退格：把 path 指向的 block 的内容合并到上一个 sibling，再删掉自己。
   *  上一个是 void（divider/image/file_attachment）时，只删除 void、不合内容。 */
  mergeBackward: (path: DocPath, currentContent: FlowDocContent) => void;
  /** TextBlockInput 把它内部的 FlowDocInput handle 注册 / 注销给 FlowDocBlocks */
  registerInputRef: (path: DocPath, handle: FlowDocInputHandle | null) => void;
  /** focus / blur 事件回流 */
  reportFocus: (path: DocPath) => void;
  reportBlur: (path: DocPath) => void;
  /** 结构性突变 generation，往下透传给 BlockSequence */
  structuralGen: number;
};

function BlockRenderer(ctx: RendererCtx) {
  const { block } = ctx;
  // 基准字号（表格单元格内 = 14，其余 16）。段落用它、标题按 base/16 比例缩放
  const baseFontSize = useContext(BaseFontSizeContext);
  // 文本类 block 的统一 onContentChange：替换 block.children 为 native 内联回来的 content
  const onWholeChildrenChange = ctx.editable
    ? (newContent: FlowDocContent) => {
        ctx.updateBlockAtPath(ctx.path, (b) =>
          ({ ...b, children: contentToInline(newContent) }) as FlowDocBlock,
        );
      }
    : undefined;
  /* Enter 拆段：用 splitBlock 原子操作（一次 onChange），不能拆成两次 update 否则
     第二次基于的还是闭包旧 doc，会覆盖第一次插入的结果。
     heading 默认仍然拆成 heading（同 web 行为）；产品上想要 "heading → 新 paragraph" 后续在 v4.4 改 */
  const onSplitSameType = ctx.editable
    ? (newContent: FlowDocContent, offset: number) => {
        const [before, after] = splitContentAt(newContent, offset);
        ctx.splitBlock(
          ctx.path,
          (b) => ({ ...b, children: contentToInline(before) }) as FlowDocBlock,
          () => ({ ...block, children: contentToInline(after) }) as FlowDocBlock,
        );
      }
    : undefined;
  const onMergeBackward = ctx.editable
    ? (currentContent: FlowDocContent) => {
        ctx.mergeBackward(ctx.path, currentContent);
      }
    : undefined;

  const rendered = ((): React.ReactNode => {
  switch (block.type) {
    case 'textblock':
      return <TextBlockContainerRenderer ctx={ctx} block={block as TextBlockContainer} />;
    case 'bulletlistblock':
    case 'numberedlistblock':
      return <ListBlockRenderer ctx={ctx} block={block as ListBlock} />;
    case 'paragraph':
      return (
        <View style={ctx.styles.paragraphWrap}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children)}
            fontSize={baseFontSize}
            lineHeight={Math.round(baseFontSize * BODY_LH_RATIO)}
            onContentChange={onWholeChildrenChange}
            onSplitRequest={onSplitSameType}
            onMergeBackwardRequest={onMergeBackward}
          />
        </View>
      );
    case 'heading-one':
    case 'heading-two':
    case 'heading-three':
    case 'heading-four':
    case 'heading-five':
    case 'heading-six': {
      const level = headingLevel(block.type);
      const size = Math.round(HEADING_FONT_SIZES[level] * (baseFontSize / 16));
      return (
        <View style={{ marginTop: HEADING_MARGIN_TOP[level], marginBottom: BLOCK_SPACING / 2 }}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children, { headingForceBold: true })}
            fontSize={size}
            lineHeight={Math.round(size * HEADING_LH_RATIO[level])}
            onContentChange={onWholeChildrenChange}
            onSplitRequest={onSplitSameType}
            onMergeBackwardRequest={onMergeBackward}
          />
        </View>
      );
    }
    case 'code':
      return (
        <View style={ctx.styles.codeBlockWrap}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children)}
            fontSize={14}
            lineHeight={Math.round(14 * 1.5)}
            fontFamily={Platform.OS === 'ios' ? 'Menlo' : 'monospace'}
            textColor={CODE_TEXT_COLOR}
            enterCreatesBlock={false}
            onContentChange={onWholeChildrenChange}
            onMergeBackwardRequest={onMergeBackward}
          />
        </View>
      );
    case 'quote':
      return (
        <View style={ctx.styles.quoteWrap}>
          <NestedBlocks ctx={ctx} children={block.children} />
        </View>
      );
    case 'divider':
      return <View style={ctx.styles.divider} />;
    case 'image':
      return <ImageBlockRenderer ctx={ctx} block={block as ImageBlock} />;
    case 'file_attachment': {
      const fb = block as FileAttachmentBlock;
      // display='preview' → 块级原比例媒体预览；card/inline 走原渲染器（拆开是为各自 hooks 稳定）
      return fb.display === 'preview' ? (
        <AttachmentPreviewRenderer ctx={ctx} block={fb} />
      ) : (
        <FileAttachmentRenderer ctx={ctx} block={fb} />
      );
    }
    case 'table':
      return <TableRenderer ctx={ctx} block={block as unknown as TableBlock} />;
    default:
      return null;
  }
  })();
  // 自主缩进（web indent 字段）：整块左移 indent × INDENT_STEP。与结构性嵌套缩进相互独立。
  const indent = (block as { indent?: number }).indent;
  if (indent && indent > 0) {
    return <View style={{ marginLeft: indent * INDENT_STEP }}>{rendered}</View>;
  }
  return rendered;
}

/** image void block：宽度按 onLayout 实测的父容器宽度（不是猜屏宽，兼容缩进/单元格/iPad 分栏）；
 *  高度按图片宽高比；支持非破坏裁剪 crop；点击在外部浏览器打开原图。 */
function ImageBlockRenderer({ ctx, block }: { ctx: RendererCtx; block: ImageBlock }) {
  const url = (block.url ?? '').trim();
  // 实测父容器可用宽度——缩进 / 表格单元格 / iPad 分栏各不相同，绝不能用屏宽猜
  const [availW, setAvailW] = React.useState(0);
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setAvailW((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);
  // 真实自然尺寸：block.width/height 不一定是自然像素（裁剪图尤其会偏），crop 的宽高比必须用真值。
  // 对齐 web 的 onLoad naturalWidth/Height —— 这里用 Image.getSize 取。
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null);
  React.useEffect(() => {
    if (!url) {
      setNatural(null);
      return;
    }
    let cancelled = false;
    Image.getSize(
      url,
      (w, h) => {
        if (!cancelled && w > 0 && h > 0) setNatural({ w, h });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  const caption = (block.caption ?? '').trim();
  // 图注：纯字符串属性，用自研原生引擎(FlowDocInput)渲染成只读 italic 文本，对齐 web .image-caption
  const captionNode = caption ? (
    <View style={ctx.styles.imageCaptionWrap}>
      <FlowDocInput
        initialContent={[{ type: 'text', text: caption, marks: { italic: true } }]}
        editable={false}
        fontSize={14}
        textColor={ctx.colors.textMuted}
      />
    </View>
  ) : null;

  if (!url) {
    return (
      <View onLayout={onLayout}>
        <View style={[ctx.styles.imagePlaceholder, { height: 80 }]}>
          <Text style={ctx.styles.imagePlaceholderText}>（图片缺 url）</Text>
        </View>
        {captionNode}
      </View>
    );
  }

  // 显示宽 = 实测可用宽；若 block.width 更小（用户缩过的显示宽）则不放大，对齐 web maxWidth:100%
  const displayW =
    block.width && block.width > 0 ? Math.min(availW, block.width) : availW;
  // 宽高比优先用真实自然尺寸；未取到时退回 block 比值，再退 16:9
  const naturalAspect = natural ? natural.w / natural.h : null;
  const aspect =
    naturalAspect ??
    (block.width && block.height && block.width > 0 && block.height > 0
      ? block.width / block.height
      : 16 / 9);
  const crop = block.crop;
  const canCrop = !!crop && crop.width > 0 && crop.height > 0;

  let imageNode: React.ReactNode = null;
  if (availW > 0) {
    // crop 必须有真实自然宽高比才正确——未取到 natural 前不渲染（避免闪一下错比例 / 未裁剪全图）
    if (canCrop && crop && naturalAspect) {
      const A = naturalAspect;
      // 裁剪区显示尺寸：高 = displayW * (cropH/cropW) / A；内图放大 1/cropW 并按 -cropX/-cropY 偏移
      const dispH = (displayW * (crop.height / crop.width)) / A;
      const innerW = displayW / crop.width;
      const innerH = innerW / A;
      imageNode = (
        <View style={[ctx.styles.imageCropBox, { width: displayW, height: dispH }]}>
          <Image
            source={{ uri: url }}
            style={[
              ctx.styles.imageCropInner,
              {
                width: innerW,
                height: innerH,
                left: -(crop.x / crop.width) * displayW,
                top: -(crop.y / crop.height) * dispH,
              },
            ]}
            resizeMode="stretch"
            accessible
            accessibilityLabel={block.alt}
          />
        </View>
      );
    } else if (!canCrop) {
      imageNode = (
        <Image
          source={{ uri: url }}
          style={[ctx.styles.image, { width: displayW, height: displayW / aspect }]}
          resizeMode="cover"
          accessible
          accessibilityLabel={block.alt}
        />
      );
    }
    // canCrop 但 natural 还没取到：imageNode 保持 null，等 getSize 回来再渲染
  }

  return (
    <View onLayout={onLayout}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => Linking.openURL(url).catch(() => {})}
      >
        {imageNode}
      </TouchableOpacity>
      {captionNode}
    </View>
  );
}

/** file_attachment：一个 chip 行，📎 + filename（+ size）；点击打开 url（如有） */
/* 文件类型图标：按扩展名/mime 分类 → lucide 图标 + 颜色，对齐 web attachmentIcon.jsx。
   path 直接抠自 lucide-react（含 file-video=file-play / file-audio=file-headphone 别名）。 */
const _FILE_BASE =
  'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z';
const _FILE_CORNER = 'M14 2v5a1 1 0 0 0 1 1h5';
type _IconShape = { paths: string[]; circles?: { cx: number; cy: number; r: number }[] };
const ATTACHMENT_ICONS: Record<string, _IconShape> = {
  image: {
    paths: [_FILE_BASE, _FILE_CORNER, 'm20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22'],
    circles: [{ cx: 10, cy: 12, r: 2 }],
  },
  video: {
    paths: [
      _FILE_BASE,
      _FILE_CORNER,
      'M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z',
    ],
  },
  audio: {
    paths: [
      'M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343',
      _FILE_CORNER,
      'M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0',
    ],
  },
  pdf: {
    paths: [
      _FILE_BASE,
      _FILE_CORNER,
      'M11 18h2',
      'M12 12v6',
      'M9 13v-.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v.5',
    ],
  },
  archive: {
    paths: [
      'M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5',
      _FILE_CORNER,
      'M8 12v-1',
      'M8 18v-2',
      'M8 7V6',
    ],
    circles: [{ cx: 8, cy: 20, r: 2 }],
  },
  sheet: {
    paths: [_FILE_BASE, _FILE_CORNER, 'M8 13h2', 'M14 13h2', 'M8 17h2', 'M14 17h2'],
  },
  code: {
    paths: [_FILE_BASE, _FILE_CORNER, 'M10 12.5 8 15l2 2.5', 'm14 12.5 2 2.5-2 2.5'],
  },
  text: {
    paths: [_FILE_BASE, _FILE_CORNER, 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  },
  '3d': {
    paths: [
      'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
      'm3.3 7 8.7 5 8.7-5',
      'M12 22V12',
    ],
  },
  default: { paths: [_FILE_BASE, _FILE_CORNER] },
};
const ATTACHMENT_COLORS: Record<string, string> = {
  image: '#0ea5e9',
  video: '#a855f7',
  audio: '#22c55e',
  pdf: '#ef4444',
  archive: '#a16207',
  sheet: '#16a34a',
  code: '#6366f1',
  text: '#64748b',
  '3d': '#0891b2',
  default: '#6b7280',
};
const ATTACHMENT_EXT_MAP: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  bmp: 'image', svg: 'image', heic: 'image', avif: 'image', ico: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio',
  pdf: 'pdf',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive',
  rar: 'archive', bz2: 'archive', xz: 'archive',
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet',
  js: 'code', jsx: 'code', ts: 'code', tsx: 'code', py: 'code', rb: 'code',
  go: 'code', rs: 'code', c: 'code', h: 'code', cpp: 'code', hpp: 'code',
  cc: 'code', java: 'code', kt: 'code', swift: 'code', php: 'code', sh: 'code',
  bash: 'code', zsh: 'code', lua: 'code', sql: 'code', json: 'code', yaml: 'code',
  yml: 'code', toml: 'code', xml: 'code', html: 'code', htm: 'code', css: 'code',
  scss: 'code', less: 'code', vue: 'code', svelte: 'code',
  ply: '3d', splat: '3d', splatv: '3d', glb: '3d', gltf: '3d', obj: '3d',
  fbx: '3d', stl: '3d', usdz: '3d',
  txt: 'text', md: 'text', rst: 'text', log: 'text',
  doc: 'text', docx: 'text', odt: 'text', rtf: 'text', pages: 'text',
  ppt: 'text', pptx: 'text', key: 'text',
};

function attachmentCategory(filename?: string, mimeType?: string): string {
  const s = String(filename || '').toLowerCase();
  const dot = s.lastIndexOf('.');
  const ext = dot >= 0 && dot < s.length - 1 ? s.slice(dot + 1) : '';
  if (ext && ATTACHMENT_EXT_MAP[ext]) return ATTACHMENT_EXT_MAP[ext];
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt === 'application/pdf') return 'pdf';
  if (mt === 'application/zip' || mt.includes('compressed') || mt.includes('archive')) return 'archive';
  if (mt.includes('spreadsheet') || mt === 'text/csv') return 'sheet';
  if (mt.startsWith('text/') || mt.includes('word') || mt.includes('document')) return 'text';
  return 'default';
}

/** 按文件类型渲染对应 lucide 图标 + 颜色（对齐 web AttachmentIcon） */
function AttachmentIcon({
  filename,
  mimeType,
  size = 28,
}: {
  filename?: string;
  mimeType?: string;
  size?: number;
}) {
  const cat = attachmentCategory(filename, mimeType);
  const shape = ATTACHMENT_ICONS[cat] ?? ATTACHMENT_ICONS.default;
  const color = ATTACHMENT_COLORS[cat] ?? ATTACHMENT_COLORS.default;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shape.paths.map((d, i) => (
        <Path key={i} d={d} />
      ))}
      {shape.circles?.map((cc, i) => (
        <Circle key={`c${i}`} cx={cc.cx} cy={cc.cy} r={cc.r} />
      ))}
    </Svg>
  );
}

function FileAttachmentRenderer({
  ctx,
  block,
}: {
  ctx: RendererCtx;
  block: FileAttachmentBlock;
}) {
  const name = (block.filename ?? '').trim() || '附件';
  const url = (block.url ?? '').trim();
  const sizeLabel = formatFileSize(block.size);
  const open = url ? () => Linking.openURL(url).catch(() => {}) : undefined;
  // 点击附件本体 → 应用内预览弹窗（对齐 web）；拿不到 context 时退回外跳
  const openPreview = React.useContext(AttachmentPreviewContext);
  const onPressBody = url && openPreview ? () => openPreview(block) : open;
  // 下载键 → 应用内下载（Android 进系统下载目录；iOS 下完弹保存/分享菜单），不再跳浏览器
  const [downloading, setDownloading] = React.useState(false);
  const handleDownload = url
    ? () => {
        if (downloading) return;
        setDownloading(true);
        downloadAttachment(url, block.filename)
          .catch(() => {})
          .finally(() => setDownloading(false));
      }
    : undefined;
  const iconColor = ctx.colors.textMuted;
  // 卡片宽实测（hook 必须无条件调用，放在任何 early-return 之前）
  const [availW, setAvailW] = React.useState(0);
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setAvailW((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);

  // display='inline'：紧凑单行链接（小图标 + 文件名链接），对齐 web .flowdoc-file-attachment-inline
  if (block.display === 'inline') {
    return (
      <TouchableOpacity
        style={ctx.styles.fileInline}
        onPress={onPressBody}
        activeOpacity={0.7}
        accessible
        accessibilityLabel={`附件 ${name}`}
      >
        <AttachmentIcon filename={block.filename} mimeType={block.mime_type} size={14} />
        <Text style={ctx.styles.fileInlineText} numberOfLines={1} ellipsizeMode="middle">
          {name}
        </Text>
      </TouchableOpacity>
    );
  }
  // 卡片宽 = min(300, 实测可用宽)。不用 width:300 + maxWidth:'100%'——父容器宽度不确定时
  // 百分比 maxWidth 解析不出来、300 不收缩会在窄容器溢出（独占一行/分栏/嵌套时）。
  const cardW = availW > 0 ? Math.min(300, availW) : 300;
  // 对齐 web .assistant-attachment-card：圆角带边框卡片，左 body(图标+名/大小)、右独立下载段
  return (
    <View onLayout={onLayout}>
      <View style={[ctx.styles.fileCard, { width: cardW }]}>
      <TouchableOpacity
        style={ctx.styles.fileCardBody}
        onPress={onPressBody}
        activeOpacity={0.7}
        accessible
        accessibilityLabel={`附件 ${name}`}
      >
        {/* 按文件类型上色的图标 */}
        <AttachmentIcon filename={block.filename} mimeType={block.mime_type} size={28} />
        <View style={ctx.styles.fileCardText}>
          <Text style={ctx.styles.fileAttachmentName} numberOfLines={1} ellipsizeMode="middle">
            {name}
          </Text>
          {sizeLabel ? (
            <Text style={ctx.styles.fileAttachmentSize}>{sizeLabel}</Text>
          ) : null}
        </View>
      </TouchableOpacity>
      {url ? (
        <TouchableOpacity
          style={ctx.styles.fileCardDownload}
          onPress={handleDownload}
          activeOpacity={0.7}
          accessibilityLabel="下载"
        >
          {downloading ? (
            <ActivityIndicator size="small" color={iconColor} />
          ) : (
            // 下载图标（lucide download）
            <Svg
              width={18}
              height={18}
              viewBox="0 0 24 24"
              fill="none"
              stroke={iconColor}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <Path d="M7 10l5 5 5-5" />
              <Path d="M12 15V3" />
            </Svg>
          )}
        </TouchableOpacity>
      ) : null}
      </View>
    </View>
  );
}

/**
 * 独立附件渲染器（供文档之外复用，如聊天气泡）：卡片 / inline 链接 + 自带全屏预览弹窗。
 * 对齐 web —— 用户消息附件走 display='inline'（小图标 + 文件名链接），
 * assistant / 任务产出文件走 display='card'（300 卡片，图标 + 名/大小 + 下载）。
 * 点击本体即在应用内全屏预览（本组件自持一个单附件的预览弹窗，不依赖 FlowDocBlocks 容器）。
 */
export function FlowDocAttachment({
  url,
  filename,
  mimeType,
  size,
  display = 'card',
}: {
  url?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  display?: 'card' | 'inline';
}) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [preview, setPreview] = React.useState<AttachmentInfo | null>(null);
  const openPreview = React.useCallback((block: FileAttachmentBlock) => {
    const u = (block.url ?? '').trim();
    if (!u) return;
    setPreview({ url: u, filename: block.filename, mimeType: block.mime_type, size: block.size });
  }, []);
  const closePreview = React.useCallback(() => setPreview(null), []);

  const block: FileAttachmentBlock = {
    type: 'file_attachment',
    url,
    filename,
    mime_type: mimeType,
    size,
    display,
    children: [{ text: '' }],
  };
  // FileAttachmentRenderer 只读 ctx.styles / ctx.colors，其余 RendererCtx 字段用不到 → 造最小 ctx。
  const ctx = { styles, colors } as unknown as RendererCtx;

  return (
    <AttachmentPreviewContext.Provider value={openPreview}>
      <FileAttachmentRenderer ctx={ctx} block={block} />
      {preview ? (
        <AttachmentPreviewModal attachments={[preview]} initialIndex={0} onClose={closePreview} />
      ) : null}
    </AttachmentPreviewContext.Provider>
  );
}

/** 附件 preview 媒体类型（对齐 web attachmentPreviewKind）：image/video/pdf 原生渲染，
 *  splatv 走 WebView 嵌 4D viewer（web 也是 iframe），其余回落大卡片。 */
const PREVIEW_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|ico)$/i;
const PREVIEW_VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i;
function previewKind(
  filename?: string,
  mimeType?: string,
): 'image' | 'video' | 'pdf' | 'splatv' | 'other' {
  const mt = (mimeType ?? '').toLowerCase();
  const fn = (filename ?? '').trim();
  if (mt.startsWith('image/') || PREVIEW_IMAGE_EXT.test(fn)) return 'image';
  if (mt.startsWith('video/') || PREVIEW_VIDEO_EXT.test(fn)) return 'video';
  if (mt === 'application/pdf' || /\.pdf$/i.test(fn)) return 'pdf';
  if (/\.splatv$/i.test(fn)) return 'splatv';
  return 'other';
}

/** splatv（4D Gaussian Splatting）在线 viewer 地址，对齐 web AttachmentPreviewContent 的 iframe */
function splatvViewerUrl(url: string): string {
  return `https://4d.kiriengine.com/viewer?model=${encodeURIComponent(url)}`;
}

/**
 * 把内嵌 viewer 网页缩放到 50%（对齐 web 的"放大 2 倍再 scale(0.5)"）。
 * 强制 viewport initial-scale=0.5：布局视口变 2 倍、内容渲染 0.5，canvas 仍铺满 WebView。
 */
const SPLATV_HALF_ZOOM_JS = `
(function(){
  try {
    var set = function(){
      var m = document.querySelector('meta[name=viewport]');
      if (!m) { m = document.createElement('meta'); m.setAttribute('name','viewport'); (document.head||document.documentElement).appendChild(m); }
      m.setAttribute('content','width=device-width, initial-scale=0.5, minimum-scale=0.5, maximum-scale=0.5, user-scalable=no');
    };
    set();
    document.addEventListener('DOMContentLoaded', set);
  } catch (e) {}
  true;
})();
`;

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** 自绘视频播放器 UI（固定黑白配色，不依赖主题；文档内联与全屏预览弹窗共用） */
const videoUI = StyleSheet.create({
  container: {
    backgroundColor: '#000',
    overflow: 'hidden',
  } as ViewStyle,
  centerWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  statusWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
  } as ViewStyle,
  statusText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    textAlign: 'center',
  } as TextStyle,
  statusRetry: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  } as TextStyle,
  centerPlay: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 11, // 给最底沿 3px 进度条留出空间
    backgroundColor: 'rgba(0,0,0,0.45)',
  } as ViewStyle,
  clock: {
    color: '#fff',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  } as TextStyle,
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.25)',
  } as ViewStyle,
  progressFill: {
    height: 3,
    backgroundColor: '#fff',
  } as ViewStyle,
});

/** preview 视频的极简自绘播放器（系统 controls 太重，全关自绘）：
 *  - 未播放：画面上仅一个居中播放按钮
 *  - 播放中：隐藏全部 UI；点击画面切换显示
 *  - 显示的 UI 仅底部一小条：最底沿细进度条 + 播放/暂停、时间/总时长、全屏
 *  - 全屏走原生全屏播放器（iOS AVPlayer / Android ExoPlayer），播放中显示 UI 数秒无操作自动隐藏 */
function VideoPreviewPlayer({
  url,
  width,
  height,
  onAspect,
  style,
  filename,
  mimeType,
}: {
  url: string;
  width: number;
  height: number;
  onAspect?: (aspect: number) => void;
  style?: StyleProp<ViewStyle>;
  filename?: string;
  mimeType?: string;
}) {
  const videoRef = React.useRef<VideoRef>(null);
  const [paused, setPaused] = React.useState(true);
  const [started, setStarted] = React.useState(false);
  const [showUI, setShowUI] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const endedRef = React.useRef(false);

  /* 转码镜像状态机（对齐 web AttachmentPreviewContent）：原始视频用 VP9/AV1 等移动端原生
     播放器解不了的编码时，AVPlayer 会 onError；此时查/触发后端 H.264 镜像，ready 后改播镜像。
     - effectiveUrl：ready 有镜像就播镜像，否则播原始
     - 挂载先查一次 by-url（后端可能已有镜像）；pending 时每 4s 轮询
     - 原始播放失败且无镜像 → 自动触发一次转码（mobile 不弹按钮，直接生成）*/
  const [preview, setPreview] = React.useState<VideoPreview | null>(null);
  const [videoErrored, setVideoErrored] = React.useState(false);
  const triggeredRef = React.useRef(false);
  const effectiveUrl =
    preview?.state === 'ready' && preview.url ? preview.url : url;

  React.useEffect(() => {
    // 切视频源：重置状态机
    setPreview(null);
    setVideoErrored(false);
    triggeredRef.current = false;
  }, [url]);

  React.useEffect(() => {
    setVideoErrored(false);
  }, [effectiveUrl]);

  // 挂载查一次 sidecar（后端新策略下 VP9/AV1 也会有镜像）
  React.useEffect(() => {
    if (!url || !hasPreviewApiSupport()) return;
    let cancelled = false;
    readPreviewByUrl(url).then((p) => {
      if (!cancelled && p) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // pending 时轮询直到 ready / failed
  React.useEffect(() => {
    if (!url || preview?.state !== 'pending') return;
    const t = setInterval(() => {
      readPreviewByUrl(url).then((p) => {
        if (p) setPreview(p);
      });
    }, 4000);
    return () => clearInterval(t);
  }, [url, preview?.state]);

  const onVideoError = React.useCallback(() => {
    setVideoErrored(true);
    const s = preview?.state;
    // 镜像/进行中/已失败：交给下面的 mode 计算展示，不再重复触发
    if (s === 'ready' || s === 'pending' || s === 'failed') return;
    // 原始播放失败且无镜像：自动触发一次后台转码
    if (!hasPreviewApiSupport() || triggeredRef.current) return;
    triggeredRef.current = true;
    triggerPreviewForUrl(url, filename || '', mimeType || 'video/mp4').then((p) => {
      // null = 触发失败（网络/服务端）→ 标 failed 给用户重试入口，避免卡在"生成中"
      setPreview(p || { state: 'failed' });
    });
  }, [preview?.state, url, filename, mimeType]);

  const onRetry = React.useCallback(() => {
    if (!hasPreviewApiSupport()) return;
    triggeredRef.current = true;
    setVideoErrored(false);
    setPreview({ state: 'pending' });
    triggerPreviewForUrl(url, filename || '', mimeType || 'video/mp4').then((p) => {
      setPreview(p || { state: 'failed' });
    });
  }, [url, filename, mimeType]);

  /* 展示模式：
     - play：渲染 Video 播 effectiveUrl（原始或镜像）
     - pending：转码进行中占位
     - failed：彻底无法播放（镜像也错 / 转码失败 / 无后端可兜底） */
  const mode: 'play' | 'pending' | 'failed' = (() => {
    const s = preview?.state;
    if (s === 'ready' && preview?.url) return videoErrored ? 'failed' : 'play';
    if (s === 'pending') return 'pending';
    if (s === 'failed') return 'failed';
    // 无镜像 / skipped：默认播原始；原始报错后，有后端则转 pending（已自动触发），否则 failed
    if (videoErrored) return hasPreviewApiSupport() ? 'pending' : 'failed';
    return 'play';
  })();
  // 播放中且 UI 可见 → 数秒无操作自动隐藏；依赖含 currentTime 取整段（点击/暂停会重置计时不准确——
  // 用专门的 tick 替代：每次 showUI/paused 变化重启 3.5s 定时即可，进度更新不打断倒计时
  React.useEffect(() => {
    if (!showUI || paused) return;
    const t = setTimeout(() => setShowUI(false), 3500);
    return () => clearTimeout(t);
  }, [showUI, paused]);

  const play = React.useCallback(() => {
    if (endedRef.current) {
      videoRef.current?.seek(0);
      endedRef.current = false;
    }
    setStarted(true);
    setPaused(false);
  }, []);

  const togglePlay = React.useCallback(() => {
    if (paused) play();
    else setPaused(true);
  }, [paused, play]);

  // 点击画面：未播放=开始播放；已开始=切换 UI 显隐
  const onSurfacePress = React.useCallback(() => {
    if (!started) {
      play();
      return;
    }
    setShowUI((v) => !v);
  }, [started, play]);

  const enterFullscreen = React.useCallback(() => {
    videoRef.current?.setFullScreen(true);
  }, []);

  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;
  const iconColor = '#fff';

  return (
    <View style={[videoUI.container, style, { width, height }]}>
      {mode === 'pending' ? (
        <View style={videoUI.statusWrap}>
          <ActivityIndicator color="#fff" />
          <Text style={videoUI.statusText}>正在生成可播放的视频…</Text>
        </View>
      ) : mode === 'failed' ? (
        <View style={videoUI.statusWrap}>
          <Text style={videoUI.statusText}>无法播放此视频</Text>
          {hasPreviewApiSupport() ? (
            <TouchableOpacity onPress={onRetry} hitSlop={8} activeOpacity={0.8}>
              <Text style={videoUI.statusRetry}>重试转码</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <>
          <Video
            key={effectiveUrl}
            ref={videoRef}
            source={{ uri: effectiveUrl }}
            style={StyleSheet.absoluteFill}
            paused={paused}
            resizeMode="contain"
            progressUpdateInterval={250}
            onError={onVideoError}
            onLoad={(d) => {
              if (d?.duration > 0) setDuration(d.duration);
              const ns = d?.naturalSize;
              if (ns && ns.width > 0 && ns.height > 0) onAspect?.(ns.width / ns.height);
            }}
            onProgress={(p) => setCurrentTime(p.currentTime)}
            onEnd={() => {
              endedRef.current = true;
              setPaused(true);
              setShowUI(true);
              setCurrentTime(duration);
            }}
          />
          {/* 点击层（铺满画面） */}
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={onSurfacePress}
          />
          {/* 未播放：仅居中播放按钮 */}
          {!started ? (
            <View pointerEvents="box-none" style={videoUI.centerWrap}>
              <TouchableOpacity style={videoUI.centerPlay} onPress={play} activeOpacity={0.8}>
                <Svg width={26} height={26} viewBox="0 0 24 24" fill={iconColor}>
                  {/* 视觉居中：三角形微右移 */}
                  <Path d="M9 5.5v13l11-6.5z" />
                </Svg>
              </TouchableOpacity>
            </View>
          ) : null}
          {/* 底部小条（开始播放后，点击切换显隐；暂停时常显） */}
          {started && (showUI || paused) ? (
            <View style={videoUI.bottomBar}>
              <TouchableOpacity onPress={togglePlay} hitSlop={8} activeOpacity={0.8}>
                {paused ? (
                  <Svg width={18} height={18} viewBox="0 0 24 24" fill={iconColor}>
                    <Path d="M8 5v14l11-7z" />
                  </Svg>
                ) : (
                  <Svg width={18} height={18} viewBox="0 0 24 24" fill={iconColor}>
                    <Path d="M6 4h4v16H6z" />
                    <Path d="M14 4h4v16h-4z" />
                  </Svg>
                )}
              </TouchableOpacity>
              <Text style={videoUI.clock}>
                {formatClock(currentTime)} / {formatClock(duration)}
              </Text>
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={enterFullscreen} hitSlop={8} activeOpacity={0.8}>
                {/* maximize（lucide）：全屏 */}
                <Svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={iconColor}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <Path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <Path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <Path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <Path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </Svg>
              </TouchableOpacity>
              {/* 最底沿细进度条 */}
              <View style={videoUI.progressTrack}>
                <View style={[videoUI.progressFill, { width: `${progress * 100}%` }]} />
              </View>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

/** 全屏预览弹窗的暗色 UI（固定配色，不依赖主题） */
const modalUI = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' } as ViewStyle,
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 10,
  } as ViewStyle,
  topBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  } as ViewStyle,
  titleWrap: { flex: 1, minWidth: 0, alignItems: 'center', gap: 1 } as ViewStyle,
  titleText: { color: '#fff', fontSize: 14, fontWeight: '500', maxWidth: '100%' } as TextStyle,
  counterText: { color: 'rgba(255,255,255,0.55)', fontSize: 11 } as TextStyle,
  content: { flex: 1 } as ViewStyle,
  contentInner: { flex: 1 } as ViewStyle,
  contentImage: { flex: 1 } as ImageStyle,
  navBtn: {
    position: 'absolute',
    top: '50%',
    marginTop: -22,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  } as ViewStyle,
  unsupportedWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
  } as ViewStyle,
  unsupportedName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
  } as TextStyle,
  unsupportedMeta: { color: 'rgba(255,255,255,0.55)', fontSize: 12 } as TextStyle,
  unsupportedBtn: {
    marginTop: 10,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.16)',
  } as ViewStyle,
  unsupportedBtnText: { color: '#fff', fontSize: 14 } as TextStyle,
});

/** 应用内附件全屏预览弹窗（对齐 web AttachmentPreviewModal）：
 *  不透明全屏 Modal + 内层 SafeAreaProvider（关键：让安全区随 Modal 实际旋转重新测量，
 *  否则横屏会沿用竖屏 inset）。转屏解锁/复锁也在这层（不依赖 inset）。 */
function AttachmentPreviewModal({
  attachments,
  initialIndex,
  onClose,
}: {
  attachments: AttachmentInfo[];
  initialIndex: number;
  onClose: () => void;
}) {
  /* 预览期间允许转屏：iPhone 平时锁竖屏（AppDelegate 钩子 + orientation-locker），弹窗存活时
     解锁、关闭复锁。iPad（本就全向）/ Android（系统未锁）不动。 */
  React.useEffect(() => {
    if (Platform.OS !== 'ios' || Platform.isPad) return;
    Orientation.unlockAllOrientations();
    return () => {
      Orientation.lockToPortrait();
    };
  }, []);

  return (
    <Modal
      visible
      /* 不透明全屏（不用 transparent）：透明 Modal 与底下 RN 根视图分属不同层、转屏时各自
         旋转不同步，缝隙会露出背后的文档预览页。fullScreen 不透明呈现会把背后视图移出、
         整块作为一体旋转，背后不露。 */
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
      onRequestClose={onClose}
    >
      {/* 内层 SafeAreaProvider：测量 Modal 自己（会随屏旋转）的安全区。不放它的话
          useSafeAreaInsets 读的是锁竖屏的根视图 inset，横屏时刘海/灵动岛跑到侧边却仍用顶部值。 */}
      <SafeAreaProvider>
        <AttachmentPreviewBody
          attachments={attachments}
          initialIndex={initialIndex}
          onClose={onClose}
        />
      </SafeAreaProvider>
    </Modal>
  );
}

function AttachmentPreviewBody({
  attachments,
  initialIndex,
  onClose,
}: {
  attachments: AttachmentInfo[];
  initialIndex: number;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = React.useState(
    Math.min(Math.max(initialIndex, 0), Math.max(attachments.length - 1, 0)),
  );
  // 内容区实测尺寸（video 播放器需要明确宽高）
  const [contentSize, setContentSize] = React.useState<{ w: number; h: number } | null>(null);
  const onContentLayout = React.useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    if (w > 0 && h > 0) setContentSize({ w, h });
  }, []);

  const current = attachments[index];
  const url = current?.url ?? '';
  const name = (current?.filename ?? '').trim() || '附件';
  const kind = url ? previewKind(current?.filename, current?.mimeType) : 'other';
  const sizeLabel = formatFileSize(current?.size);
  const openExternal = url ? () => Linking.openURL(url).catch(() => {}) : undefined;
  // 下载 → 应用内（Android 系统下载目录 / iOS 保存菜单），不跳浏览器
  const [downloading, setDownloading] = React.useState(false);
  const handleDownload = url
    ? () => {
        if (downloading) return;
        setDownloading(true);
        downloadAttachment(url, current?.filename)
          .catch(() => {})
          .finally(() => setDownloading(false));
      }
    : undefined;
  const iconColor = '#fff';

  let body: React.ReactNode = null;
  if (kind === 'image') {
    body = (
      <Image
        source={{ uri: url }}
        style={modalUI.contentImage}
        resizeMode="contain"
        accessible
        accessibilityLabel={name}
      />
    );
  } else if (kind === 'video') {
    body = contentSize ? (
      <VideoPreviewPlayer
        key={url}
        url={url}
        width={contentSize.w}
        height={contentSize.h}
        filename={current?.filename}
        mimeType={current?.mimeType}
      />
    ) : null;
  } else if (kind === 'pdf') {
    body = contentSize ? (
      <Pdf
        key={url}
        source={{ uri: url, cache: true }}
        style={{ width: contentSize.w, height: contentSize.h, backgroundColor: 'transparent' }}
        trustAllCerts={false}
        onError={() => {}}
      />
    ) : null;
  } else if (kind === 'splatv') {
    body = (
      <WebView
        key={url}
        source={{ uri: splatvViewerUrl(url) }}
        style={{ flex: 1, backgroundColor: '#000' }}
        allowsFullscreenVideo
        javaScriptEnabled
        domStorageEnabled
      />
    );
  } else {
    body = (
      <View style={modalUI.unsupportedWrap}>
        <AttachmentIcon filename={current?.filename} mimeType={current?.mimeType} size={72} />
        <Text style={modalUI.unsupportedName} numberOfLines={2} ellipsizeMode="middle">
          {name}
        </Text>
        {sizeLabel ? <Text style={modalUI.unsupportedMeta}>{sizeLabel}</Text> : null}
        <Text style={modalUI.unsupportedMeta}>暂不支持该类型的应用内预览</Text>
        {openExternal ? (
          <TouchableOpacity style={modalUI.unsupportedBtn} onPress={openExternal} activeOpacity={0.8}>
            <Text style={modalUI.unsupportedBtnText}>用浏览器打开</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
      <View style={modalUI.root}>
        {/* 控件全部避开安全区（灵动岛/刘海/圆角/Home 指示条）：顶栏加 top+左右 inset，
            内容区加左右+底 inset（媒体不顶进异形区），左右切换箭头跟随左右 inset。 */}
        <View
          style={[
            modalUI.topBar,
            {
              paddingTop: insets.top + 6,
              paddingLeft: insets.left + 12,
              paddingRight: insets.right + 12,
            },
          ]}
        >
          <TouchableOpacity style={modalUI.topBtn} onPress={onClose} activeOpacity={0.8}>
            {/* X 关闭 */}
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth={2} strokeLinecap="round">
              <Path d="M18 6L6 18" />
              <Path d="M6 6l12 12" />
            </Svg>
          </TouchableOpacity>
          <View style={modalUI.titleWrap}>
            <Text style={modalUI.titleText} numberOfLines={1} ellipsizeMode="middle">
              {name}
            </Text>
            {attachments.length > 1 ? (
              <Text style={modalUI.counterText}>
                {index + 1} / {attachments.length}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            style={modalUI.topBtn}
            onPress={handleDownload}
            activeOpacity={0.8}
            disabled={!handleDownload}
          >
            {downloading ? (
              <ActivityIndicator size="small" color={iconColor} />
            ) : (
              // 下载（应用内保存）
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <Path d="M7 10l5 5 5-5" />
                <Path d="M12 15V3" />
              </Svg>
            )}
          </TouchableOpacity>
        </View>
        <View
          style={[
            modalUI.content,
            {
              paddingLeft: insets.left,
              paddingRight: insets.right,
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <View style={modalUI.contentInner} onLayout={onContentLayout}>
            {body}
          </View>
        </View>
        {index > 0 ? (
          <TouchableOpacity
            style={[modalUI.navBtn, { left: insets.left + 10 }]}
            onPress={() => setIndex((i) => Math.max(i - 1, 0))}
            activeOpacity={0.8}
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M15 18l-6-6 6-6" />
            </Svg>
          </TouchableOpacity>
        ) : null}
        {index < attachments.length - 1 ? (
          <TouchableOpacity
            style={[modalUI.navBtn, { right: insets.right + 10 }]}
            onPress={() => setIndex((i) => Math.min(i + 1, attachments.length - 1))}
            activeOpacity={0.8}
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M9 18l6-6-6-6" />
            </Svg>
          </TouchableOpacity>
        ) : null}
      </View>
  );
}

/** 附件 preview 形态（display='preview'）：块级原比例媒体，对齐 web AttachmentPreviewBlock。
 *  - image：真实自然比例渲染（Image.getSize），点开看原图
 *  - video：react-native-video 原生播放器（iOS AVPlayer / Android ExoPlayer），带控件，onLoad 取真实宽高比
 *  - pdf：react-native-pdf 原生翻页（iOS PDFKit / Android Pdfium），限高内联可翻
 *  - 其它：回落居中大卡片（大图标+名+大小），对齐 web renderUnsupported */
function AttachmentPreviewRenderer({
  ctx,
  block,
}: {
  ctx: RendererCtx;
  block: FileAttachmentBlock;
}) {
  const name = (block.filename ?? '').trim() || '附件';
  const url = (block.url ?? '').trim();
  const sizeLabel = formatFileSize(block.size);
  const open = url ? () => Linking.openURL(url).catch(() => {}) : undefined;
  // 点击 → 应用内全屏预览（image 放大看、fallback 类型在弹窗里给"用浏览器打开"）
  const openPreview = React.useContext(AttachmentPreviewContext);
  const onPressBody = url && openPreview ? () => openPreview(block) : open;
  const kind = url !== '' ? previewKind(block.filename, block.mime_type) : 'other';

  // hooks 必须无条件调用，放在任何 early-return 之前
  const [availW, setAvailW] = React.useState(0);
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setAvailW((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);
  // 真实自然尺寸（image 用 Image.getSize；video 用 onLoad naturalSize 回填）。默认 16:9。
  const [aspect, setAspect] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (kind !== 'image' || !url) return;
    let cancelled = false;
    Image.getSize(
      url,
      (w, h) => {
        if (!cancelled && w > 0 && h > 0) setAspect(w / h);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [kind, url]);

  if (kind === 'image') {
    return (
      <View onLayout={onLayout}>
        {availW > 0 && aspect ? (
          <TouchableOpacity activeOpacity={0.9} onPress={onPressBody}>
            <Image
              source={{ uri: url }}
              style={[ctx.styles.previewImage, { width: availW, height: availW / aspect }]}
              resizeMode="cover"
              accessible
              accessibilityLabel={name}
            />
          </TouchableOpacity>
        ) : (
          // 自然尺寸未取到前占位（避免闪一下错比例）
          <View style={[ctx.styles.imagePlaceholder, { height: 120 }]} />
        )}
      </View>
    );
  }

  if (kind === 'video') {
    const vAspect = aspect && aspect > 0 ? aspect : 16 / 9;
    return (
      <View onLayout={onLayout}>
        {availW > 0 ? (
          <VideoPreviewPlayer
            url={url}
            width={availW}
            height={availW / vAspect}
            onAspect={setAspect}
            style={ctx.styles.previewVideo}
            filename={block.filename}
            mimeType={block.mime_type}
          />
        ) : (
          <View style={[ctx.styles.imagePlaceholder, { height: 200 }]} />
        )}
      </View>
    );
  }

  if (kind === 'pdf') {
    // PDF 是分页文档，给一个限定高度的内联可翻视图（A4 纵向 √2 比例，封顶 560）
    return (
      <View onLayout={onLayout}>
        {availW > 0 ? (
          <Pdf
            source={{ uri: url, cache: true }}
            style={[
              ctx.styles.previewPdf,
              { width: availW, height: Math.min(Math.round(availW * 1.414), 560) },
            ]}
            trustAllCerts={false}
            onError={() => {}}
          />
        ) : (
          <View style={[ctx.styles.imagePlaceholder, { height: 200 }]} />
        )}
      </View>
    );
  }

  if (kind === 'splatv') {
    // 4D Gaussian Splatting：WebView 嵌在线 viewer（对齐 web iframe），内联给 4:3 视口
    return (
      <View onLayout={onLayout}>
        {availW > 0 ? (
          <View style={[ctx.styles.previewPdf, { width: availW, height: Math.min(Math.round(availW * 0.75), 480) }]}>
            <WebView
              source={{ uri: splatvViewerUrl(url) }}
              style={{ flex: 1, backgroundColor: '#000' }}
              allowsFullscreenVideo
              javaScriptEnabled
              domStorageEnabled
              injectedJavaScriptBeforeContentLoaded={SPLATV_HALF_ZOOM_JS}
              injectedJavaScript={SPLATV_HALF_ZOOM_JS}
            />
          </View>
        ) : (
          <View style={[ctx.styles.imagePlaceholder, { height: 240 }]} />
        )}
      </View>
    );
  }

  // 其它类型 → 居中大卡片，对齐 web renderUnsupported
  return (
    <TouchableOpacity
      style={ctx.styles.previewFallbackCard}
      onPress={onPressBody}
      activeOpacity={0.7}
      accessible
      accessibilityLabel={`附件 ${name}`}
    >
      <AttachmentIcon filename={block.filename} mimeType={block.mime_type} size={56} />
      <Text style={ctx.styles.previewFallbackName} numberOfLines={2} ellipsizeMode="middle">
        {name}
      </Text>
      {sizeLabel ? <Text style={ctx.styles.previewFallbackMeta}>{sizeLabel}</Text> : null}
    </TouchableOpacity>
  );
}

/** 表格渲染：table > tableRow > tableCell。网格/边框/表头底色/列宽用 RN 组合(chrome)，
 *  每个单元格的 mini-doc 内容走 BlockSequence → 自研原生引擎渲染文本。
 *  列宽可超视口 → 外层 horizontal ScrollView 横滚（对齐 web "列宽可超出视口横滚"）。
 *  注：列对齐(align)/表头加粗当前未生效——需给原生引擎加 textAlign/forceBold，列为后续步骤。 */
function TableRenderer({ ctx, block }: { ctx: RendererCtx; block: TableBlock }) {
  const rows = (block.children as unknown as TableRowBlock[]).filter(
    (r) => r && r.type === 'tableRow',
  );
  if (rows.length === 0) return null;
  const colCount = rows.reduce(
    (m, r) => Math.max(m, Array.isArray(r.children) ? r.children.length : 0),
    0,
  );
  const colWidths = Array.isArray(block.colWidths) ? block.colWidths : [];
  const widthFor = (ci: number): number => {
    const w = colWidths[ci];
    return typeof w === 'number' && w > 0 ? w : DEFAULT_TABLE_COL_WIDTH;
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      style={ctx.styles.tableScroll}
      contentContainerStyle={ctx.styles.tableWrap}
    >
      <View>
        {rows.map((row, ri) => (
          <View key={ri} style={ctx.styles.tableRow}>
            {Array.from({ length: colCount }).map((_, ci) => {
              const cell = Array.isArray(row.children) ? row.children[ci] : undefined;
              const isHeader = !!cell?.isHeader || ri === 0;
              return (
                <View
                  key={ci}
                  style={[
                    ctx.styles.tableCell,
                    { width: widthFor(ci) },
                    isHeader && ctx.styles.tableHeaderCell,
                    cell?.bgColor ? { backgroundColor: cell.bgColor } : null,
                  ]}
                >
                  {cell && Array.isArray(cell.children) ? (
                    <BaseFontSizeContext.Provider value={TABLE_FONT_SIZE}>
                    <BlockSequence
                      blocks={cell.children}
                      editable={ctx.editable}
                      styles={ctx.styles}
                      colors={ctx.colors}
                      onPillPress={ctx.onPillPress}
                      depth={ctx.depth + 1}
                      path={[...ctx.path, ri, ci]}
                      updateBlockAtPath={ctx.updateBlockAtPath}
                      insertSiblingAfter={ctx.insertSiblingAfter}
                      splitBlock={ctx.splitBlock}
                      mergeBackward={ctx.mergeBackward}
                      registerInputRef={ctx.registerInputRef}
                      reportFocus={ctx.reportFocus}
                      reportBlur={ctx.reportBlur}
                      structuralGen={ctx.structuralGen}
                    />
                    </BaseFontSizeContext.Provider>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function formatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** quote 这种容器 block：内部 children 通常本身又是 paragraph 等 block，递归渲染 */
function NestedBlocks({ ctx, children }: { ctx: RendererCtx; children: Descendant[] }) {
  // 全是 block 的话直接走 BlockSequence；夹杂 inline 的兜底（罕见）单独处理
  const allBlocks = children.every(
    (c) => SlateElement.isElement(c) && isBlockType((c as { type?: string }).type),
  );
  if (allBlocks) {
    return (
      <BlockSequence
        blocks={children}
        editable={ctx.editable}
        styles={ctx.styles}
        colors={ctx.colors}
        onPillPress={ctx.onPillPress}
        depth={ctx.depth + 1}
        path={ctx.path}
        updateBlockAtPath={ctx.updateBlockAtPath}
        insertSiblingAfter={ctx.insertSiblingAfter}
        splitBlock={ctx.splitBlock}
        mergeBackward={ctx.mergeBackward}
        registerInputRef={ctx.registerInputRef}
        reportFocus={ctx.reportFocus}
        reportBlur={ctx.reportBlur}
        structuralGen={ctx.structuralGen}
      />
    );
  }
  return (
    <>
      {children.map((child, i) => {
        if (SlateElement.isElement(child) && isBlockType((child as { type?: string }).type)) {
          return (
            <BlockRenderer
              key={i}
              {...ctx}
              block={child as FlowDocBlock}
              depth={ctx.depth + 1}
              path={[...ctx.path, i]}
            />
          );
        }
        return (
          <View key={i} style={ctx.styles.paragraphWrap}>
            <TextBlockInput ctx={ctx} content={inlineToContent([child])} fontSize={16} />
          </View>
        );
      })}
    </>
  );
}

/** bullet / numbered listblock 渲染：
 *  - children 头部连续的"非 block"节点 = item 主文本（inline 内容）
 *  - 之后的 block 节点 = 嵌套缩进的子块
 *  - marker 由 formatListMarker 计算：order_in_list / numberingStyle 全部从数据读 */
function ListBlockRenderer({ ctx, block }: { ctx: RendererCtx; block: ListBlock }) {
  const baseFontSize = useContext(BaseFontSizeContext);
  const { inline, nested } = splitListChildren(block.children);
  const marker = formatListMarker(
    block.type,
    block.order_in_list,
    ctx.depth,
    block.numberingStyle,
  );
  // List item 主文本变化 → 替换 children 头部 inline 段，保留尾部 nested 子块
  const onInlineChange = ctx.editable
    ? (newContent: FlowDocContent) => {
        ctx.updateBlockAtPath(ctx.path, (b) => {
          const oldNested = splitListChildren(b.children).nested;
          return {
            ...b,
            children: [...contentToInline(newContent), ...oldNested],
          } as FlowDocBlock;
        });
      }
    : undefined;
  /* Enter 在 list item 内：拆成两个同类型 list block，nested 子块跟随原 item，
     新插入的 sibling 只有后段 inline。order_in_list 由 caller 持久化时再算（前端不主动累加）。 */
  const onSplitList = ctx.editable
    ? (newContent: FlowDocContent, offset: number) => {
        const [before, after] = splitContentAt(newContent, offset);
        ctx.splitBlock(
          ctx.path,
          (b) => {
            const oldNested = splitListChildren(b.children).nested;
            return {
              ...b,
              children: [...contentToInline(before), ...oldNested],
            } as FlowDocBlock;
          },
          () => ({
            type: block.type,
            children: contentToInline(after),
          }) as unknown as FlowDocBlock,
        );
      }
    : undefined;
  // bullet 用 View 画干净的小圆点（实心/空心/方块按层级），不用字符（字形大小基线都不可控）
  const isBullet = block.type === 'bulletlistblock';
  const bulletKind = ctx.depth % 3;
  return (
    <View style={ctx.styles.listItemWrap}>
      <View style={ctx.styles.listItemRow}>
        {isBullet ? (
          <View style={ctx.styles.listBulletBox}>
            <View
              style={[
                ctx.styles.bulletBase,
                bulletKind === 0
                  ? ctx.styles.bulletDisc
                  : bulletKind === 1
                    ? ctx.styles.bulletCircle
                    : ctx.styles.bulletSquare,
              ]}
            />
          </View>
        ) : (
          <Text style={ctx.styles.listItemMarker} selectable={false}>
            {marker}
          </Text>
        )}
        <View style={ctx.styles.listItemContent}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(inline)}
            fontSize={baseFontSize}
            lineHeight={Math.round(baseFontSize * BODY_LH_RATIO)}
            onContentChange={onInlineChange}
            onSplitRequest={onSplitList}
            onMergeBackwardRequest={
              ctx.editable
                ? (currentContent) => ctx.mergeBackward(ctx.path, currentContent)
                : undefined
            }
          />
        </View>
      </View>
      {nested.length > 0 ? (
        <View style={ctx.styles.listNested}>
          <BlockSequence
            blocks={nested}
            editable={ctx.editable}
            styles={ctx.styles}
            colors={ctx.colors}
            onPillPress={ctx.onPillPress}
            depth={ctx.depth + 1}
            path={ctx.path}
            /* 跳过头部 inline 段：nested[0] 在父 children 数组的真实索引 = inline.length */
            indexOffset={inline.length}
            updateBlockAtPath={ctx.updateBlockAtPath}
            insertSiblingAfter={ctx.insertSiblingAfter}
            splitBlock={ctx.splitBlock}
            mergeBackward={ctx.mergeBackward}
            registerInputRef={ctx.registerInputRef}
            reportFocus={ctx.reportFocus}
            reportBlur={ctx.reportBlur}
            structuralGen={ctx.structuralGen}
          />
        </View>
      ) : null}
    </View>
  );
}

/** textblock 容器：children 头部 inline = 主文本（段落样式），之后是 marginLeft 缩进的嵌套子块。
 *  对齐 web textblock 渲染（textblock-main-text + textblock-nested-blocks）。主文本走自研原生引擎。 */
function TextBlockContainerRenderer({
  ctx,
  block,
}: {
  ctx: RendererCtx;
  block: TextBlockContainer;
}) {
  const baseFontSize = useContext(BaseFontSizeContext);
  const { inline, nested } = splitListChildren(block.children);
  // 主文本变化 → 替换 children 头部 inline 段，保留尾部 nested 子块（同 list）
  const onInlineChange = ctx.editable
    ? (newContent: FlowDocContent) => {
        ctx.updateBlockAtPath(ctx.path, (b) => {
          const oldNested = splitListChildren(b.children).nested;
          return {
            ...b,
            children: [...contentToInline(newContent), ...oldNested],
          } as FlowDocBlock;
        });
      }
    : undefined;
  return (
    <View style={ctx.styles.textblockWrap}>
      <View style={ctx.styles.paragraphWrap}>
        <TextBlockInput
          ctx={ctx}
          content={inlineToContent(inline)}
          fontSize={baseFontSize}
          lineHeight={Math.round(baseFontSize * BODY_LH_RATIO)}
          onContentChange={onInlineChange}
          onMergeBackwardRequest={
            ctx.editable
              ? (currentContent) => ctx.mergeBackward(ctx.path, currentContent)
              : undefined
          }
        />
      </View>
      {nested.length > 0 ? (
        <View style={ctx.styles.textblockNested}>
          <BlockSequence
            blocks={nested}
            editable={ctx.editable}
            styles={ctx.styles}
            colors={ctx.colors}
            onPillPress={ctx.onPillPress}
            depth={ctx.depth + 1}
            path={ctx.path}
            /* 跳过头部 inline 段：nested[0] 在父 children 数组的真实索引 = inline.length */
            indexOffset={inline.length}
            updateBlockAtPath={ctx.updateBlockAtPath}
            insertSiblingAfter={ctx.insertSiblingAfter}
            splitBlock={ctx.splitBlock}
            mergeBackward={ctx.mergeBackward}
            registerInputRef={ctx.registerInputRef}
            reportFocus={ctx.reportFocus}
            reportBlur={ctx.reportBlur}
            structuralGen={ctx.structuralGen}
          />
        </View>
      ) : null}
    </View>
  );
}

/** 端口 FlopsWeb listUtils.formatListMarker —— 完全按数据 + depth 计算 marker 文本 */
function formatListMarker(
  listType: 'bulletlistblock' | 'numberedlistblock',
  orderInList: number | undefined,
  depth: number,
  numberingStyle?: NumberingStyle,
): string {
  if (listType === 'numberedlistblock') {
    if (orderInList === undefined || orderInList === null) return '';
    let style: NumberingStyle = numberingStyle ?? (
      // 数据没给 style：按 depth 在三种风格里循环（跟 web 同款）
      ['decimal', 'lower-alpha', 'lower-roman', 'decimal'][depth % 4] as NumberingStyle
    );
    switch (style) {
      case 'decimal':
        return `${orderInList}.`;
      case 'lower-alpha':
        return `${String.fromCharCode(97 + ((orderInList - 1) % 26))}.`;
      case 'upper-alpha':
        return `${String.fromCharCode(65 + ((orderInList - 1) % 26))}.`;
      case 'lower-roman':
        return `${toRoman(orderInList)}.`;
    }
  } else {
    // 对齐 web 浏览器默认 ul 标记：disc(•) / circle(◦) / square(▪) 按层级循环（比 ●/○ 更贴近）
    return ['•', '◦', '▪'][depth % 3];
  }
}

function toRoman(num: number): string {
  if (num <= 0) return '';
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'],
    [1, 'i'],
  ];
  let n = num;
  let out = '';
  for (const [val, sym] of table) {
    while (n >= val) {
      out += sym;
      n -= val;
    }
  }
  return out;
}

/** 把 listblock 的 children 拆成「头部 inline 内容」和「之后的 nested block 们」 */
function splitListChildren(children: Descendant[]): {
  inline: Descendant[];
  nested: Descendant[];
} {
  let i = 0;
  for (; i < children.length; i++) {
    const c = children[i];
    if (SlateElement.isElement(c) && isBlockType((c as { type?: string }).type)) {
      break;
    }
  }
  return { inline: children.slice(0, i), nested: children.slice(i) };
}

/** 单个文本 block 的实际渲染：调 FlowDocInput，按 block 类型给 fontSize / fontFamily */
function TextBlockInput({
  ctx,
  content,
  fontSize,
  fontFamily,
  lineHeight,
  textColor,
  onContentChange,
  onSplitRequest,
  onMergeBackwardRequest,
  enterCreatesBlock = true,
}: {
  ctx: RendererCtx;
  content: FlowDocContent;
  fontSize: number;
  fontFamily?: string;
  /** 行高（pt 绝对值）；缺省走原生默认 */
  lineHeight?: number;
  /** 文本颜色覆盖；缺省用主题正文色。代码块用 #eb5757 对齐 web */
  textColor?: string;
  /** native 内容变化时回调；caller 负责把 newContent 写回 doc 的正确位置 */
  onContentChange?: (newContent: FlowDocContent) => void;
  /** Enter 触发拆 block；caller 负责把当前块拆两半 + 插新块 */
  onSplitRequest?: (newContent: FlowDocContent, offset: number) => void;
  /** 块首退格触发合段；caller 把 content 合并到上一块 */
  onMergeBackwardRequest?: (currentContent: FlowDocContent) => void;
  /** code 块设 false，保留多行 */
  enterCreatesBlock?: boolean;
}) {
  /* 把这个 block 的 FlowDocInput handle 注册到 FlowDocBlocks 顶层 map，
     给 imperative API（applyMark / focus 等）找到对应 input 用。
     用 optional-chain 防御 ctx 在某些路径下缺字段（理论上不该，但 HMR 时可能短暂出现）。 */
  const path = ctx.path;
  const handleRef = useCallback(
    (h: FlowDocInputHandle | null) => {
      ctx.registerInputRef?.(path, h);
    },
    // path 是数组每次新引用；用 join 字符串做语义比较防止重复 register/unregister
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, path.join('.')],
  );
  const onFocus = useCallback(() => ctx.reportFocus?.(path), [ctx, path]);
  const onBlur = useCallback(() => ctx.reportBlur?.(path), [ctx, path]);
  return (
    <FlowDocInput
      ref={handleRef}
      initialContent={content}
      editable={ctx.editable}
      enterCreatesBlock={enterCreatesBlock}
      fontSize={fontSize}
      fontFamily={fontFamily}
      lineHeight={lineHeight}
      textColor={textColor ?? ctx.colors.textPrimary}
      pillBackgroundColor={ctx.colors.surfaceMuted}
      pillTextColor={ctx.colors.textMuted}
      onPillPress={ctx.onPillPress}
      onFocus={onFocus}
      onBlur={onBlur}
      onChangeContent={
        onContentChange
          ? (newContent) => onContentChange(newContent)
          : undefined
      }
      onSplitRequest={onSplitRequest}
      onMergeBackwardRequest={onMergeBackwardRequest}
    />
  );
}

/* ============================================================
 * 工具
 * ============================================================ */

/** 正文基准字号 context：默认 16（文档正文）；表格单元格内 = 14（对齐 web .md-table 14px），
 *  这样同样列宽下文本不会比 web 早换行。段落/标题/列表的字号都以它为基准。 */
const BaseFontSizeContext = React.createContext(16);
/** 表格单元格内基准字号（web .md-table { font-size: 14px }） */
const TABLE_FONT_SIZE = 14;

/** 每级自主缩进(indent 字段)的左移像素。web 用 32；移动端窄屏取小一档。 */
const INDENT_STEP = 20;

/** 表格列在 colWidths 缺省时的默认宽度（px）。 */
const DEFAULT_TABLE_COL_WIDTH = 130;

/** 代码文字色 / 底色，对齐 web .slate-editor code（半透明暖灰底对深浅色都安全） */
const CODE_TEXT_COLOR = '#eb5757';
const CODE_BG_COLOR = 'rgba(135,131,120,0.15)';

/* 字号/行高/边距严格对齐 web flowdoc（editorChrome.css，base 16px）：
   h1 2em / h2 1.5em / h3 1.25em / h4 1.1em / h5 1em / h6 0.9em */
const HEADING_FONT_SIZES: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 32,
  2: 24,
  3: 20,
  4: 18,
  5: 16,
  6: 14,
};
/** 各级标题 line-height 比例（web h1 1.2 / h2 1.3 / h3-4 1.4 / h5-6 1.5） */
const HEADING_LH_RATIO: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 1.2,
  2: 1.3,
  3: 1.4,
  4: 1.4,
  5: 1.5,
  6: 1.5,
};
/** 各级标题 margin-top（web：h1 2em=32 / h2 1.4em≈22 / h3 1em=16 / h4-6 = block-spacing 8） */
const HEADING_MARGIN_TOP: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 32,
  2: 22,
  3: 16,
  4: 8,
  5: 8,
  6: 8,
};
/** 正文行高比例（web data-slate-editor / p line-height: 1.6） */
const BODY_LH_RATIO = 1.6;
/** web --block-spacing = body 16 × 0.5 = 8px（RN 无 margin 折叠，块间隔用半值见各处） */
const BLOCK_SPACING = 8;

function headingLevel(t: HeadingBlock['type']): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (t) {
    case 'heading-one': return 1;
    case 'heading-two': return 2;
    case 'heading-three': return 3;
    case 'heading-four': return 4;
    case 'heading-five': return 5;
    case 'heading-six': return 6;
  }
}

function isBlockType(t: string | undefined): boolean {
  return (
    t === 'paragraph' ||
    t === 'textblock' ||
    t === 'heading-one' ||
    t === 'heading-two' ||
    t === 'heading-three' ||
    t === 'heading-four' ||
    t === 'heading-five' ||
    t === 'heading-six' ||
    t === 'code' ||
    t === 'quote' ||
    t === 'divider' ||
    t === 'bulletlistblock' ||
    t === 'numberedlistblock' ||
    t === 'image' ||
    t === 'file_attachment' ||
    t === 'table'
  );
}

/** 按"逻辑字符 offset"把一段 FlowDocContent 切两半。
 *  - pill 算 1 个字符
 *  - text part 内部按 string.slice 切
 *  marks 在切开后两边都保留 */
function splitContentAt(
  content: FlowDocContent,
  offset: number,
): [FlowDocContent, FlowDocContent] {
  const before: FlowDocContent = [];
  const after: FlowDocContent = [];
  let cursor = 0;
  for (const part of content) {
    if (part.type === 'pill' || part.type === 'equation') {
      // 原子对象（pill / 公式）算 1 个逻辑字符
      if (cursor < offset) before.push(part);
      else after.push(part);
      cursor += 1;
      continue;
    }
    const len = part.text.length;
    const endPos = cursor + len;
    if (endPos <= offset) {
      before.push(part);
    } else if (cursor >= offset) {
      after.push(part);
    } else {
      const localOffset = offset - cursor;
      const leftText = part.text.slice(0, localOffset);
      const rightText = part.text.slice(localOffset);
      if (leftText.length > 0) {
        before.push(part.marks ? { type: 'text', text: leftText, marks: part.marks } : { type: 'text', text: leftText });
      }
      if (rightText.length > 0) {
        after.push(part.marks ? { type: 'text', text: rightText, marks: part.marks } : { type: 'text', text: rightText });
      }
    }
    cursor += len;
  }
  return [before, after];
}

/** FlowDocContent → Slate inline children（反向于 inlineToContent） */
function contentToInline(content: FlowDocContent): Descendant[] {
  return content.map((p): Descendant => {
    if (p.type === 'pill') {
      return {
        type: 'ref-pill',
        refKey: p.refKey,
        mention: p.mention,
        title: p.title,
        isPointer: p.isPointer,
        children: [{ text: '' }],
      } as unknown as Descendant;
    }
    if (p.type === 'equation') {
      return {
        type: 'equation',
        tex: p.tex,
        children: [{ text: '' }],
      } as unknown as Descendant;
    }
    const leaf: Record<string, unknown> = { text: p.text };
    if (p.marks?.bold) leaf.bold = true;
    if (p.marks?.italic) leaf.italic = true;
    if (p.marks?.code) leaf.code = true;
    if (p.marks?.color) leaf.color = p.marks.color;
    if (p.marks?.link) leaf.link = p.marks.link;
    return leaf as unknown as Descendant;
  });
}

/** Slate inline children → FlowDocContent（text 部分 + pill 部分） */
function inlineToContent(
  nodes: Descendant[],
  opts: { headingForceBold?: boolean } = {},
): FlowDocContent {
  const out: FlowDocContent = [];
  for (const node of nodes) {
    if (SlateElement.isElement(node) && (node as { type?: string }).type === 'ref-pill') {
      const e = node as unknown as RefPillNode;
      out.push({
        type: 'pill',
        refKey: String(e.refKey || ''),
        mention: String(e.mention || ''),
        title: String(e.title || ''),
        isPointer: !!e.isPointer,
      });
      continue;
    }
    if (SlateElement.isElement(node) && (node as { type?: string }).type === 'equation') {
      const tex = (node as { tex?: string }).tex;
      out.push({ type: 'equation', tex: typeof tex === 'string' ? tex : '' });
      continue;
    }
    const leaf = node as SlateMarkedText;
    if (typeof leaf.text !== 'string' || leaf.text.length === 0) continue;
    const marks: NonNullable<Extract<FlowDocContentPart, { type: 'text' }>['marks']> = {};
    if (leaf.bold || opts.headingForceBold) marks.bold = true;
    if (leaf.italic) marks.italic = true;
    if (leaf.code) marks.code = true;
    if (typeof leaf.color === 'string' && leaf.color) marks.color = leaf.color;
    if (typeof leaf.link === 'string' && leaf.link) marks.link = leaf.link;
    const hasMarks = Object.keys(marks).length > 0;
    out.push(
      hasMarks
        ? { type: 'text', text: leaf.text, marks }
        : { type: 'text', text: leaf.text },
    );
  }
  return out;
}

/* ============================================================
 * Styles
 * ============================================================ */

type BlocksStyles = ReturnType<typeof createStyles>;

function createStyles(c: AppColors) {
  return StyleSheet.create({
    // RN 无 margin 折叠：web p margin 8 上下折叠成 8，这里用 4（4+4=8）等效
    paragraphWrap: { marginVertical: 4 } as ViewStyle,
    // 代码块对齐 web pre：padding 1em=16 / radius 3 / margin block-spacing(8)
    codeBlockWrap: {
      backgroundColor: CODE_BG_COLOR,
      padding: 16,
      borderRadius: 3,
      marginVertical: 8,
    } as ViewStyle,
    // 引用对齐 web .quote-block：border-left 4 / padding 12·20·12·16 / 右侧圆角 3 / margin 8
    // 背景用有区分度的灰（web 视觉上是明显灰底，不是几乎看不见的极淡 tint）
    quoteWrap: {
      borderLeftWidth: 4,
      borderLeftColor: c.borderMuted,
      backgroundColor: c.surfaceMuted,
      paddingTop: 12,
      paddingBottom: 12,
      paddingLeft: 16,
      paddingRight: 20,
      borderTopRightRadius: 3,
      borderBottomRightRadius: 3,
      marginVertical: 8,
    } as ViewStyle,
    // 分割线对齐 web：1px / margin block-spacing(8)
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.borderMuted,
      marginVertical: 8,
    } as ViewStyle,
    // web li margin 0.5em=8 上下折叠成 8 → RN 用 4
    listItemWrap: { marginVertical: 4 } as ViewStyle,
    listItemRow: { flexDirection: 'row', alignItems: 'flex-start' } as ViewStyle,
    // 序号：字号与正文一致(16) + 自然行高 → 与右侧正文(lineSpacing 后首行自然顶位)baseline 对齐
    listItemMarker: {
      width: 24,
      fontSize: 16,
      color: c.textMuted,
      textAlign: 'center',
    } as TextStyle,
    // bullet 圆点：用 View 画，尺寸 7、marginTop 让它对齐到首行文字垂直中部
    listBulletBox: { width: 24, alignItems: 'center' } as ViewStyle,
    bulletBase: { width: 7, height: 7, marginTop: 7 } as ViewStyle,
    bulletDisc: { borderRadius: 3.5, backgroundColor: c.textPrimary } as ViewStyle,
    bulletCircle: {
      borderRadius: 3.5,
      borderWidth: 1.2,
      borderColor: c.textPrimary,
    } as ViewStyle,
    bulletSquare: { backgroundColor: c.textPrimary } as ViewStyle,
    listItemContent: { flex: 1, minWidth: 0 } as ViewStyle,
    listNested: { marginLeft: 22 } as ViewStyle,
    textblockWrap: {} as ViewStyle,
    /* 结构性嵌套缩进（对齐 web textblock-nested-blocks 的 marginLeft），独立于 indent 字段 */
    textblockNested: { marginLeft: 20 } as ViewStyle,
    imageCaptionWrap: { marginTop: -2, marginBottom: 8 } as ViewStyle,
    tableScroll: { marginVertical: 8 } as ViewStyle,
    /* 网格边框：外层补 top+left，每个 cell 补 right+bottom，避免相邻边框叠加变粗 */
    tableWrap: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
      borderRadius: 4,
      overflow: 'hidden',
    } as ViewStyle,
    tableRow: { flexDirection: 'row', alignItems: 'stretch' } as ViewStyle,
    tableCell: {
      borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
      // web 是 10；这里收到 8 给文字多挤几 px，抵消 TextKit 比 WebKit 排得略松导致的提前换行
      paddingHorizontal: 8,
      paddingVertical: 6,
    } as ViewStyle,
    // web 表头不加底色、不强制加粗（.md-table-cell-header { font-weight: inherit }）→ 留空
    tableHeaderCell: {} as ViewStyle,
    image: {
      borderRadius: 6,
      marginVertical: 8,
      backgroundColor: c.surfaceMuted,
    } as ImageStyle,
    imageCropBox: {
      borderRadius: 6,
      marginVertical: 8,
      backgroundColor: c.surfaceMuted,
      overflow: 'hidden',
    } as ViewStyle,
    imageCropInner: { position: 'absolute' } as ImageStyle,
    imagePlaceholder: {
      borderRadius: 6,
      marginVertical: 8,
      backgroundColor: c.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
    } as ViewStyle,
    imagePlaceholderText: {
      color: c.textMuted,
      fontSize: 12,
    } as TextStyle,
    // 文件卡片对齐 web .assistant-attachment-card：1px 边框、圆角 10、muted 底。宽度由 caller 实测注入。
    fileCard: {
      flexDirection: 'row',
      alignItems: 'stretch',
      borderWidth: 1,
      borderColor: c.borderMuted,
      borderRadius: 10,
      backgroundColor: c.surfaceMuted,
      overflow: 'hidden',
      marginVertical: 4,
    } as ViewStyle,
    fileCardBody: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 12,
    } as ViewStyle,
    fileCardText: { flex: 1, minWidth: 0, gap: 2 } as ViewStyle,
    // 单行链接模式（display='inline'）：小图标 + 文件名链接，紧凑、内容宽、不撑满
    fileInline: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      maxWidth: '100%',
      gap: 4,
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: 4,
      marginVertical: 2,
    } as ViewStyle,
    fileInlineText: {
      // web --color-primary 在本主题是黑(#000)，不是蓝；用正文色 + 下划线
      color: c.textPrimary,
      textDecorationLine: 'underline',
      fontSize: 16,
      flexShrink: 1,
    } as TextStyle,
    fileCardDownload: {
      width: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderLeftWidth: 1,
      borderLeftColor: c.borderMuted,
    } as ViewStyle,
    fileAttachmentName: {
      fontSize: 13,
      color: c.textPrimary,
      fontWeight: '500',
    } as TextStyle,
    fileAttachmentSize: {
      fontSize: 11,
      color: c.textMuted,
    } as TextStyle,
    // 附件 preview 形态（display='preview'）
    previewImage: {
      borderRadius: 8,
      marginVertical: 8,
      backgroundColor: c.surfaceMuted,
    } as ImageStyle,
    previewVideo: {
      borderRadius: 8,
      marginVertical: 8,
      backgroundColor: '#000',
      overflow: 'hidden',
    } as ViewStyle,
    previewPdf: {
      borderRadius: 8,
      marginVertical: 8,
      backgroundColor: c.surfaceMuted,
    } as ViewStyle,
    // 不可预览类型（video/pdf/其它）的居中大卡片，对齐 web .flowdoc-attachment-preview-card
    previewFallbackCard: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 28,
      paddingHorizontal: 16,
      borderWidth: 1,
      borderColor: c.borderMuted,
      borderRadius: 10,
      backgroundColor: c.surfaceMuted,
      marginVertical: 8,
    } as ViewStyle,
    previewFallbackName: {
      fontSize: 14,
      color: c.textPrimary,
      fontWeight: '500',
      textAlign: 'center',
    } as TextStyle,
    previewFallbackMeta: {
      fontSize: 12,
      color: c.textMuted,
    } as TextStyle,
  });
}
