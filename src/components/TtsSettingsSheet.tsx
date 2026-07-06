/**
 * 语音播报设置 Bottom Sheet —— 从 ChatScreen ⋯ 菜单「语音播报」进入。
 * 两个控件：
 *  - 自动播报：Switch，即时生效（对应 tts_autoplay），进对话即朗读助手回复。
 *  - 开启播报模式：纯文字行，点了弹 Alert 二次确认，确认后进入沉浸式全局播报（对应 tts_broadcast_mode）；
 *    播报态的黑边框 + 底部横条由 app 级 BroadcastModeOverlay 呈现，退出走那条横条上的按钮，
 *    所以这里不体现"当前是否在播报"，只提供"开启"入口。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL } from '../theme/typography';
import { IOSStyleSwitch } from './IOSStyleSwitch';

function createTtsSettingsSheetStyles(c: AppColors) {
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
    body: { paddingTop: 8, paddingBottom: 40 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 12,
    },
    textCol: { flex: 1, minWidth: 0 },
    primaryLabel: { fontSize: 16, color: c.textPrimary },
    subtitle: { fontSize: TASK_FONT_SIZE_SMALL, color: c.textMuted, marginTop: 3, lineHeight: 18 },
  });
}

type Props = {
  visible: boolean;
  onClose: () => void;
  /** tts_autoplay 当前值 */
  autoplay: boolean;
  /** 切换自动播报（即时生效，无二次确认） */
  onToggleAutoplay: (next: boolean) => void;
  /** 点「开启播报模式」——由调用方弹确认 Alert 并在确认后开启 */
  onPressBroadcast: () => void;
};

export function TtsSettingsSheet({
  visible,
  onClose,
  autoplay,
  onToggleAutoplay,
  onPressBroadcast,
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createTtsSettingsSheetStyles(colors), [colors]);
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
      enableDynamicSizing
      onChange={handleSheetChanges}
      onDismiss={onClose}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={[styles.sheetBg, styles.sheetShadow]}
      handleIndicatorStyle={styles.handle}
    >
      <BottomSheetView style={styles.body}>
        <View style={styles.header}>
          <Text style={styles.title}>语音播报</Text>
          <TouchableOpacity onPress={onClose} style={styles.cancelBtn} activeOpacity={0.7}>
            <Text style={styles.cancelText}>取消</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.headerBorder} />

        {/* 自动播报：即时开关 */}
        <View style={styles.row}>
          <Ionicons name="volume-high-outline" size={24} color={colors.textPrimary} />
          <View style={styles.textCol}>
            <Text style={styles.primaryLabel}>助手回复自动朗读</Text>
            <Text style={styles.subtitle}>进入对话即朗读助手回复；离开对话页或锁屏也继续。</Text>
          </View>
          <IOSStyleSwitch value={autoplay} onValueChange={onToggleAutoplay} />
        </View>

        {/* 开启播报模式：纯文字行 → 调用方弹确认 Alert */}
        <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={onPressBroadcast}>
          <Ionicons name="radio-outline" size={24} color={colors.textPrimary} />
          <View style={styles.textCol}>
            <Text style={styles.primaryLabel}>开启播报模式</Text>
            <Text style={styles.subtitle}>
              像导航软件一样：监听你所有对话，离开对话页、锁屏、切到其它 App 都持续朗读。
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </BottomSheetView>
    </BottomSheetModal>
  );
}
