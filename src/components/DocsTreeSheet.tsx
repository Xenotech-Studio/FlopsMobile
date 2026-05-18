/**
 * DocsTreeSheet —— 文档目录 bottom sheet。
 *
 * 替换原 DocsHomeScreen 内左缘滑入的 sidebar：DocsScreen header 左上角第二个圆钮（"目录"）
 * 调起本 sheet，从底部弹出。sheet 内部即原 [[DocsSidebar]]，点 item 自动关 sheet 并切主区。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import type { FlowDocTreeItem } from '../api';
import { DocsSidebar } from '../screens/docs/DocsSidebar';
import { shadowSheet } from '../theme/shadows';

export type DocsTreeSheetProps = {
  visible: boolean;
  onClose: () => void;
  items: FlowDocTreeItem[];
  selectedId: string | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelect: (item: FlowDocTreeItem) => void;
};

export function DocsTreeSheet({
  visible,
  onClose,
  items,
  selectedId,
  loading,
  refreshing,
  error,
  onRefresh,
  onSelect,
}: DocsTreeSheetProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const ref = useRef<BottomSheetModal>(null);

  useEffect(() => {
    if (visible) ref.current?.present();
    else ref.current?.dismiss();
  }, [visible]);

  const onChange = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose]
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={colors.bottomSheetBackdropOpacity}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    [colors.bottomSheetBackdropOpacity]
  );

  const handleSelect = useCallback(
    (item: FlowDocTreeItem) => {
      onSelect(item);
      // 文件夹点击是切主区展开，不关 sheet；文档点击切并关 sheet（与原 DocsHomeScreen 行为一致）
      const isFolder = item.type === 'folder' || item.type === 'cooperateInbox';
      if (!isFolder) ref.current?.dismiss();
    },
    [onSelect]
  );

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={['65%', '92%']}
      index={0}
      enablePanDownToClose
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={[styles.bg, styles.sheetShadow]}
      handleIndicatorStyle={styles.handle}
      onChange={onChange}
      onDismiss={onClose}
    >
      <DocsSidebar
        items={items}
        selectedId={selectedId}
        loading={loading}
        refreshing={refreshing}
        error={error}
        onRefresh={onRefresh}
        onSelect={handleSelect}
      />
    </BottomSheetModal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    bg: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
    },
    sheetShadow: { ...shadowSheet },
    handle: { backgroundColor: c.borderD4, width: 36 },
  });
}
