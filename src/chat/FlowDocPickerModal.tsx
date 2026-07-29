/**
 * FlowDocPickerModal
 *
 * 在 chat composer 里点 "+" 时弹出的 FlowDoc 文档选择器。Modal 全屏，复用 DocsSidebar
 * 的折叠树渲染；选中 document 类型时 onPickDoc(docId, name) 回调（其它类型只能展开
 * 折叠，不选）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { getFlowDocTree, type FlowDocTreeItem } from '../api';
import { DocsSidebar } from '../screens/docs/DocsSidebar';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

export type FlowDocPickerModalProps = {
  visible: boolean;
  onClose: () => void;
  onPickDoc: (docId: string, name: string) => void;
  /** Modal dismiss 动画走完之后才 fire；iOS 走 Modal.onDismiss，Android 在 visible
   *  从 true → false 时用 useEffect 触发（无原生 dismiss 回调）。
   *  caller 用来"等模态彻底消失之后再 focus underlying input"。 */
  onAfterDismiss?: () => void;
};

const SELECTABLE_DOC_TYPES = new Set([
  'document',
  /* 网页 / 论文 / 转写也允许被引用 — 跟 web composer 一致；mobile 暂时不会渲染它们，但 agent 可以读 */
  'webpage',
  'paper',
  'transcription',
]);

export function FlowDocPickerModal({
  visible,
  onClose,
  onPickDoc,
  onAfterDismiss,
}: FlowDocPickerModalProps) {
  const insets = useSafeAreaInsets();
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [tree, setTree] = useState<FlowDocTreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (!session) return;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const next = await getFlowDocTree(session);
        setTree(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [session],
  );

  /* visible 切到 true 时拉一次；切到 false 时不清空，下次再开能秒显 */
  useEffect(() => {
    if (visible && tree.length === 0) load(false);
  }, [visible, tree.length, load]);

  /* Android 没有 Modal.onDismiss 回调；用 visible 状态从 true → false 的 useEffect
     模拟"动画结束后再 fire onAfterDismiss"。InteractionManager 帮忙等一帧。 */
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    if (Platform.OS === 'ios') {
      prevVisibleRef.current = visible;
      return;
    }
    if (prevVisibleRef.current && !visible) {
      requestAnimationFrame(() => {
        onAfterDismiss?.();
      });
    }
    prevVisibleRef.current = visible;
  }, [visible, onAfterDismiss]);

  const onSelect = useCallback(
    (item: FlowDocTreeItem) => {
      if (SELECTABLE_DOC_TYPES.has(item.type)) {
        onPickDoc(item.id, item.name || '');
        onClose();
      }
      /* folder / cooperateInbox：折叠状态由 DocsSidebar 内部管，这里不动 */
    },
    [onPickDoc, onClose],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={onAfterDismiss}
      transparent={false}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.title}>选择 FlowDoc 文档</Text>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="close" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
        <DocsSidebar
          items={tree}
          selectedId={null}
          loading={loading}
          refreshing={refreshing}
          error={error}
          onRefresh={() => load(true)}
          onSelect={onSelect}
        />
      </View>
    </Modal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.surface },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderMuted,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.textHeader },
  });
}
