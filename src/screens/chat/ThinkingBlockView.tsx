/**
 * 思考块视图：对齐 FlopsWeb ThinkingBlock —— 无背景、Brain 图标 + 标签 +（流式中）脉动小圆点，
 * 内容区紧贴标签下方挂一道竖线，流式中限高约 2 行、自动钉底；闭合后展开则不限高。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';

type ThinkingBlock = {
  type: 'thinking';
  content: string;
  closed: boolean;
  seconds?: number;
  startedAt?: number;
};

// lucide Brain icon path（与 FlopsWeb ThinkingBlock 用的同一组路径）
function BrainIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <Path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <Path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <Path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <Path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <Path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <Path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <Path d="M6 18a4 4 0 0 1-1.967-.516" />
      <Path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </Svg>
  );
}

function computeSeconds(block: ThinkingBlock, closed: boolean): number | null {
  // 反序列化：server 持久化的 reasoning_seconds 已塞到 block.seconds，优先用
  if (typeof block.seconds === 'number' && block.seconds > 0) {
    return Math.round(block.seconds * 10) / 10;
  }
  // 流式：用前端记的 startedAt 现算（仅闭合时定格，避免 re-render 抖动）
  if (!block.startedAt) return null;
  if (!closed) return null;
  return Math.max(0, Math.round((Date.now() - block.startedAt) / 100) / 10);
}

function formatLabel(seconds: number | null, closed: boolean): string {
  if (seconds == null) return closed ? 'Thought' : 'Thinking';
  const txt = seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString();
  return closed ? `Thought for ${txt} s` : `Thinking for ${txt} s`;
}

export function ThinkingBlockView({
  block,
  prevIsToolPackage = false,
  nextIsToolPackage = false,
}: {
  block: ThinkingBlock;
  /** 与上方相邻的是「工具包激活/关闭」灰字行：上 margin 单独放大到 4 让三行间距均衡 */
  prevIsToolPackage?: boolean;
  /** 与下方相邻的是「工具包激活/关闭」灰字行：下 margin 单独放大到 4 让三行间距均衡 */
  nextIsToolPackage?: boolean;
}) {
  const { colors } = useAppTheme();
  const styles = createStyles(colors);

  const closed = !!block.closed;
  const content = block.content || '';

  // 流式中默认展开（body 限高滚动）；闭合后自动折叠为单行；用户手动切过就保留意图
  const [open, setOpen] = useState<boolean>(!closed);
  const touchedRef = useRef(false);
  const prevClosedRef = useRef(closed);
  useEffect(() => {
    if (!prevClosedRef.current && closed && !touchedRef.current) {
      setOpen(false);
    }
    prevClosedRef.current = closed;
  }, [closed]);

  // 脉动小圆点：流式中循环 0.25 ↔ 0.85，对齐 web @keyframes thinking-block-pulse
  const pulseAnim = useRef(new Animated.Value(0.25)).current;
  useEffect(() => {
    if (closed) {
      pulseAnim.setValue(0.25);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.85,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.25,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [closed, pulseAnim]);

  // 流式中：每次 content 变化把限高容器钉到底
  const scrollRef = useRef<ScrollView | null>(null);
  const handleContentSizeChange = () => {
    if (!closed && open && scrollRef.current) {
      scrollRef.current.scrollToEnd({ animated: false });
    }
  };

  const seconds = computeSeconds(block, closed);

  // 老数据 closed 但既无 seconds 又无 startedAt：避免出现孤零零一行 "Thought"
  if (closed && seconds == null) return null;

  const label = formatLabel(seconds, closed);
  const showBody = open && content.length > 0;
  const onToggle = () => {
    touchedRef.current = true;
    setOpen((v) => !v);
  };

  return (
    <View
      style={[
        styles.container,
        prevIsToolPackage && styles.containerNudgeTop,
        nextIsToolPackage && styles.containerNudgeBottom,
      ]}
    >
      <TouchableOpacity
        onPress={onToggle}
        activeOpacity={0.6}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        style={styles.toggle}
      >
        <BrainIcon size={12} color={colors.textMuted} />
        <Text style={styles.label}>{label}</Text>
        {!closed ? (
          <Animated.View
            style={[
              styles.pulseDot,
              { backgroundColor: colors.textMuted, opacity: pulseAnim },
            ]}
          />
        ) : null}
      </TouchableOpacity>
      {showBody ? (
        <ScrollView
          ref={scrollRef}
          style={[styles.body, !closed && styles.bodyStreaming]}
          contentContainerStyle={styles.bodyContent}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={handleContentSizeChange}
        >
          <Text style={styles.bodyText} selectable={closed}>
            {content}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    /* 默认与上下兄弟之间的视觉间距 ≈ 3；与「工具包激活/关闭」灰字行相邻时单独放大到 4，
       让 thinking-toolNav-thinking 三行视觉等距（toolNav 自身没有上下 margin，
       全靠 thinking.container 这一侧的 margin 顶起）。
       marginLeft:2 让 12px Brain 与 14px Package 的水平中心粗略对齐（差 1px，给点呼吸） */
    container: {
      marginTop: 3,
      marginBottom: 3,
      marginLeft: 1,
    },
    containerNudgeTop: { marginTop: 4 },
    containerNudgeBottom: { marginBottom: 4 },
    toggle: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 3,
      alignSelf: 'flex-start',
    },
    label: {
      fontSize: 13,
      color: c.textMuted,
      fontWeight: '400',
      marginLeft: 6,
    },
    pulseDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      marginLeft: 7,
    },
    /* margin-left:5 让 2px 竖线中点对齐上方 12px Brain 图标水平中点（icon 左缘=0，中点 x=6；
       竖线中点 = 5 + 1 = 6）；margin-top:-3 抵掉 toggle 行下方视觉空隙、竖线顶紧贴图标底部 */
    body: {
      marginTop: -3,
      marginLeft: 5,
      borderLeftWidth: 2,
      borderLeftColor: c.borderMuted,
    },
    bodyContent: {
      paddingLeft: 11,
      paddingTop: 7,
    },
    // 流式中限高约 2 行（lineHeight 19 × 2 = 38），自动钉底
    bodyStreaming: {
      maxHeight: 38,
    },
    bodyText: {
      fontSize: 13,
      lineHeight: 19,
      color: c.textMutedSlate ?? c.textMuted,
      fontStyle: 'italic',
    },
  });
}
