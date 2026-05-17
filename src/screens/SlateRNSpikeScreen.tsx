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
  type FlowDocInputHandle,
} from '../flowdoc-native-input';
import type { Descendant } from 'slate';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

/* 初始 Slate paragraph 内容：一段普通文字 + 1 个 ref-pill + 一段后续文字 + marks 演示 */
const INITIAL_CHILDREN: Descendant[] = [
  { text: '这是一段中间带 pill 的：' },
  {
    type: 'ref-pill',
    refKey: 'demo:1',
    mention: '@文档A (12-34)',
    title: '示例文档 A',
    isPointer: true,
    children: [{ text: '' }],
  } as unknown as Descendant,
  { text: ' —— 试着对 pill 用退格。Marks：' },
  { text: '加粗', bold: true } as unknown as Descendant,
  { text: ' / ' },
  { text: '斜体', italic: true } as unknown as Descendant,
  { text: ' / ' },
  { text: '加粗斜体', bold: true, italic: true } as unknown as Descendant,
  { text: ' / ' },
  { text: 'inline code', code: true } as unknown as Descendant,
  { text: ' / ' },
  { text: '红字', color: '#EF4444' } as unknown as Descendant,
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
            initialChildren={INITIAL_CHILDREN}
            textColor={colors.textPrimary}
            pillBackgroundColor={colors.surfaceMuted}
            pillTextColor={colors.textMuted}
            fontSize={16}
            placeholder="输入文字…可以中间插入 pill"
            placeholderColor={colors.placeholder}
            style={styles.input}
            onChange={(children) => {
              setLastJsonPreview(JSON.stringify(children, null, 2));
            }}
          />
        </View>

        <View style={styles.debugBox}>
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
