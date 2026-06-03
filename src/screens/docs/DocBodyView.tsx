/**
 * DocBodyView
 *
 * 单个 FlowDoc item 主区渲染。支持类型：
 *  - document：拉 Y.Doc 快照、解码、FlowDocBlocks 渲染
 *  - folder：renderFolder 占位（由 DocsHomeScreen 替换为 FolderView）；这里不直接处理
 *  - 其它（webpage / paper / transcription / cooperateInbox）：暂不支持占位
 *
 * 抽出来给 DocsHomeScreen / 任何"看一个 doc"的场景复用。
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
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { getFlowDocSnapshot } from '../../api';
import {
  FlowDocBlocks,
  documentToMarkdown,
  type FlowDocDocument,
} from '../../flowdoc-native-input';
import { decodeFlowDocSnapshotToDocument } from '../../flowdoc-native-input/yjsToDocument';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { useResponsive, READING_MAX_WIDTH } from '../../hooks/useResponsive';

const EMPTY_DOC: FlowDocDocument = [
  { type: 'paragraph', children: [{ text: '' }] },
];

const SUPPORTED_TYPES = new Set(['document']);

const UNSUPPORTED_TYPE_LABEL: Record<string, string> = {
  webpage: '网页',
  paper: '论文',
  transcription: '语音转写',
  folder: '文件夹',
  cooperateInbox: '协作收件箱',
};

export type DocBodyViewHandle = {
  /** 把当前文档复制到剪贴板（markdown）。仅 document 类型有效，返回是否复制成功。 */
  copyMarkdown: () => boolean;
  /** 重新拉取当前 item 的快照 */
  reload: () => void;
};

export type DocBodyViewProps = {
  docId: string;
  docType: string;
};

export const DocBodyView = React.forwardRef<DocBodyViewHandle, DocBodyViewProps>(
  function DocBodyView({ docId, docType }, ref) {
    const { session } = useSession();
    const { colors } = useAppTheme();
    const styles = useMemo(() => createStyles(colors), [colors]);
    /** 宽屏（iPad）：正文限到舒适 measure 居中，两侧留白，避免行宽过长难读（沉浸阅读）。 */
    const { expanded } = useResponsive();

    const isSupported = SUPPORTED_TYPES.has(docType);

    const [doc, setDoc] = useState<FlowDocDocument | null>(null);
    const [loading, setLoading] = useState(isSupported);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
      if (!isSupported) return;
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
    }, [session, docId, isSupported]);

    useEffect(() => {
      load();
    }, [load]);

    React.useImperativeHandle(
      ref,
      () => ({
        copyMarkdown: () => {
          if (!doc) return false;
          const md = documentToMarkdown(doc);
          Clipboard.setString(md);
          return true;
        },
        reload: () => {
          load();
        },
      }),
      [doc, load],
    );

    if (!isSupported) {
      return (
        <View style={styles.centered}>
          <Ionicons
            name="document-attach-outline"
            size={56}
            color={colors.placeholder}
            style={styles.unsupportedIcon}
          />
          <Text style={styles.unsupportedTitle}>暂不支持在 mobile 端打开</Text>
          <Text style={styles.unsupportedSubtitle}>
            类型：{UNSUPPORTED_TYPE_LABEL[docType] || docType}
          </Text>
          <Text style={styles.unsupportedHint}>
            目前 mobile 端只渲染富文本类文档（document），其它类型请在 web / desktop 查看
          </Text>
        </View>
      );
    }

    if (loading) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load()}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          expanded && styles.scrollContentWide,
        ]}
      >
        <FlowDocBlocks document={doc ?? EMPTY_DOC} editable={false} />
      </ScrollView>
    );
  },
);

function createStyles(c: AppColors) {
  return StyleSheet.create({
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      paddingBottom: 64,
    },
    /** 宽屏沉浸阅读：限宽居中 + 更宽松的横向 / 纵向留白 */
    scrollContentWide: {
      width: '100%',
      maxWidth: READING_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: 40,
      paddingTop: 24,
      paddingBottom: 96,
    },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 32,
    },
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
    unsupportedIcon: { marginBottom: 16, opacity: 0.6 },
    unsupportedTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
      marginBottom: 6,
    },
    unsupportedSubtitle: {
      fontSize: 13,
      color: c.textMuted,
      marginBottom: 12,
    },
    unsupportedHint: {
      fontSize: 12,
      color: c.placeholder,
      textAlign: 'center',
      lineHeight: 18,
    },
  });
}
