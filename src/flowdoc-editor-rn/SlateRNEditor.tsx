/**
 * Slate-on-RN spike：per-leaf TextInput 路线
 *
 * 设计要点：
 * - `slate` core + `slate-history` 全部 pure JS，直接装在 mobile 上，editor 状态用我们自己 force-render；
 *   不依赖 slate-react / slate-dom，因为这俩要 DOM。
 * - 每个 block（paragraph / heading-two / code）渲染成一个 RN <View>，子节点用 flex-wrap row。
 * - 每个 text leaf 渲染成一个 <TextInput>；inline atom（ref-pill）渲染成只读的 <View> 行内块。
 * - TextInput 走 controlled 模式：value = leaf.text；onChangeText 反向算 diff，转成 Slate transforms。
 *   会算 longest common prefix + suffix，保证 IME 中途替换也能落地。
 * - 选区桥：TextInput 的 onSelectionChange 把光标 offset 映射回 Slate editor.selection；
 *   退格时（selection={0,0}）若前一个兄弟是 pill，则直接删 pill。
 * - 编程式 insertRefPill(refData)：在当前 selection 处 split 当前 leaf，插入 pill 节点，
 *   再尝试把焦点移到 pill 后那一段。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  type TextInputKeyPressEventData,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import {
  Editor as SlateEditor,
  Element as SlateElement,
  Node,
  Path,
  Range,
  Text as SlateText,
  Transforms,
  type Descendant,
  type Editor as SlateEditorType,
} from 'slate';
import { createEditor } from './createEditor';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import type { RefPillElement } from './types';
// 跨平台代码复用 PoC：原封不动从 FlopsWeb flowdoc-editor-core 拷贝过来的工具，
// 零修改即可在 mobile 上跑（依赖只有 slate core）。
import { isValidSelection } from './shared/selectionUtils';

export type SlateRNEditorHandle = {
  insertRefPill: (refData: {
    refKey: string;
    mention: string;
    title?: string;
    isPointer?: boolean;
  }) => void;
  getValue: () => Descendant[];
  focus: () => void;
};

type Props = {
  initialValue: Descendant[];
  onChange?: (value: Descendant[]) => void;
  /** spike 调试用：在编辑器下方显示 Slate document JSON */
  debug?: boolean;
};

/* 算最简单 diff：保留公共前后缀，中间段替换 */
function diffText(
  oldText: string,
  newText: string,
): { start: number; deleteLen: number; insert: string } {
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText[oldEnd - 1] === newText[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return { start, deleteLen: oldEnd - start, insert: newText.slice(start, newEnd) };
}

function leafFocusKey(path: number[]): string {
  return path.join('.');
}

/* 把 leaf 上的 marks（bold/italic/code/color）翻译成 RN TextStyle。
   inline code 给它一个浅灰底 + 等宽字 + 微缩字号，跟 FlopsWeb Leaf.jsx 一致 */
function buildLeafMarkStyle(
  leaf: { bold?: boolean; italic?: boolean; code?: boolean; color?: string },
  c: AppColors,
): import('react-native').TextStyle {
  const style: import('react-native').TextStyle = {};
  if (leaf.bold) style.fontWeight = '700';
  if (leaf.italic) style.fontStyle = 'italic';
  if (leaf.code) {
    style.fontFamily = 'Menlo';
    style.backgroundColor = c.surfaceMuted;
    // 行内 code 微缩一档，避免和正文 16/22 撑爆行高
    style.fontSize = 14;
  }
  if (typeof leaf.color === 'string' && leaf.color) {
    style.color = leaf.color;
  }
  return style;
}

export const SlateRNEditor = forwardRef(
  ({ initialValue, onChange, debug = false }: Props, ref: React.ForwardedRef<SlateRNEditorHandle>) => {
    const { colors } = useAppTheme();
    const styles = useMemo(() => createStyles(colors), [colors]);

    // 创建 editor；initialValue 只在挂载时使用，之后由 editor.children 持有
    const editor = useMemo(() => {
      const ed = createEditor();
      ed.children = initialValue.length > 0 ? initialValue : [
        { type: 'paragraph', children: [{ text: '' }] } as Descendant,
      ];
      return ed;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [tick, forceRender] = useReducer((x: number) => x + 1, 0);
    /* 「结构性」突变计数器：删 pill / split / merge 这类导致 leaf 数量变化的操作 +1，
       用来作为 block React-key 的一部分，强制下层 TextInput 整组 remount。
       这是 iOS RN controlled multiline TextInput 的已知问题——value prop 跳变时
       native UITextView 的 text storage 不一定 sync，必须 remount 强同步。
       普通字符输入不动这个计数器，避免每打一个字就毁掉焦点 / IME 状态。 */
    const [structuralGen, setStructuralGen] = useState(0);

    /* TextInput ref 仓库，编程式聚焦用 */
    const textInputRefs = useRef<Map<string, TextInput | null>>(new Map());

    /* 结构性突变后需要把焦点 + 光标摆回去（remount 会让原焦点丢）。
       记 path 是因为 leaf 在 Slate 那侧重新合并 / split 之后路径变了；
       记 offset 是因为视觉上要回到 merge / split 发生的"接缝处" */
    const pendingFocusRef = useRef<{ path: number[]; offset: number } | null>(null);

    /* 最近一次 onSelectionChange 的 (path, start, end) —— 编程式插入 pill / 切 leaf 时定位光标 */
    const lastSelectionRef = useRef<{
      path: number[];
      start: number;
      end: number;
    } | null>(null);

    /* 结构性 remount 后要把焦点 + 光标摆回 merge 接缝处。
       不用 setTimeout 等异步——而是把 pendingFocus 翻译成 controlled `selection` prop，
       传给目标 leaf 的新 TextInput。新 TextInput 一挂载就以这个 selection 初始化，
       绕过 iOS focus() 把光标默认拽到末尾的行为；用户首次操作（onSelectionChange）
       触发就释放 controlled selection，回归 TextInput 自管模式（避免影响 IME / 后续光标）。

       focus() 走 ref callback 在元素真正挂载那一刻调用，不靠 timer。 */
    const [pendingSelection, setPendingSelection] = useState<{
      key: string;
      selection: { start: number; end: number };
    } | null>(null);
    useEffect(() => {
      const pending = pendingFocusRef.current;
      if (!pending) return;
      pendingFocusRef.current = null;
      setPendingSelection({
        key: leafFocusKey(pending.path),
        selection: { start: pending.offset, end: pending.offset },
      });
    }, [structuralGen]);

    /* 把 editor 操作包一层：跑完后通知外部 + 重新渲染 */
    const apply = useCallback(
      (fn: () => void) => {
        fn();
        onChange?.(editor.children as Descendant[]);
        forceRender();
      },
      [editor, onChange],
    );

    /* —— 文本 leaf 的输入处理 —— */

    const handleLeafChange = useCallback(
      (path: number[], newText: string) => {
        const oldNode = Node.get(editor, path);
        const oldText = SlateEditor.string(editor, path) || (oldNode as { text?: string }).text || '';
        if (oldText === newText) return;
        const d = diffText(oldText, newText);
        apply(() => {
          SlateEditor.withoutNormalizing(editor, () => {
            if (d.deleteLen > 0) {
              Transforms.delete(editor, {
                at: {
                  anchor: { path, offset: d.start },
                  focus: { path, offset: d.start + d.deleteLen },
                },
              });
            }
            if (d.insert.length > 0) {
              Transforms.insertText(editor, d.insert, {
                at: { path, offset: d.start },
              });
            }
          });
        });
      },
      [editor, apply],
    );

    const handleLeafSelectionChange = useCallback(
      (path: number[]) =>
        (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
          const { start, end } = e.nativeEvent.selection;
          lastSelectionRef.current = { path, start, end };
          // 同步到 Slate editor.selection（光标在 leaf path 上的 start/end offset）
          try {
            Transforms.select(editor, {
              anchor: { path, offset: start },
              focus: { path, offset: end },
            });
            // PoC：直接调用从 FlopsWeb 拷过来的 selectionUtils，验证跨端逻辑无需改动
            if (__DEV__ && editor.selection && isValidSelection(editor.selection)) {
              /* selection 非折叠时这里能拿到 true，证明 web 的工具函数在 mobile 跑通 */
            }
          } catch {
            /* 路径过期等容错，下次渲染会自愈 */
          }
        },
      [editor],
    );

    const handleLeafKeyPress = useCallback(
      (path: number[]) =>
        (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
          if (e.nativeEvent.key !== 'Backspace') return;
          const sel = lastSelectionRef.current;
          if (!sel || sel.start !== 0 || sel.end !== 0) return;
          // 当前 leaf 起始位置按退格：尝试删前一个兄弟（若是 pill 就整块删）
          const parentPath = Path.parent(path);
          const idx = path[path.length - 1];
          if (idx <= 0) return;
          const prevPath = [...parentPath, idx - 1];
          let prevNode: Node;
          try {
            prevNode = Node.get(editor, prevPath);
          } catch {
            return;
          }
          if (SlateElement.isElement(prevNode) && prevNode.type === 'ref-pill') {
            // 删 pill 后，pill 两侧的 text leaf 会被 Slate 自动 merge 成一段，
            // merge 接缝就是「合并后 cursor 落点」——也就是 pill 前一个 leaf 原文本的长度
            let cursorOffset = 0;
            let mergedLeafPath: number[] = [...parentPath, 0];
            if (idx >= 2) {
              const prevSiblingPath = [...parentPath, idx - 2];
              try {
                const prevSibling = Node.get(editor, prevSiblingPath);
                if (SlateText.isText(prevSibling)) {
                  cursorOffset = prevSibling.text.length;
                  mergedLeafPath = prevSiblingPath;
                }
              } catch {
                /* 前节点不存在或不是文本，留默认值 [..,0] / offset 0 */
              }
            }
            apply(() => {
              Transforms.removeNodes(editor, { at: prevPath });
            });
            pendingFocusRef.current = { path: mergedLeafPath, offset: cursorOffset };
            // 结构性突变（删 pill 触发的 leaf 合并）：强制下游 TextInput 整组 remount，
            // 解决 iOS multiline controlled TextInput 不响应 value prop 跳变的问题
            setStructuralGen((g) => g + 1);
          }
        },
      [editor, apply],
    );

    /* —— 暴露给外部的 imperative API —— */

    useImperativeHandle(
      ref,
      () => ({
        insertRefPill: (refData) => {
          const pill: RefPillElement = {
            type: 'ref-pill',
            refKey: refData.refKey,
            mention: refData.mention,
            title: refData.title,
            isPointer: refData.isPointer,
            children: [{ text: '' }],
          };
          apply(() => {
            // 若编辑器没有 selection，就把 pill 插到末尾段落尾部
            if (!editor.selection) {
              const end = SlateEditor.end(editor, []);
              Transforms.select(editor, end);
            } else if (Range.isExpanded(editor.selection)) {
              Transforms.collapse(editor, { edge: 'end' });
            }
            Transforms.insertNodes(editor, [pill, { text: ' ' }]);
            Transforms.move(editor);
          });
          // 插 pill 会 split 当前 text leaf：结构性变化，整块 remount 让 TextInput 重读
          setStructuralGen((g) => g + 1);
          // 插入后，下一次 render 才会有新的 TextInput；这里先把焦点意图记下来，
          // 让 mount 时的 leaf 自动 focus
          // （TODO：spike 阶段暂不做精准聚焦，先看视觉是否对）
        },
        getValue: () => editor.children as Descendant[],
        focus: () => {
          // 找第一个 TextInput 聚焦
          const first = textInputRefs.current.values().next().value;
          first?.focus();
        },
      }),
      [editor, apply],
    );

    /* —— 渲染 —— */

    const renderBlock = (block: Descendant, blockIdx: number) => {
      const path = [blockIdx];
      if (!SlateElement.isElement(block)) return null;
      // 顶层只接受 block 节点；ref-pill（inline）正确情况下不该出现在顶层，但容错跳过
      if (block.type !== 'paragraph' && block.type !== 'heading-two' && block.type !== 'code') {
        return null;
      }
      const blockType = block.type;
      const blockStyle =
        blockType === 'heading-two'
          ? [styles.blockBase, styles.headingTwo]
          : blockType === 'code'
            ? [styles.blockBase, styles.codeBlock]
            : [styles.blockBase];
      return (
        <View key={`${blockIdx}-${structuralGen}`} style={blockStyle}>
          <View style={styles.inlineRow}>
            {(block.children as Descendant[]).map((child, ci) =>
              renderInline(child, [...path, ci], blockType),
            )}
          </View>
        </View>
      );
    };

    const renderInline = (
      node: Descendant,
      path: number[],
      blockType: 'paragraph' | 'heading-two' | 'code',
    ) => {
      if (SlateElement.isElement(node)) {
        if (node.type === 'ref-pill') {
          return <RefPillView key={leafFocusKey(path)} node={node} />;
        }
        return null;
      }
      const leaf = node as {
        text: string;
        bold?: boolean;
        italic?: boolean;
        code?: boolean;
        color?: string;
      };
      const fkey = leafFocusKey(path);
      const isPendingTarget = pendingSelection?.key === fkey;
      const onSelChange = handleLeafSelectionChange(path);
      const markStyle = buildLeafMarkStyle(leaf, colors);
      return (
        <TextInput
          key={fkey}
          ref={(el) => {
            if (!el) {
              textInputRefs.current.delete(fkey);
              return;
            }
            const wasRegistered = textInputRefs.current.get(fkey) === el;
            textInputRefs.current.set(fkey, el);
            // 元素挂载这一刻同步 focus；只在首次 ref 注册时触发，避免每次 re-render 重 focus
            if (isPendingTarget && !wasRegistered) {
              el.focus();
            }
          }}
          value={leaf.text}
          /* 仅在 pending 命中本 leaf 时受控；用户首次 onSelectionChange 触发后立刻释放 */
          selection={isPendingTarget ? pendingSelection.selection : undefined}
          onChangeText={(t) => handleLeafChange(path, t)}
          onSelectionChange={(e) => {
            if (isPendingTarget) setPendingSelection(null);
            onSelChange(e);
          }}
          onKeyPress={handleLeafKeyPress(path)}
          multiline
          style={[
            styles.leaf,
            blockType === 'heading-two' && styles.leafHeadingTwo,
            blockType === 'code' && styles.leafCode,
            // marks 叠在 block 样式之后，让 leaf 级的 bold/italic/code/color 能覆盖 block 默认
            markStyle,
          ]}
          // RN 默认会把多行 TextInput 显示成一个独立的盒子；我们要它流式排列，所以
          // 给一个最小宽度避免空 leaf 占 0 宽（pill 删除后会留下空 leaf）
          placeholder=""
          underlineColorAndroid="transparent"
          scrollEnabled={false}
        />
      );
    };

    return (
      <View style={styles.root}>
        {(editor.children as Descendant[]).map(renderBlock)}
        {debug ? (
          <View style={styles.debugBox}>
            <Text style={styles.debugLabel}>editor.children (tick {tick}):</Text>
            <Text style={styles.debugJson} selectable>
              {JSON.stringify(editor.children, null, 2)}
            </Text>
          </View>
        ) : null}
      </View>
    );
  },
);
SlateRNEditor.displayName = 'SlateRNEditor';

/** ref-pill 只读小块：圆角灰底 + 文本 */
function RefPillView({ node }: { node: RefPillElement }) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const label = (node.mention || node.title || '').replace(/^@/, '');
  return (
    <View style={styles.refPill}>
      <Text style={styles.refPillIcon}>📄</Text>
      <Text style={styles.refPillText}>{label}</Text>
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: {
      padding: 12,
    },
    blockBase: {
      marginVertical: 4,
    },
    inlineRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
    },
    headingTwo: {
      // 体现 heading-two 块级语义；leaf 自己负责字号
    },
    codeBlock: {
      backgroundColor: c.surfaceMuted,
      borderRadius: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    leaf: {
      fontSize: 16,
      lineHeight: 22,
      color: c.textPrimary,
      padding: 0,
      margin: 0,
      minWidth: 4,
    },
    leafHeadingTwo: {
      fontSize: 22,
      lineHeight: 30,
      fontWeight: '700',
    },
    leafCode: {
      fontFamily: 'Menlo',
      fontSize: 14,
      lineHeight: 20,
    },
    refPill: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surfaceMuted,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
      marginHorizontal: 2,
    },
    refPillIcon: {
      fontSize: 12,
      marginRight: 4,
    },
    refPillText: {
      fontSize: 13,
      color: c.textMuted,
    },
    debugBox: {
      marginTop: 16,
      padding: 8,
      borderRadius: 6,
      backgroundColor: c.surfaceMuted,
    },
    debugLabel: {
      fontSize: 11,
      color: c.textMuted,
      marginBottom: 4,
    },
    debugJson: {
      fontSize: 10,
      fontFamily: 'Menlo',
      color: c.textPrimary,
    },
  });
}
