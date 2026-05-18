/**
 * DocViewerScreen
 *
 * 拉 FlowDoc 文档的 Y.Doc 二进制快照，解码成 FlowDocDocument，喂给 FlowDocBlocks
 * 以只读模式展示。失败 / 404 / 空文档都给一个合理 fallback。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { getFlowDocSnapshot } from '../api';
import {
  FlowDocBlocks,
  type FlowDocDocument,
} from '../flowdoc-native-input';
import { decodeFlowDocSnapshotToDocument } from '../flowdoc-native-input/yjsToDocument';
import type { DocsStackParamList } from '../navigation/types';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

type Nav = StackNavigationProp<DocsStackParamList, 'DocViewer'>;
type Route = RouteProp<DocsStackParamList, 'DocViewer'>;

const EMPTY_DOC: FlowDocDocument = [
  { type: 'paragraph', children: [{ text: '' }] },
];

export function DocViewerScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const insets = useSafeAreaInsets();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const docId = route.params?.docId || '';
  const docName = route.params?.docName?.trim() || '未命名文档';

  const [doc, setDoc] = useState<FlowDocDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session || !docId) {
      setError('缺少 docId 或登录状态');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const bytes = await getFlowDocSnapshot(session, docId);
      if (bytes == null) {
        // 文档存在但还没保存过快照 —— 给空文档
        setDoc(EMPTY_DOC);
      } else {
        const decoded = decodeFlowDocSnapshotToDocument(bytes);
        setDoc(decoded.length > 0 ? decoded : EMPTY_DOC);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session, docId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="chevron-back" size={26} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {docName}
        </Text>
        <TouchableOpacity
          style={styles.refreshBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          onPress={() => load()}
        >
          <Ionicons name="refresh" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load()}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <FlowDocBlocks document={doc ?? EMPTY_DOC} editable={false} />
        </ScrollView>
      )}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.chatScreenBackground },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingTop: 8,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderMuted,
    },
    backBtn: { padding: 6 },
    title: {
      flex: 1,
      fontSize: 17,
      fontWeight: '600',
      color: c.textHeader,
      marginHorizontal: 4,
    },
    refreshBtn: { padding: 6 },
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      paddingBottom: 64,
    },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    errorText: {
      color: c.placeholder,
      fontSize: 13,
      marginBottom: 12,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    retryBtn: {
      paddingVertical: 6,
      paddingHorizontal: 18,
      borderRadius: 14,
      backgroundColor: c.surfaceMuted,
    },
    retryText: { fontSize: 13, color: c.textPrimary },
  });
}
