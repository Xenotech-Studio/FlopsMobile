/**
 * 今日首页新建：项目内存在 chore 等无序区时，在选项目后再选「未整理」或具体区域。
 * 样式与 ProjectSelectSheet 一致。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL } from '../theme/typography';

function createStyles(c: AppColors) {
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
    subtitle: {
      fontSize: TASK_FONT_SIZE_SMALL,
      color: c.textMuted,
      marginTop: 4,
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    cancelBtn: { paddingVertical: 8, paddingHorizontal: 4 },
    cancelText: { fontSize: TASK_FONT_SIZE_BODY, color: c.textPrimary },
    scrollContent: {
      paddingBottom: 48,
      paddingTop: 8,
      backgroundColor: c.surface,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 12,
    },
    rowInfo: { flex: 1 },
    rowTitle: { fontSize: 16, color: c.textPrimary },
    rowDesc: { fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted, marginTop: 2 },
  });
}

export type CreateRegionChoice =
  | { kind: 'unorganized' }
  | { kind: 'dump_parent'; parentTaskId: string };

type DumpOption = { id: string; title: string };

type Props = {
  visible: boolean;
  projectLabel: string;
  dumpParents: DumpOption[];
  onClose: () => void;
  onSelect: (choice: CreateRegionChoice) => void;
};

export function CreateTaskRegionSheet({
  visible,
  projectLabel,
  dumpParents,
  onClose,
  onSelect,
}: Props) {
  const modalRef = useRef<BottomSheetModal>(null);
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
        <Text style={styles.title}>创建位置</Text>
        <TouchableOpacity onPress={onClose} style={styles.cancelBtn} activeOpacity={0.7}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.subtitle} numberOfLines={2}>
        项目「{projectLabel}」内有无序区，请选择新任务放在哪里
      </Text>
      <View style={styles.headerBorder} />
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.row}
          onPress={() => onSelect({ kind: 'unorganized' })}
          activeOpacity={0.7}
        >
          <Ionicons name="albums-outline" size={24} color={colors.textPrimary} />
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>未整理</Text>
            <Text style={styles.rowDesc}>流程图视口左上角暂存，之后再拖入图内</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.placeholder} />
        </TouchableOpacity>
        {dumpParents.map((d) => (
          <TouchableOpacity
            key={d.id}
            style={styles.row}
            onPress={() => onSelect({ kind: 'dump_parent', parentTaskId: d.id })}
            activeOpacity={0.7}
          >
            <Ionicons name="grid-outline" size={24} color={colors.textPrimary} />
            <View style={styles.rowInfo}>
              <Text style={styles.rowTitle}>{d.title}</Text>
              <Text style={styles.rowDesc}>无序子任务区（与 Web chore 区一致）</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.placeholder} />
          </TouchableOpacity>
        ))}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
