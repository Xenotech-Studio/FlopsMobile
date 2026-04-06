/**
 * 用量详情：与 ProjectSelectSheet / ModelSelectSheet 同款 Bottom Sheet（顶栏、分隔线、滚动区、字号与 padding），
 * 避免系统 Alert 在 Android 上的默认按钮样式。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY } from '../theme/typography';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

type Props = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  body: string;
};

export function UsageDetailModal({ visible, onClose, title = '用量详情', body }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createUsageDetailStyles(colors), [colors]);
  const modalRef = useRef<BottomSheetModal>(null);

  useEffect(() => {
    if (visible) modalRef.current?.present();
    else modalRef.current?.dismiss();
  }, [visible]);

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose]
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={0.35}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    []
  );

  return (
    <BottomSheetModal
      ref={modalRef}
      snapPoints={['50%', '90%']}
      index={0}
      onChange={handleSheetChanges}
      onDismiss={onClose}
      enablePanDownToClose
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={[styles.sheetBg, styles.sheetShadow]}
      handleIndicatorStyle={styles.handle}
    >
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <TouchableOpacity onPress={onClose} style={styles.cancelBtn} activeOpacity={0.7}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.headerBorder} />
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.body} selectable>
          {body}
        </Text>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

function createUsageDetailStyles(c: AppColors) {
  return StyleSheet.create({
    sheetBg: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
    },
    sheetShadow: { ...shadowSheet },
    handle: { backgroundColor: c.borderD4, width: 36 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 24,
      paddingTop: 8,
      paddingBottom: 12,
    },
    headerBorder: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
    },
    title: { fontSize: TASK_FONT_SIZE_BODY, fontWeight: '600', color: c.textPrimary },
    cancelBtn: { paddingVertical: 8, paddingHorizontal: 4 },
    cancelText: { fontSize: TASK_FONT_SIZE_BODY, color: c.textPrimary },
    scrollContent: {
      paddingHorizontal: 24,
      paddingTop: 8,
      paddingBottom: 48,
      backgroundColor: c.surface,
    },
    body: {
      fontSize: TASK_FONT_SIZE_BODY,
      lineHeight: 24,
      color: c.textSecondary,
    },
  });
}
