import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../context/ThemeContext';

/** 与 FlopsWeb `.inbox-run-spinner` 一致：14px 环、灰底 + 深顶弧、0.7s 旋转 */
export function InboxRunSpinner() {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View
      style={[styles.runSpinner, { transform: [{ rotate }] }]}
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
