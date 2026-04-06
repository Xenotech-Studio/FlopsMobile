/**
 * 任务行长按菜单：与 FlowTaskIOS contextMenu 对齐
 * 完成质量/优先级 点击后弹出二级菜单（无背景变暗）
 */
import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  Alert,
  Dimensions,
  LayoutChangeEvent,
  Platform,
  PanResponder,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { TaskItem } from '../taskApi';
import { useTask } from '../context/TaskContext';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { shadowMenu } from '../theme/shadows';
import { TaskRowContent } from './TaskRowContent';

function createTaskRowContextMenuStyles(c: AppColors) {
  return StyleSheet.create({
    backdrop: {
      position: 'absolute',
      left: 0,
      top: 0,
      backgroundColor: c.modalBackdrop,
    },
    rowHighlight: {
      position: 'absolute',
      backgroundColor: c.surfaceMuted,
      borderRadius: 18,
      overflow: 'hidden',
    },
    rowHighlightScaledWrap: {
      position: 'absolute',
    },
    cardWrap: {
      position: 'absolute',
      alignSelf: 'flex-start',
      maxWidth: 320,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 25,
      paddingVertical: Platform.select({ android: 6, default: 8 }),
      paddingHorizontal: 4,
      alignSelf: 'flex-start',
      minWidth: 200,
      ...shadowMenu,
    },
    cardDimmed: {
      opacity: 0.94,
    },
    cardContentDimmed: {
      opacity: 0.72,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 4,
    },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Platform.select({ android: 10, default: 12 }),
      paddingHorizontal: 12,
      gap: 12,
    },
    menuRowText: {
      flex: 1,
      flexShrink: 0,
      fontSize: 17,
      color: c.textPrimary,
    },
    menuRowTextActive: {
      color: c.link,
      fontWeight: '600',
    },
    menuRowTextDanger: {
      flex: 1,
      flexShrink: 0,
      fontSize: 17,
      color: c.danger,
      fontWeight: '500',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginVertical: Platform.select({ android: 6, default: 4 }),
      marginHorizontal: 12,
    },
    submenuWrap: {
      position: 'absolute',
      alignSelf: 'flex-start',
    },
    submenuCard: {
      backgroundColor: c.surface,
      borderRadius: 25,
      paddingVertical: Platform.select({ android: 8, default: 8 }),
      paddingHorizontal: 4,
      ...shadowMenu,
    },
    submenuHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Platform.select({ android: 8, default: 12 }),
      paddingHorizontal: 12,
      gap: 12,
    },
    submenuHeaderText: {
      flex: 1,
      fontSize: 17,
      fontWeight: '600',
      color: c.textPrimary,
    },
    submenuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: Platform.select({ android: 10, default: 12 }),
      paddingHorizontal: 12,
      gap: 12,
      minHeight: Platform.select({ android: 40, default: 48 }),
    },
    submenuRowText: {
      fontSize: 17,
      color: c.textPrimary,
      flex: 1,
    },
  });
}

const ROW_SIDE_MARGIN = 12;
const MENU_GAP = 8;

export type AnchorLayout = { x: number; y: number; width: number; height: number };

export type RowPreview = {
  title: string;
  subtitle: string;
  color: string;
  visualDone: boolean;
  doing: boolean;
  priorityLabel?: string | null;
  priorityColor?: string | null;
};

type TaskRowContextMenuProps = {
  task: TaskItem;
  visible: boolean;
  anchorLayout: AnchorLayout | null;
  rowPreview: RowPreview | null;
  onClose: () => void;
  /** 菜单打开后不松手直接拖动时调用，先关菜单再进入拖拽 */
  onDragInstead?: () => void;
};

const QUALITY_OPTIONS = [
  { value: 'reviewing', label: '待验收', icon: 'checkmark-circle-outline' as const },
  { value: 'done', label: '完成', icon: 'checkmark-done-outline' as const },
  { value: 'wasted', label: '无效', icon: 'close-circle-outline' as const },
];

const PRIORITY_OPTIONS = [
  { value: 'now', label: '立即完成', icon: 'flag' as const },
  { value: 'default', label: '正常', icon: 'flag-outline' as const },
  { value: 'later', label: '不着急', icon: 'flag-outline' as const },
];

const SUBMENU_OFFSET_X = 8;
const SUBMENU_OFFSET_Y = 7;
const SUBMENU_WIDTH_EXTRA = 12;
/** 第一行（完成质量）打开的二级：与第一行对齐 */
const SUBMENU_TOP_FIRST_ROW = 8 + SUBMENU_OFFSET_Y; // 卡片 paddingTop + 向下偏移
/** 第二行（优先级）打开的二级：与第二行对齐 */
const SUBMENU_TOP_SECOND_ROW = 8 + 44 + 9 + SUBMENU_OFFSET_Y; // 到「优先级」行顶 + 向下偏移

export function TaskRowContextMenu({ task, visible, anchorLayout, rowPreview, onClose, onDragInstead }: TaskRowContextMenuProps) {
  const {
    updateTaskDoneQuality,
    updateTaskPriority,
    toggleTaskDoing,
    deleteTask,
  } = useTask() ?? {};
  const { colors } = useAppTheme();
  const styles = useMemo(() => createTaskRowContextMenuStyles(colors), [colors]);

  const [submenu, setSubmenu] = useState<'quality' | 'priority' | null>(null);
  const [mainCardWidth, setMainCardWidth] = useState(0);

  const backdropPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dx) > 8 || Math.abs(gestureState.dy) > 8,
      onPanResponderGrant: () => {
        onClose();
        onDragInstead?.();
      },
    })
  ).current;

  useEffect(() => {
    if (!visible) setSubmenu(null);
  }, [visible]);

  const handleDelete = () => {
    onClose();
    Alert.alert('删除任务', '确定要删除该任务吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => deleteTask?.(task),
      },
    ]);
  };

  const onMainCardLayout = (e: LayoutChangeEvent) => {
    setMainCardWidth(e.nativeEvent.layout.width);
  };

  const handleBackdropPress = () => {
    if (submenu) setSubmenu(null);
    else onClose();
  };

  if (!visible || !anchorLayout) return null;

  const currentQuality = task.done_quality ?? 'reviewing';
  const currentPriority = task.priority ?? 'default';
  const { width: winWidth, height: winHeight } = Dimensions.get('window');
  const rowLeft = anchorLayout.x + ROW_SIDE_MARGIN;
  const rowWidth = Math.max(0, anchorLayout.width - ROW_SIDE_MARGIN * 2);
  const scale = anchorLayout.width > 0 ? rowWidth / anchorLayout.width : 1;
  const scaledHeight = anchorLayout.height * scale;
  const menuTop = anchorLayout.y + anchorLayout.height + MENU_GAP;
  const submenuLeft = rowLeft + SUBMENU_OFFSET_X;
  const submenuWidth = mainCardWidth > 0 ? mainCardWidth + SUBMENU_WIDTH_EXTRA : null;

  return (
    <Modal
      transparent
      visible={visible}
      onRequestClose={onClose}
      animationType="fade"
    >
      <View
        style={[styles.backdrop, { width: winWidth, height: winHeight }]}
        {...(visible && onDragInstead ? backdropPanResponder.panHandlers : {})}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={handleBackdropPress}>
        {/* 高亮行：按原尺寸布局后整体缩放至更窄宽度，避免内容重排 */}
        <View
          style={[
            styles.rowHighlight,
            {
              left: rowLeft,
              top: anchorLayout.y + (anchorLayout.height - scaledHeight) / 2,
              width: rowWidth,
              height: scaledHeight,
            },
          ]}
          pointerEvents="none"
        >
          {rowPreview ? (
            <View
              style={[
                styles.rowHighlightScaledWrap,
                {
                  width: anchorLayout.width,
                  height: anchorLayout.height,
                  left: (rowWidth - anchorLayout.width) / 2,
                  top: (scaledHeight - anchorLayout.height) / 2,
                  transform: [{ scale }],
                },
              ]}
            >
              <TaskRowContent
                title={rowPreview.title}
                subtitle={rowPreview.subtitle || null}
                color={rowPreview.color}
                visualDone={rowPreview.visualDone}
                doing={rowPreview.doing}
                priorityLabel={rowPreview.priorityLabel ?? null}
                priorityColor={rowPreview.priorityColor ?? null}
              />
            </View>
          ) : null}
        </View>
        {/* 主菜单卡片：仅一行「完成质量」、一行「优先级」、一行「删除任务」 */}
        <Pressable
          style={[styles.cardWrap, { left: rowLeft, top: menuTop }]}
          onPress={() => {}}
        >
          <View style={[styles.card, submenu ? styles.cardDimmed : null]} onLayout={onMainCardLayout}>
            <View style={submenu ? styles.cardContentDimmed : null}>
            {task.done ? (
              <TouchableOpacity
                style={styles.menuRow}
                onPress={() => setSubmenu((s) => (s === 'quality' ? null : 'quality'))}
                activeOpacity={0.7}
              >
                <Ionicons name="star-outline" size={20} color={colors.textSecondary} />
                <Text style={styles.menuRowText} numberOfLines={1}>完成质量</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.placeholder} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.menuRow}
                onPress={() => {
                  toggleTaskDoing?.(task);
                  onClose();
                }}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={task.doing ? 'pause-circle-outline' : 'construct-outline'}
                  size={20}
                  color={colors.textSecondary}
                />
                <Text style={styles.menuRowText} numberOfLines={1}>
                  {task.doing ? '停止进行' : '开始进行'}
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.divider} />

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => setSubmenu((s) => (s === 'priority' ? null : 'priority'))}
              activeOpacity={0.7}
            >
              <Ionicons name="flag-outline" size={20} color={colors.textSecondary} />
              <Text style={styles.menuRowText} numberOfLines={1}>优先级</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.placeholder} />
            </TouchableOpacity>

            <View style={styles.divider} />

            <TouchableOpacity
              style={styles.menuRow}
              onPress={handleDelete}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
              <Text style={styles.menuRowTextDanger} numberOfLines={1}>删除任务</Text>
            </TouchableOpacity>
            </View>
          </View>
        </Pressable>

        {/* 二级菜单：无背景变暗，紧贴主菜单右侧 */}
        {submenu === 'quality' && task.done ? (
          <Pressable
            style={[styles.submenuWrap, { left: submenuLeft, top: menuTop + SUBMENU_TOP_FIRST_ROW }]}
            onPress={() => {}}
          >
            <View style={[styles.submenuCard, submenuWidth != null ? { width: submenuWidth } : null]}>
              <TouchableOpacity
                style={styles.submenuHeaderRow}
                onPress={() => setSubmenu(null)}
                activeOpacity={0.7}
              >
                <Ionicons name="star-outline" size={20} color={colors.textSecondary} />
                <Text style={styles.submenuHeaderText} numberOfLines={1}>完成质量</Text>
                <Ionicons name="chevron-down" size={16} color={colors.placeholder} />
              </TouchableOpacity>
              <View style={styles.divider} />
              {QUALITY_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={styles.submenuRow}
                  onPress={() => {
                    updateTaskDoneQuality?.(task, opt.value);
                    setSubmenu(null);
                    onClose();
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.submenuRowText,
                      currentQuality === opt.value && styles.menuRowTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {opt.label}
                  </Text>
                  {currentQuality === opt.value ? (
                    <Ionicons name="checkmark" size={18} color={colors.link} />
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        ) : null}

        {submenu === 'priority' ? (
          <Pressable
            style={[styles.submenuWrap, { left: submenuLeft, top: menuTop + SUBMENU_TOP_SECOND_ROW }]}
            onPress={() => {}}
          >
            <View style={[styles.submenuCard, submenuWidth != null ? { width: submenuWidth } : null]}>
              <TouchableOpacity
                style={styles.submenuHeaderRow}
                onPress={() => setSubmenu(null)}
                activeOpacity={0.7}
              >
                <Ionicons name="flag-outline" size={20} color={colors.textSecondary} />
                <Text style={styles.submenuHeaderText} numberOfLines={1}>优先级</Text>
                <Ionicons name="chevron-down" size={16} color={colors.placeholder} />
              </TouchableOpacity>
              <View style={styles.divider} />
              {PRIORITY_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={styles.submenuRow}
                  onPress={() => {
                    updateTaskPriority?.(task, opt.value);
                    setSubmenu(null);
                    onClose();
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.submenuRowText,
                      currentPriority === opt.value && styles.menuRowTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {opt.label}
                  </Text>
                  {currentPriority === opt.value ? (
                    <Ionicons name="checkmark" size={18} color={colors.link} />
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        ) : null}
        </Pressable>
      </View>
    </Modal>
  );
}
