/**
 * 轻量卡片式底部选择器（2~3 个选项）：与 ModelSelectSheet 同款 Bottom Sheet 外壳
 * （50%/90% 停靠、顶栏标题+关闭），区别只在选项渲染风格——每个选项是独立圆角卡片
 * （背景区别于 sheet 底色、卡片间留间距），当前选中项显示 ✓。点选后 1s 自动关闭。
 * 注意：内容不要包 BottomSheetView（那是 enableDynamicSizing 的量高容器，与固定
 * snapPoints 打架会把 sheet 压扁），直接 View + BottomSheetScrollView。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL } from '../theme/typography';
import type { ModelSelectOption } from './ModelSelectSheet';

function createBlurSelectSheetStyles(c: AppColors) {
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
      paddingBottom: 6,
    },
    title: { fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted },
    cancelBtn: { paddingVertical: 4, paddingLeft: 12 },
    cancelText: { fontSize: TASK_FONT_SIZE_BODY, color: c.primary },
    scrollContent: {
      paddingBottom: 48,
      paddingTop: 4,
      paddingHorizontal: 16,
      backgroundColor: c.surface,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: c.surfaceMuted,
      borderRadius: 14,
      marginTop: 8,
    },
    textCol: { flex: 1, minWidth: 0 },
    primaryLabel: { fontSize: 16, color: c.textPrimary },
    subtitle: { fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted, marginTop: 2 },
    checkmark: { marginLeft: 4 },
  });
}

type Props = {
  visible: boolean;
  onClose: () => void;
  options: ModelSelectOption[];
  onSelect: (value: string) => void;
  /** 当前选中的值（用于显示 ✓ 勾选标记） */
  selectedValue?: string;
  title?: string;
};

export function BlurSelectSheet({
  visible,
  onClose,
  options,
  onSelect,
  selectedValue,
  title = '选择',
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createBlurSelectSheetStyles(colors), [colors]);
  const modalRef = useRef<BottomSheetModal>(null);
  /** 刚点选的项：✓ 立即落位，1s 后才关 sheet（期间忽略重复点选）。 */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      setSelectedKey(null); // 重新打开：清上次选中的动画态
      modalRef.current?.present();
    } else {
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      modalRef.current?.dismiss();
    }
  }, [visible]);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const handlePress = useCallback(
    (value: string) => {
      if (selectedKey) return;
      setSelectedKey(value);
      onSelect(value);
      closeTimer.current = setTimeout(() => onClose(), 1000);
    },
    [selectedKey, onSelect, onClose]
  );

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
        <Text style={styles.title}>{title}</Text>
        <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
          <Text style={styles.cancelText}>关闭</Text>
        </TouchableOpacity>
      </View>
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {options.map((item) => {
          const isSelected = (selectedKey ?? selectedValue) === item.value;
          return (
            <TouchableOpacity
                key={item.value}
                style={styles.card}
                onPress={() => handlePress(item.value)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={item.icon ?? 'hardware-chip-outline'}
                  size={22}
                  color={colors.textPrimary}
                />
                <View style={styles.textCol}>
                  <Text style={styles.primaryLabel} numberOfLines={1}>
                    {item.label}
                  </Text>
                  {item.subtitle && item.subtitle.trim() ? (
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {item.subtitle}
                    </Text>
                  ) : null}
                </View>
                {isSelected && (
                  <Ionicons
                    name="checkmark-circle"
                    size={22}
                    color={colors.primary}
                    style={styles.checkmark}
                  />
                )}
              </TouchableOpacity>
          );
        })}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
