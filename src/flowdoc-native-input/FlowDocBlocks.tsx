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
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import {
  Image,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
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
};

type ParagraphBlock = SlateBlockBase<'paragraph'>;
type HeadingBlock = SlateBlockBase<
  'heading-one' | 'heading-two' | 'heading-three' | 'heading-four' | 'heading-five' | 'heading-six'
>;
type CodeBlock = SlateBlockBase<'code'>;
type QuoteBlock = SlateBlockBase<'quote'>;
type DividerBlock = { type: 'divider'; children: [{ text: '' }] };
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
  width?: number;
  height?: number;
  children: [{ text: '' }];
};

/** 文件附件 void block：url 可点击打开 */
type FileAttachmentBlock = {
  type: 'file_attachment';
  url?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
  children: [{ text: '' }];
};

export type FlowDocBlock =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | QuoteBlock
  | DividerBlock
  | ListBlock
  | ImageBlock
  | FileAttachmentBlock;

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

export const FlowDocBlocks = forwardRef<FlowDocBlocksHandle, FlowDocBlocksProps>(
  function FlowDocBlocks(
    { document, editable = false, onChange, onPillPress, style },
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

  return (
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
    </View>
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
    if (cn.type === 'ref-pill') {
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

  switch (block.type) {
    case 'bulletlistblock':
    case 'numberedlistblock':
      return <ListBlockRenderer ctx={ctx} block={block as ListBlock} />;
    case 'paragraph':
      return (
        <View style={ctx.styles.paragraphWrap}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children)}
            fontSize={16}
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
      const size = HEADING_FONT_SIZES[level];
      const tight = level <= 2;
      return (
        <View style={tight ? ctx.styles.headingWrapTight : ctx.styles.headingWrap}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(block.children, { headingForceBold: true })}
            fontSize={size}
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
            fontSize={13}
            fontFamily={Platform.OS === 'ios' ? 'Menlo' : 'monospace'}
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
    case 'file_attachment':
      return <FileAttachmentRenderer ctx={ctx} block={block as FileAttachmentBlock} />;
    default:
      return null;
  }
}

/** image void block：按内置宽高 / 默认 16:9 比例显示；点击可在外部浏览器打开原图 */
function ImageBlockRenderer({ ctx, block }: { ctx: RendererCtx; block: ImageBlock }) {
  const url = (block.url ?? '').trim();
  const { width: winW } = useWindowDimensions();
  // 容器宽度兜底（spike 屏内大约 winW - 36 左右；用 winW 减保守 margin）
  const containerW = Math.max(120, winW - 48);
  const aspect = block.width && block.height && block.width > 0 && block.height > 0
    ? block.width / block.height
    : 16 / 9;
  const h = containerW / aspect;
  if (!url) {
    return (
      <View style={[ctx.styles.imagePlaceholder, { height: 80 }]}>
        <Text style={ctx.styles.imagePlaceholderText}>（图片缺 url）</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => Linking.openURL(url).catch(() => {})}
    >
      <Image
        source={{ uri: url }}
        style={{
          width: containerW,
          height: h,
          borderRadius: 6,
          marginVertical: 8,
          backgroundColor: ctx.colors.surfaceMuted,
        }}
        resizeMode="cover"
        accessible
        accessibilityLabel={block.alt}
      />
    </TouchableOpacity>
  );
}

/** file_attachment：一个 chip 行，📎 + filename（+ size）；点击打开 url（如有） */
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
  const onPress = url ? () => Linking.openURL(url).catch(() => {}) : undefined;
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper
      style={ctx.styles.fileAttachmentChip}
      onPress={onPress}
      activeOpacity={0.7}
      accessible
      accessibilityLabel={`附件 ${name}`}
    >
      <Text style={ctx.styles.fileAttachmentIcon}>📎</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={ctx.styles.fileAttachmentName} numberOfLines={1} ellipsizeMode="middle">
          {name}
        </Text>
        {sizeLabel ? (
          <Text style={ctx.styles.fileAttachmentSize}>{sizeLabel}</Text>
        ) : null}
      </View>
    </Wrapper>
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
  return (
    <View style={ctx.styles.listItemWrap}>
      <View style={ctx.styles.listItemRow}>
        <Text style={ctx.styles.listItemMarker} selectable={false}>
          {marker}
        </Text>
        <View style={ctx.styles.listItemContent}>
          <TextBlockInput
            ctx={ctx}
            content={inlineToContent(inline)}
            fontSize={16}
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
    return ['●', '○', '●', '○'][depth % 4];
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
  onContentChange,
  onSplitRequest,
  onMergeBackwardRequest,
  enterCreatesBlock = true,
}: {
  ctx: RendererCtx;
  content: FlowDocContent;
  fontSize: number;
  fontFamily?: string;
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
      textColor={ctx.colors.textPrimary}
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

const HEADING_FONT_SIZES: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 26,
  2: 22,
  3: 20,
  4: 18,
  5: 16,
  6: 14,
};

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
    t === 'file_attachment'
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
    if (part.type === 'pill') {
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
    const leaf: Record<string, unknown> = { text: p.text };
    if (p.marks?.bold) leaf.bold = true;
    if (p.marks?.italic) leaf.italic = true;
    if (p.marks?.code) leaf.code = true;
    if (p.marks?.color) leaf.color = p.marks.color;
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
    const leaf = node as SlateMarkedText;
    if (typeof leaf.text !== 'string' || leaf.text.length === 0) continue;
    const marks: NonNullable<Extract<FlowDocContentPart, { type: 'text' }>['marks']> = {};
    if (leaf.bold || opts.headingForceBold) marks.bold = true;
    if (leaf.italic) marks.italic = true;
    if (leaf.code) marks.code = true;
    if (typeof leaf.color === 'string' && leaf.color) marks.color = leaf.color;
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
    paragraphWrap: { marginVertical: 4 } as ViewStyle,
    headingWrap: { marginTop: 14, marginBottom: 6 } as ViewStyle,
    headingWrapTight: { marginTop: 18, marginBottom: 8 } as ViewStyle,
    codeBlockWrap: {
      backgroundColor: c.surfaceMuted,
      padding: 10,
      borderRadius: 6,
      marginVertical: 8,
    } as ViewStyle,
    quoteWrap: {
      borderLeftWidth: 3,
      borderLeftColor: c.borderMuted,
      paddingLeft: 12,
      marginVertical: 8,
    } as ViewStyle,
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.borderMuted,
      marginVertical: 12,
    } as ViewStyle,
    listItemWrap: { marginVertical: 2 } as ViewStyle,
    listItemRow: { flexDirection: 'row', alignItems: 'flex-start' } as ViewStyle,
    listItemMarker: {
      width: 22,
      paddingTop: 2,
      fontSize: 14,
      lineHeight: 22,
      color: c.textMuted,
      textAlign: 'center',
    } as TextStyle,
    listItemContent: { flex: 1, minWidth: 0 } as ViewStyle,
    listNested: { marginLeft: 22 } as ViewStyle,
    image: {
      borderRadius: 6,
      marginVertical: 8,
      backgroundColor: c.surfaceMuted,
    } as ViewStyle,
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
    fileAttachmentChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      backgroundColor: c.surfaceMuted,
      borderRadius: 8,
      marginVertical: 6,
    } as ViewStyle,
    fileAttachmentIcon: {
      fontSize: 20,
    } as TextStyle,
    fileAttachmentName: {
      fontSize: 14,
      color: c.textPrimary,
      fontWeight: '500',
    } as TextStyle,
    fileAttachmentSize: {
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    } as TextStyle,
  });
}
