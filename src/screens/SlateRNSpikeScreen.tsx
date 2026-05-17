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
  type FlowDocInputHandle,
  type SlateDocument,
  type FlowDocDocument,
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
  {
    type: 'paragraph',
    children: [{ text: '分割线之后是收尾段。' }],
  },
];

export function SlateRNSpikeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = createStyles(colors);
  const editorRef = useRef<FlowDocInputHandle | null>(null);
  const [pillCount, setPillCount] = useState(0);
  const [lastJsonPreview, setLastJsonPreview] = useState<string>('(尚未改动)');

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

        <View style={styles.debugBox}>
          <Text style={styles.debugLabel}>Slate children（最近一次 onChange）:</Text>
          <Text style={styles.debugJson} selectable>
            {lastJsonPreview}
          </Text>
        </View>

        <Text style={[styles.label, { marginTop: 18 }]}>FlowDocBlocks（read-only 文档渲染）</Text>
        <View style={styles.viewerContainer}>
          <FlowDocBlocks
            document={VIEWER_DOCUMENT}
            onPillPress={(refKey) => {
              setLastJsonPreview(`pill clicked: ${refKey}`);
            }}
          />
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
          onPress={() => editorRef.current?.applyMark('bold')}
        >
          <Text style={[styles.btnText, { fontWeight: '700' }]}>B</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => editorRef.current?.applyMark('italic')}
        >
          <Text style={[styles.btnText, { fontStyle: 'italic' }]}>I</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => editorRef.current?.applyMark('code')}
        >
          <Text style={[styles.btnText, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{'</>'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => editorRef.current?.applyMark('color', '#EF4444')}
        >
          <Text style={[styles.btnText, { color: '#EF4444' }]}>红</Text>
        </TouchableOpacity>
      </View>
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
