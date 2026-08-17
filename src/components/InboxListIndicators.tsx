import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useAppTheme } from '../context/ThemeContext';

/**
 * 「agent 正在生成回复」：14px 环、灰底 + 深顶弧、0.7s 匀速转（对齐 FlopsWeb `.inbox-run-spinner`）。
 *
 * 用 Reanimated 而不是 RN 自带 Animated —— 后者那版在列表里会「转一下就不转了」：
 * 它每次 render 都新建一个 `spin.interpolate(...)` 节点挂到 Animated.View 上，
 * 而这一行所在的会话列表是随 inbox SSE 每帧重渲染的（running/unread/后台任务三份 map 任一变化
 * 都会刷新整个 context value），插值节点被反复重挂，原生驱动那条动画就跟当前节点脱钩、视觉上定住。
 * Reanimated 把角度放在 shared value 上、动画跑在 UI 线程，与 React 重渲染完全解耦，
 * 重渲染多少次都不影响它转。本仓其它常驻动画（骨架屏扫光等）也都是这条路。
 */
export function InboxRunSpinner() {
  const angle = useSharedValue(0);
  useEffect(() => {
    angle.value = 0;
    angle.value = withRepeat(
      withTiming(360, { duration: 700, easing: Easing.linear }),
      -1, // 无限
      false // 不回摆，转满一圈直接从 0 再来
    );
    return () => cancelAnimation(angle);
  }, [angle]);
  const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  return (
    <Animated.View
      style={[styles.runSpinner, spinStyle]}
      accessibilityLabel="生成中"
      accessibilityRole="image"
    />
  );
}

/**
 * 「后台任务在跑」指示器：**静止的蓝色时钟**，刻意跟 InboxRunSpinner 的转圈区分开。
 *
 * 两者语义不同：转圈 = chat_v2 agent 正在生成回复（人在等它吐字）；时钟 = agent 没在跑，
 * 只是这个会话名下还挂着运行中的后台任务（可以放着不管）。混用同一个转圈会让人以为
 * agent 卡住了。
 *
 * 形态对齐 FlopsDesktop 的 tab 图标（ChatTab.jsx 的 .conversation-tab-task-icon）：
 * 那边是 13px 的时钟 SVG（circle r=9 + 时针分针 polyline），配色 #2563eb，选中的深色 tab
 * 上换成 #93c5fd。这里用 Ionicons 的 time-outline（同一个"圆框 + 指针"形状，且与手机端
 * 其余图标同一套线宽），深浅两套色直接沿用 Desktop 那两个值。
 */
export function InboxBgTaskIcon() {
  const { isDark } = useAppTheme();
  return (
    <View style={styles.bgTaskWrap} accessibilityLabel="后台任务运行中" accessibilityRole="image">
      <Ionicons name="time-outline" size={15} color={isDark ? '#93c5fd' : '#2563eb'} />
    </View>
  );
}

/** 与 FlopsWeb `.inbox-unread-check` 一致 */
export function InboxUnreadCheck() {
  return (
    <View style={styles.unreadWrap} accessibilityLabel="新回复" accessibilityRole="image">
      <Text style={styles.unreadGlyph}>✓</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  runSpinner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#d4d4d4',
    borderTopColor: '#404040',
  },
  /** 与 unreadWrap 同尺寸的固定槽：三种状态互切时行内宽度不变、不抖
   *  （Desktop 也是用一个定宽 .conversation-tab-status 槽装三种图标）。 */
  bgTaskWrap: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadWrap: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadGlyph: {
    fontSize: 13,
    fontWeight: '700',
    color: '#16a34a',
    lineHeight: 16,
  },
});
