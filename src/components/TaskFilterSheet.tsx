/**
 * 筛选面板：与 FlowTaskIOS TaskFilterPanel 对齐
 * 从底部弹出、可拉高（50% / 90% 停靠），区块：归属 / 状态 / 显示 / 近期删除
 */
import React, { useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
  Platform,
} from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { shadowSheet, shadowCard } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY, TASK_FONT_SIZE_SMALL } from '../theme/typography';
import { IOSStyleSwitch } from './IOSStyleSwitch';

/** 渐进式状态筛选：与 FlowTaskIOS StatusLevel 一致 */
export type StatusLevel = 0 | 1 | 2 | 3;
export const STATUS_LABELS: Record<StatusLevel, string> = {
  0: '紧急',
  1: '非紧急',
  2: '待验收',
  3: '已完成',
};

type TaskFilterSheetProps = {
  visible: boolean;
  onClose: () => void;
  showOnlyMine: boolean;
  onShowOnlyMineChange: (v: boolean) => void;
  statusLevel: StatusLevel;
  onStatusLevelChange: (v: StatusLevel) => void;
  showTimeLabels: boolean;
  onShowTimeLabelsChange: (v: boolean) => void;
  showProjectName: boolean;
  onShowProjectNameChange: (v: boolean) => void;
  /** 是否显示「只看我的」区块（今日页不显示） */
  showOnlyMineToggle?: boolean;
  /** 项目详情页：点击后关闭并打开近期删除 */
  onShowDeletedTasks?: () => void;
  /** 今日页：是否提前进入新的一天，显示「取消提前进入」 */
  isAheadOfToday?: boolean;
  onCancelAheadOfToday?: () => void;
};

export function TaskFilterSheet({
  visible,
  onClose,
  showOnlyMine,
  onShowOnlyMineChange,
  statusLevel,
  onStatusLevelChange,
  showTimeLabels,
  onShowTimeLabelsChange,
  showProjectName,
  onShowProjectNameChange,
  showOnlyMineToggle = true,
  onShowDeletedTasks,
  isAheadOfToday = false,
  onCancelAheadOfToday,
}: TaskFilterSheetProps) {
  const modalRef = useRef<BottomSheetModal>(null);
  const { width } = useWindowDimensions();

  useEffect(() => {
    if (visible) modalRef.current?.present();
    else modalRef.current?.dismiss();
  }, [visible]);

  const handleSheetChanges = (index: number) => {
    if (index === -1) onClose();
  };

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

  const segmentWidth = (width - 32 - 40) / 4;

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
        <Text style={styles.title}>筛选</Text>
        <TouchableOpacity onPress={onClose} style={styles.doneBtnWrap} activeOpacity={0.7}>
          <Text style={styles.doneBtn}>{Platform.OS === 'android' ? '确认' : '完成'}</Text>
        </TouchableOpacity>
      </View>
      <BottomSheetScrollView contentContainerStyle={styles.scrollContent}>
        {isAheadOfToday && onCancelAheadOfToday ? (
          <View style={styles.section}>
            <View style={styles.card}>
              <TouchableOpacity
                style={styles.rowButton}
                onPress={() => {
                  onCancelAheadOfToday();
                  onClose();
                }}
              >
                <Ionicons name="arrow-undo" size={20} color="#111827" />
                <Text style={styles.rowButtonText}>取消提前进入</Text>
                <View style={{ flex: 1 }} />
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {showOnlyMineToggle ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>归属</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>只看我的</Text>
                <IOSStyleSwitch value={showOnlyMine} onValueChange={onShowOnlyMineChange} />
              </View>
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>状态</Text>
          <View style={styles.card}>
            <View style={styles.segmentWrap}>
              <View style={styles.segmentTrack}>
                <View
                  style={[
                    styles.segmentFill,
                    { width: (statusLevel + 1) * segmentWidth },
                  ]}
                />
                <View
                  style={[
                    styles.segmentThumb,
                    { width: segmentWidth - 4, left: statusLevel * segmentWidth + 2 },
                  ]}
                />
                <View style={styles.segmentLabels}>
                  {( [0, 1, 2, 3] as const ).map((level) => (
                    <TouchableOpacity
                      key={level}
                      style={[styles.segmentLabel, { width: segmentWidth }]}
                      onPress={() => onStatusLevelChange(level)}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.segmentLabelText,
                          statusLevel === level && styles.segmentLabelTextActive,
                          level <= statusLevel && statusLevel !== level && styles.segmentLabelTextIncluded,
                        ]}
                        numberOfLines={1}
                      >
                        {STATUS_LABELS[level]}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <Text style={styles.segmentCaption}>
                向右滑动显示更多任务（包含左侧所有档位）
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>显示</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>持续显示任务时间</Text>
              <IOSStyleSwitch value={showTimeLabels} onValueChange={onShowTimeLabelsChange} />
            </View>
            <View style={[styles.row, styles.rowBorder]}>
              <Text style={styles.rowLabel}>显示项目名称</Text>
              <IOSStyleSwitch value={showProjectName} onValueChange={onShowProjectNameChange} />
            </View>
          </View>
        </View>

        {onShowDeletedTasks ? (
          <View style={styles.section}>
            <View style={styles.card}>
              <TouchableOpacity
                style={styles.rowButton}
                onPress={() => {
                  onClose();
                  onShowDeletedTasks();
                }}
              >
                <Ionicons name="trash-outline" size={20} color="#111827" />
                <Text style={styles.rowButtonText}>查看近期删除</Text>
                <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  sheetBg: { backgroundColor: '#f2f2f7', borderTopLeftRadius: 32, borderTopRightRadius: 32 },
  sheetShadow: { ...shadowSheet },
  handle: { backgroundColor: '#c7c7cc', width: 36 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 0,
  },
  title: { fontSize: TASK_FONT_SIZE_BODY, fontWeight: '600', color: '#111827' },
  doneBtnWrap: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#e8e8ed',
    borderRadius: 22,
  },
  doneBtn: { fontSize: 16, fontWeight: '600', color: '#111827' },
  scrollContent: { paddingBottom: 48, backgroundColor: '#f2f2f7' },
  section: { marginTop: 16, paddingHorizontal: 16 },
  sectionHeader: {
    fontSize: TASK_FONT_SIZE_SMALL,
    fontWeight: '400',
    color: '#6b7280',
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 28,
    overflow: 'hidden',
    ...shadowCard,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  rowLabel: { fontSize: TASK_FONT_SIZE_BODY, color: '#111827' },
  rowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    gap: 10,
  },
  rowButtonText: { fontSize: TASK_FONT_SIZE_BODY, color: '#111827', flex: 1 },
  segmentWrap: { paddingVertical: 20, paddingHorizontal: 20 },
  segmentTrack: {
    height: 40,
    borderRadius: 20,
    backgroundColor: '#e5e7eb',
    overflow: 'hidden',
    position: 'relative',
  },
  segmentFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(17,24,39,0.15)',
    borderRadius: 20,
  },
  segmentThumb: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    backgroundColor: '#111827',
    borderRadius: 18,
  },
  segmentLabels: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  segmentLabel: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
  },
  segmentLabelText: {
    fontSize: TASK_FONT_SIZE_SMALL,
    fontWeight: '600',
    color: '#111827',
  },
  segmentLabelTextActive: { color: '#fff' },
  segmentLabelTextIncluded: { color: '#6b7280' },
  segmentCaption: {
    fontSize: TASK_FONT_SIZE_SMALL,
    color: '#6b7280',
    marginTop: 16,
  },
});
