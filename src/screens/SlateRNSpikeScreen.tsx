/**
 * Slate-on-RN spike 屏：现已切换到 native FlowDocInput（NSTextAttachment / ReplacementSpan
 * 原子 pill 路线）。原 per-leaf TextInput 路线代码留在 src/flowdoc-editor-rn/ 中作为参考，
 * 不再激活。
 */
import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import {
  FlowDocSlateAdapter,
  FlowDocBlocks,
  documentToMarkdown,
  type FlowDocInputHandle,
  type SlateDocument,
  type FlowDocDocument,
  type FlowDocBlocksHandle,
  type FlowDocConvertibleBlockType,
} from '../flowdoc-native-input';
import type { Descendant } from 'slate';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

/* 多 paragraph 初始内容：3 段 —— pill 段 / marks 段 / 纯收尾段。回车在段内 → 新 paragraph。 */
const INITIAL_DOCUMENT: SlateDocument = [
  {
    type: 'paragraph',
    children: [
      { text: '这是第 1 段中间带 pill 的：' },
      {
        type: 'ref-pill',
        refKey: 'demo:1',
        mention: '@文档A (12-34)',
        title: '示例文档 A',
        isPointer: true,
        children: [{ text: '' }],
      } as unknown as Descendant,
      { text: ' —— 试着对 pill 用退格。' },
    ],
  },
  {
    type: 'paragraph',
    children: [
      { text: '第 2 段 Marks：' },
      { text: '加粗', bold: true } as unknown as Descendant,
      { text: ' / ' },
      { text: '斜体', italic: true } as unknown as Descendant,
      { text: ' / ' },
      { text: '加粗斜体', bold: true, italic: true } as unknown as Descendant,
      { text: ' / ' },
      { text: 'inline code', code: true } as unknown as Descendant,
      { text: ' / ' },
      { text: '红字', color: '#EF4444' } as unknown as Descendant,
    ],
  },
  {
    type: 'paragraph',
    children: [{ text: '第 3 段：随便打字试试 Enter 拆段、跨段选区、跨段退格合并。' }],
  },
];

/* FlowDocBlocks viewer 测试文档：覆盖所有 v1 支持的 block 类型 */
const VIEWER_DOCUMENT: FlowDocDocument = [
  { type: 'heading-two', children: [{ text: '示例 FlowDoc 文档' }] },
  {
    type: 'paragraph',
    children: [
      { text: '这是一个段落，里面带 ' },
      { text: '加粗', bold: true } as unknown as Descendant,
      { text: '、' },
      { text: '斜体', italic: true } as unknown as Descendant,
      { text: '、' },
      { text: '代码', code: true } as unknown as Descendant,
      { text: '、' },
      { text: '红字', color: '#EF4444' } as unknown as Descendant,
      { text: '，以及一个引用 ' },
      {
        type: 'ref-pill',
        refKey: 'demo:doc1',
        mention: '@飞流文档 A',
        title: '飞流文档 A',
        isPointer: true,
        children: [{ text: '' }],
      } as unknown as Descendant,
      { text: '。' },
    ],
  },
  { type: 'heading-three', children: [{ text: '一个小节标题' }] },
  {
    type: 'paragraph',
    children: [{ text: '小节内的正文，验证 heading 与 paragraph 之间的间距。' }],
  },
  {
    type: 'quote',
    children: [
      {
        type: 'paragraph',
        children: [{ text: '这是一段引用块，左竖线 + 内缩，可以嵌套其他 block。' }],
      } as unknown as Descendant,
    ],
  },
  {
    type: 'code',
    children: [{ text: 'function hello() {\n  return "world";\n}' }],
  },
  { type: 'divider', children: [{ text: '' }] },
  { type: 'heading-three', children: [{ text: '列表演示' }] },
  {
    type: 'bulletlistblock',
    children: [{ text: '第一个无序项' }],
  } as unknown as FlowDocDocument[number],
  {
    type: 'bulletlistblock',
    children: [
      { text: '第二项带' },
      { text: '加粗', bold: true } as unknown as Descendant,
      { text: '与' },
      {
        type: 'ref-pill',
        refKey: 'demo:list1',
        mention: '@嵌入式 pill',
        title: '嵌入式 pill',
        isPointer: true,
        children: [{ text: '' }],
      } as unknown as Descendant,
      // 嵌套子项（同级一个 bulletlistblock 当 children 里的 nested 块）
      {
        type: 'bulletlistblock',
        children: [{ text: '嵌套子项 a（depth=1，圆圈）' }],
      } as unknown as Descendant,
      {
        type: 'bulletlistblock',
        children: [
          { text: '嵌套子项 b' },
          {
            type: 'bulletlistblock',
            children: [{ text: '更深一层（depth=2，又实心）' }],
          } as unknown as Descendant,
        ],
      } as unknown as Descendant,
    ],
  } as unknown as FlowDocDocument[number],
  {
    type: 'bulletlistblock',
    children: [{ text: '第三个无序项（顶层）' }],
  } as unknown as FlowDocDocument[number],
  {
    type: 'numberedlistblock',
    order_in_list: 1,
    children: [{ text: '编号项 1（顶层 → decimal）' }],
  } as unknown as FlowDocDocument[number],
  {
    type: 'numberedlistblock',
    order_in_list: 2,
    children: [
      { text: '编号项 2，嵌套子项走 lower-alpha：' },
      {
        type: 'numberedlistblock',
        order_in_list: 1,
        children: [{ text: '子 a' }],
      } as unknown as Descendant,
      {
        type: 'numberedlistblock',
        order_in_list: 2,
        children: [
          { text: '子 b，更深一层走 lower-roman：' },
          {
            type: 'numberedlistblock',
            order_in_list: 1,
            children: [{ text: '孙 i' }],
          } as unknown as Descendant,
          {
            type: 'numberedlistblock',
            order_in_list: 2,
            children: [{ text: '孙 ii' }],
          } as unknown as Descendant,
        ],
      } as unknown as Descendant,
    ],
  } as unknown as FlowDocDocument[number],
  {
    type: 'numberedlistblock',
    order_in_list: 3,
    children: [{ text: '编号项 3' }],
  } as unknown as FlowDocDocument[number],
  {
    type: 'paragraph',
    children: [{ text: '分割线之后是收尾段。' }],
  },
  { type: 'heading-three', children: [{ text: '图片 / 附件演示' }] },
  {
    type: 'image',
    url: 'https://picsum.photos/640/360',
    alt: '随机示例图',
    width: 640,
    height: 360,
    children: [{ text: '' }],
  } as unknown as FlowDocDocument[number],
  {
    type: 'file_attachment',
    url: 'https://example.com/demo.pdf',
    filename: '示例附件.pdf',
    size: 524288,
    children: [{ text: '' }],
  } as unknown as FlowDocDocument[number],
  {
    type: 'file_attachment',
    filename: '没有 url 的附件示意.zip',
    size: 12 * 1024 * 1024,
    children: [{ text: '' }],
  } as unknown as FlowDocDocument[number],
];

export function SlateRNSpikeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = createStyles(colors);
  const editorRef = useRef<FlowDocInputHandle | null>(null);
  const blocksRef = useRef<FlowDocBlocksHandle | null>(null);
  const [pillCount, setPillCount] = useState(0);
  const [lastJsonPreview, setLastJsonPreview] = useState<string>('(尚未改动)');
  /* FlowDocBlocks viewer/editor 切换 + 当前 doc 状态 */
  const [viewerEditable, setViewerEditable] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<FlowDocDocument>(VIEWER_DOCUMENT);
  /* 底部工具栏当前操作目标：'top'=独立 FlowDocInput（adapter），'blocks'=FlowDocBlocks focused block */
  const toolbarTarget: 'top' | 'blocks' = viewerEditable ? 'blocks' : 'top';
  const applyMarkOnCurrent = (mark: 'bold' | 'italic' | 'code' | 'color', value?: string) => {
    if (toolbarTarget === 'blocks') blocksRef.current?.applyMark(mark, value);
    else editorRef.current?.applyMark(mark, value);
  };

  const handleInsertPill = () => {
    const n = pillCount + 1;
    setPillCount(n);
    editorRef.current?.insertPill(
      `demo:dynamic:${n}`,
      `@动态 pill ${n}`,
      `动态 ${n}`,
      true,
    );
  };

  const handleRemoveLastPill = () => {
    if (pillCount <= 0) return;
    editorRef.current?.removePill(`demo:dynamic:${pillCount}`);
    setPillCount(pillCount - 1);
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={26} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.title}>FlowDoc Native Input (spike)</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.label}>原生 FlowDocInput（atomic pill）</Text>
        <View style={styles.inputContainer}>
          <FlowDocSlateAdapter
            ref={editorRef}
            initialDocument={INITIAL_DOCUMENT}
            textColor={colors.textPrimary}
            pillBackgroundColor={colors.surfaceMuted}
            pillTextColor={colors.textMuted}
            fontSize={16}
            placeholder="输入文字…可以中间插入 pill"
            placeholderColor={colors.placeholder}
            style={styles.input}
            onChange={(doc) => {
              setLastJsonPreview(JSON.stringify(doc, null, 2));
            }}
          />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 18 }}>
          <Text style={[styles.label, { marginTop: 0, flex: 1 }]}>
            FlowDocBlocks（{viewerEditable ? 'edit' : 'read-only'}）
          </Text>
          <TouchableOpacity
            style={[styles.toggleBtn, { marginRight: 6 }]}
            onPress={() => setLastJsonPreview(`markdown:\n${documentToMarkdown(viewerDoc)}`)}
          >
            <Text style={styles.toggleBtnText}>→md</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.toggleBtn}
            onPress={() => setViewerEditable((v) => !v)}
          >
            <Text style={styles.toggleBtnText}>
              {viewerEditable ? '切到 read-only' : '切到 edit'}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.viewerContainer}>
          <FlowDocBlocks
            ref={blocksRef}
            document={viewerDoc}
            editable={viewerEditable}
            onChange={(next) => {
              setViewerDoc(next);
              setLastJsonPreview(`onChange doc:\n${JSON.stringify(next, null, 2)}`);
            }}
            onPillPress={(refKey) => {
              setLastJsonPreview(`pill clicked: ${refKey}`);
            }}
          />
        </View>

        {/* debug JSON 放最后；上面任何操作都不会撑动文档区滚动位置 */}
        <View style={[styles.debugBox, { marginTop: 18 }]}>
          <Text style={styles.debugLabel}>Slate children（最近一次 onChange）:</Text>
          <Text style={styles.debugJson} selectable>
            {lastJsonPreview}
          </Text>
        </View>
      </ScrollView>

      <View style={styles.bottomBar}>
        <TouchableOpacity style={styles.btn} onPress={handleInsertPill}>
          <Text style={styles.btnText}>+pill</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={handleRemoveLastPill}>
          <Text style={styles.btnText}>-pill</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => applyMarkOnCurrent('bold')}
        >
          <Text style={[styles.btnText, { fontWeight: '700' }]}>B</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => applyMarkOnCurrent('italic')}
        >
          <Text style={[styles.btnText, { fontStyle: 'italic' }]}>I</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => applyMarkOnCurrent('code')}
        >
          <Text style={[styles.btnText, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{'</>'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => applyMarkOnCurrent('color', '#EF4444')}
        >
          <Text style={[styles.btnText, { color: '#EF4444' }]}>红</Text>
        </TouchableOpacity>
      </View>
      {viewerEditable ? (
        <View style={styles.bottomBar}>
          {(['paragraph', 'heading-two', 'heading-three', 'quote', 'code', 'bulletlistblock', 'numberedlistblock'] as FlowDocConvertibleBlockType[]).map((t) => (
            <TouchableOpacity
              key={t}
              style={styles.btn}
              onPress={() => blocksRef.current?.changeBlockType(t)}
            >
              <Text style={styles.btnText}>{
                t === 'paragraph' ? 'P'
                  : t === 'heading-two' ? 'H2'
                  : t === 'heading-three' ? 'H3'
                  : t === 'quote' ? '"'
                  : t === 'code' ? 'Code'
                  : t === 'bulletlistblock' ? '•'
                  : '1.'
              }</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.btn}
            onPress={() => blocksRef.current?.insertBlockAfter('paragraph')}
          >
            <Text style={styles.btnText}>+blk</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingBottom: 8,
      paddingHorizontal: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderMuted,
    },
    backBtn: { padding: 6 },
    title: {
      fontSize: 17,
      fontWeight: '600',
      color: c.textPrimary,
      marginLeft: 4,
    },
    scroll: { flex: 1 },
    scrollContent: { paddingBottom: 24, paddingHorizontal: 12 },
    label: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 12,
      marginBottom: 6,
    },
    inputContainer: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
      borderRadius: 8,
      padding: 10,
      minHeight: 120,
    },
    input: { minHeight: 100 },
    viewerContainer: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
      borderRadius: 8,
      padding: 12,
    },
    toggleBtn: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 4,
      backgroundColor: c.surfaceMuted,
    },
    toggleBtnText: {
      fontSize: 11,
      color: c.textPrimary,
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
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      color: c.textPrimary,
    },
    bottomBar: {
      flexDirection: 'row',
      gap: 10,
      padding: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderMuted,
    },
    btn: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.surfaceMuted,
      alignItems: 'center',
    },
    btnText: {
      fontSize: 13,
      color: c.textPrimary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
  });
}
