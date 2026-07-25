/**
 * 聊天页选择模型，与 ProjectSelectSheet（任务页新建选项目）同款 Bottom Sheet：顶栏标题+取消、
 * header 下分割线、列表行（左图标 + 主副文案 + 右 chevron），无行间分割线。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppTheme } from '../context/ThemeContext';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { AppColors } from '../theme/appColors';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL } from '../theme/typography';

function createModelSelectSheetStyles(c: AppColors) {
  return StyleSheet.create({
    sheetBg: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
    },
    sheetShadow: { ...shadowSheet },
    handle: { backgroundColor: c.borderD5, width: 36 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 12,
    },
    headerBorder: {
      height: c.headerBarBottomBorderWidth,
      backgroundColor: c.headerBarBottomBorderColor,
    },
    title: { fontSize: TASK_FONT_SIZE_BODY, fontWeight: '600', color: c.textPrimary },
    cancelBtn: { paddingVertical: 8, paddingHorizontal: 4 },
    cancelText: { fontSize: TASK_FONT_SIZE_BODY, color: c.textPrimary },
    scrollContent: {
      paddingBottom: 48,
      paddingTop: 8,
      backgroundColor: c.surface,
    },
    emptyText: {
      paddingVertical: 24,
      paddingHorizontal: 16,
      fontSize: TASK_FONT_SIZE_SMALL,
      color: c.textMuted,
      textAlign: 'center',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 12,
    },
    textCol: { flex: 1, minWidth: 0 },
    primaryLabel: { fontSize: 16, color: c.textPrimary },
    subtitle: { fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted, marginTop: 2 },
  });
}

export type ModelSelectOption = {
  label: string;
  value: string;
  /** 第二行小字，如目录价（可选） */
  subtitle?: string | null;
  /** Ionicons 图标名（可选），如 'headset-outline'；缺省用 hardware-chip-outline */
  icon?: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  options: ModelSelectOption[];
  onSelectModel: (modelId: string) => void;
  /** 顶栏标题，默认「选择模型」 */
  sheetTitle?: string;
};

export function ModelSelectSheet({
  visible,
  onClose,
  options,
  onSelectModel,
  sheetTitle = '选择模型',
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createModelSelectSheetStyles(colors), [colors]);
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
        opacity={colors.bottomSheetBackdropOpacity}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    [colors.bottomSheetBackdropOpacity]
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
        <Text style={styles.title}>{sheetTitle}</Text>
        <TouchableOpacity onPress={onClose} style={styles.cancelBtn} activeOpacity={0.7}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.headerBorder} />
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {options.length === 0 ? (
          <Text style={styles.emptyText}>暂无可选模型，请稍后再试或检查网络。</Text>
        ) : (
          options.map((item) => (
            <TouchableOpacity
              key={item.value}
              style={styles.row}
              onPress={() => onSelectModel(item.value)}
              activeOpacity={0.7}
            >
              <Ionicons name={item.icon ?? 'hardware-chip-outline'} size={24} color={colors.textPrimary} />
              <View style={styles.textCol}>
                <Text style={styles.primaryLabel} numberOfLines={2}>
                  {item.label}
                </Text>
                {item.subtitle && item.subtitle.trim() ? (
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {item.subtitle}
                  </Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          ))
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
