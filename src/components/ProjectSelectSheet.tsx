/**
 * 新建任务时选择归属项目，与 FlowTaskIOS ProjectSelectForCreateView 对齐。
 * 从底部弹出（与筛选 sheet 一致），白底、仅 header 下分割线，列表行为纯行无卡片无分割线。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL } from '../theme/typography';
import type { Project } from '../taskApi';

type Props = {
  visible: boolean;
  onClose: () => void;
  projects: Project[];
  onSelectProject: (project: Project) => void;
};

export function ProjectSelectSheet({
  visible,
  onClose,
  projects,
  onSelectProject,
}: Props) {
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
        <Text style={styles.title}>选择项目</Text>
        <TouchableOpacity onPress={onClose} style={styles.cancelBtn} activeOpacity={0.7}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.headerBorder} />
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {projects.map((item) => (
          <TouchableOpacity
            key={item.id}
            style={styles.row}
            onPress={() => onSelectProject(item)}
            activeOpacity={0.7}
          >
            <Ionicons name="folder-outline" size={24} color="#111827" />
            <View style={styles.projectInfo}>
              <Text style={styles.projectName}>{item.name ?? item.id}</Text>
              {item.description && item.description.trim() ? (
                <Text style={styles.projectDesc} numberOfLines={1}>
                  {item.description}
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
          </TouchableOpacity>
        ))}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  sheetBg: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
  },
  sheetShadow: { ...shadowSheet },
  handle: { backgroundColor: '#c7c7cc', width: 36 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerBorder: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e7eb',
  },
  title: { fontSize: TASK_FONT_SIZE_BODY, fontWeight: '600', color: '#111827' },
  cancelBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  cancelText: { fontSize: TASK_FONT_SIZE_BODY, color: '#111827' },
  scrollContent: {
    paddingBottom: 48,
    paddingTop: 8,
    backgroundColor: '#fff',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  projectInfo: { flex: 1 },
  projectName: { fontSize: 16, color: '#111827' },
  projectDesc: { fontSize: TASK_FONT_SIZE_SMALL, color: '#6b7280', marginTop: 2 },
});
