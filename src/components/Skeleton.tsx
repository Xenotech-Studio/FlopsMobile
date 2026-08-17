/**
 * 骨架屏（skeleton）：会话列表在「本地快照秒开不了」时的加载态占位——冷启动首次登录、
 * 登出后重进、快照被清掉。有快照的路径根本走不到这里（首帧直接是真列表，见
 * context/ConversationContext 的「本地快照秒开」）。
 *
 * 替掉的是原来的空白 + ActivityIndicator：一个居中小菊花既不预告内容形状，也让页面高度
 * 在数据到达时整块跳变。骨架行按**真实行的几何**搭（padding / 行盒 / 分割线全对齐
 * ConversationRow 与抽屉 MenuRow），所以真列表替换它时位置基本不动。
 *
 * 动效：每根占位条自带一趟横向扫光（LinearGradient + Reanimated，UI 线程），相邻行错开
 * ROW_STAGGER_MS，光沿列表往下淌。系统开了「减弱动态效果」则退化成静态灰块。
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View, type DimensionValue, type LayoutChangeEvent } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { LIST_ROW_TITLE_SIZE, TASK_FONT_SIZE_SMALL } from '../theme/typography';
import {
  TASK_ROW_MIN_HEIGHT,
  TASK_ROW_PADDING_RIGHT,
  TASK_ROW_PADDING_VERTICAL,
} from '../theme/layout';

/** 一趟扫光时长。比常见的 1s 稍慢——加载态往往只闪现半秒，太快反而像在抖。 */
const SHIMMER_MS = 1150;
/** 相邻行的起始延迟：光沿列表往下淌，而不是整屏同时闪。 */
const ROW_STAGGER_MS = 90;
/** 扫光两端的透明色。Android 上写 'transparent' 会先插值到黑再淡出（中间一道灰带），
 *  必须写成同色 0 alpha。 */
const SHEEN_EDGE = 'rgba(255,255,255,0)';

/** 文本行盒高度：RN 不指定 lineHeight 时用字体自然行高，SF / Roboto 都约 1.2em。
 *  骨架行必须按同样的行盒撑高，否则真实列表替换它时整页会跳一下。 */
const lineBox = (fontSize: number) => Math.round(fontSize * 1.2);
/** 对话行标题的行盒（跟 ConversationRow 的 title 同字号） */
const TITLE_LINE_H = lineBox(LIST_ROW_TITLE_SIZE);
/** 对话行时间标签的行盒（ConversationRow 的 meta 是 12） */
const META_LINE_H = lineBox(12);
/** 任务行副标题的行盒（TaskRowContent 的 subtitle 用 TASK_FONT_SIZE_SMALL） */
const TASK_SUB_LINE_H = lineBox(TASK_FONT_SIZE_SMALL);
/** 任务行左侧完成圆环的直径（TaskRowContent 的 RING_SIZE） */
const TASK_RING_SIZE = 24;
/** 段标题行（"今日 N 个任务" / "对话"）的高度：文字只有 17，但同一行右侧挂着 padding 10 的
 *  筛选按钮（20pt 图标 → 40x40），所以真实行高由按钮决定。骨架照 40 撑，段间距才对得上。 */
const SECTION_ROW_H = 40;

/** 标题条宽度循环：等宽会像表格，错开才像一列长短不一的对话标题。 */
const TITLE_WIDTHS: DimensionValue[] = ['72%', '54%', '86%', '63%', '45%', '78%', '58%', '68%'];

type SkeletonBarProps = {
  width: DimensionValue;
  height: number;
  /** 默认全圆角（height/2），跟文字条的观感一致 */
  radius?: number;
  /** 扫光起始延迟，用来做逐行错峰 */
  delay?: number;
};

/** 一根带扫光的占位条。宽度可以给百分比——扫光行程按 onLayout 量到的实际宽度算。 */
export function SkeletonBar({ width, height, radius, delay = 0 }: SkeletonBarProps) {
  const { colors } = useAppTheme();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  /** 实测宽度。放 shared value 而非 state：布局回调不触发 re-render，扫光行程在 UI 线程算。 */
  const barW = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return undefined;
    progress.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: SHIMMER_MS, easing: Easing.inOut(Easing.quad) }), -1, false)
    );
    return () => cancelAnimation(progress);
  }, [delay, progress, reduceMotion]);

  const sheenStyle = useAnimatedStyle(() => {
    const w = barW.value;
    // 扫光带比条窄，两端各留出完整的进场/离场行程（-sheenW → w）
    const sheenW = Math.max(w * 0.55, 40);
    return {
      width: sheenW,
      transform: [{ translateX: -sheenW + progress.value * (w + sheenW) }],
      // 宽度还没量出来的那一帧先不画，免得先闪一道贴在左边的光
      opacity: w > 0 ? 1 : 0,
    };
  });

  const onLayout = (e: LayoutChangeEvent) => {
    barW.value = e.nativeEvent.layout.width;
  };

  return (
    <View
      onLayout={onLayout}
      style={[
        styles.bar,
        {
          width,
          height,
          borderRadius: radius ?? height / 2,
          backgroundColor: colors.skeletonBase,
        },
      ]}
    >
      {reduceMotion ? null : (
        <Animated.View style={[styles.sheen, sheenStyle]}>
          <LinearGradient
            colors={[SHEEN_EDGE, colors.skeletonHighlight, SHEEN_EDGE]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
    </View>
  );
}

/** 一行对话骨架。几何逐项对齐 components/ConversationRow：
 *  paddingVertical 12 / paddingHorizontal 18 / 标题行盒 + 2 + 时间行盒 / 底部 hairline。 */
function ConversationRowSkeleton({ index }: { index: number }) {
  const { colors } = useAppTheme();
  const s = useMemo(() => createConvStyles(colors), [colors]);
  const delay = index * ROW_STAGGER_MS;
  return (
    <View style={s.row}>
      <View style={s.main}>
        <View style={s.titleLine}>
          <SkeletonBar width={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} height={13} delay={delay} />
        </View>
        <View style={s.metaLine}>
          <SkeletonBar width={56} height={9} delay={delay} />
        </View>
      </View>
      {/* 右侧 chevron 的占位：不画灰块（一个箭头画成方块很怪），只占同样的宽度让标题条右缘对齐 */}
      <View style={s.chevronSpacer} />
    </View>
  );
}

/** 会话列表骨架（今日页 / 项目页对话段）。count 取「够铺满一屏可见区」即可，多了纯浪费。
 *  startIndex 让扫光的错峰延迟接着上一段继续排（今日页把任务段排在前面）。 */
export function ConversationListSkeleton({
  count = 6,
  startIndex = 0,
}: {
  count?: number;
  startIndex?: number;
}) {
  return (
    <View accessible accessibilityLabel="正在加载对话列表">
      {Array.from({ length: count }, (_, i) => (
        <ConversationRowSkeleton key={i} index={startIndex + i} />
      ))}
    </View>
  );
}

/** 一行任务骨架。几何对齐 components/TaskRowContent：minHeight 76 / paddingVertical 14 /
 *  左 18 右 18 / gap 12 / 左侧 24pt 完成圆环 / 标题行盒 + 2 + 副标题行盒。 */
function TaskRowSkeleton({ index }: { index: number }) {
  const delay = index * ROW_STAGGER_MS;
  return (
    <View style={taskStyles.row}>
      {/* 完成圆环的占位：真实行这里就是个圆，所以骨架也画圆 */}
      <SkeletonBar width={TASK_RING_SIZE} height={TASK_RING_SIZE} delay={delay} />
      <View style={taskStyles.body}>
        <View style={taskStyles.titleLine}>
          <SkeletonBar width={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} height={13} delay={delay} />
        </View>
        <View style={taskStyles.subtitleLine}>
          <SkeletonBar width={104} height={10} delay={delay} />
        </View>
      </View>
    </View>
  );
}

/** 段标题占位（"今日 N 个任务" / "对话"）。右侧留出筛选按钮的 40x40，行高才跟真实段头一致。 */
function SectionHeaderSkeleton({ index }: { index: number }) {
  return (
    <View style={sectionStyles.row}>
      <SkeletonBar width={96} height={12} delay={index * ROW_STAGGER_MS} />
      <View style={sectionStyles.btnSpacer} />
    </View>
  );
}

/**
 * 今日页**整个内容区**的骨架：段头 + 任务行 + 段头 + 对话行。
 *
 * 为什么需要它：今日页在 `isLoadingTasks && todayTasks.length === 0` 时整块内容区被一个
 * 大菊花占着，对话段（连同它自己的骨架）在 ListFooterComponent 里根本没挂载 —— 所以
 * 冷启动时用户看到的是「header + 全屏菊花 → 直接真内容」，对话骨架一帧都轮不到。
 * 这里把那个菊花换成整页骨架，覆盖任务与对话两段。
 *
 * paddingTop 传 headerHeight + 8，跟真实列表的 contentContainerStyle 对齐，
 * 骨架被真内容替换时第一行不会上下跳。
 */
export function TodayContentSkeleton({
  paddingTop,
  taskRows = 4,
  convRows = 3,
}: {
  paddingTop: number;
  taskRows?: number;
  convRows?: number;
}) {
  return (
    <View style={[todayStyles.wrap, { paddingTop }]} accessible accessibilityLabel="正在加载今日内容">
      <SectionHeaderSkeleton index={0} />
      {Array.from({ length: taskRows }, (_, i) => (
        <TaskRowSkeleton key={i} index={i} />
      ))}
      {/* 对话段：段头 + 若干对话行，错峰延迟接着任务段往后排 */}
      <SectionHeaderSkeleton index={taskRows} />
      <ConversationListSkeleton count={convRows} startIndex={taskRows + 1} />
    </View>
  );
}

/** 抽屉 Recents 段骨架。几何对齐 DrawerContent 的 MenuRow（paddingVertical 12 /
 *  paddingHorizontal 12 / 单行 label / 无分割线），外层 marginTop 2 对齐 menuGroup。 */
export function DrawerRecentsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <View style={drawerStyles.group} accessible accessibilityLabel="正在加载最近对话">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={drawerStyles.row}>
          <View style={drawerStyles.labelLine}>
            <SkeletonBar
              width={TITLE_WIDTHS[i % TITLE_WIDTHS.length]}
              height={13}
              delay={i * ROW_STAGGER_MS}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { overflow: 'hidden' },
  /** 扫光层：left 定死、宽度由 animated style 给（不能用 absoluteFill，那会把 right 也钉住）。 */
  sheen: { position: 'absolute', top: 0, bottom: 0, left: 0 },
});

function createConvStyles(c: AppColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 18,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.conversationListSeparator,
    },
    main: { flex: 1, minWidth: 0 },
    /** 行盒高度写死 = 真实 Text 的自然行高，条本身比行盒矮一点（跟字形高度接近） */
    titleLine: { height: TITLE_LINE_H, justifyContent: 'center' },
    metaLine: { height: META_LINE_H, marginTop: 2, justifyContent: 'center' },
    /** = ConversationRow 右侧 Ionicons chevron-forward 的 size */
    chevronSpacer: { width: 18 },
  });
}

/* 下面几张表都不吃主题色（灰块颜色在 SkeletonBar 里拿），所以是模块级常量表。 */

/** 抽屉 Recents：对齐 DrawerContent 的 MenuRow + menuGroup。 */
const drawerStyles = StyleSheet.create({
  group: { marginTop: 2 },
  row: { paddingVertical: 12, paddingHorizontal: 12 },
  labelLine: { height: TITLE_LINE_H, justifyContent: 'center' },
});

/** 任务行：对齐 TaskRowContent 的 row / body / title / subtitle。 */
const taskStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TASK_ROW_MIN_HEIGHT,
    paddingVertical: TASK_ROW_PADDING_VERTICAL,
    paddingLeft: 18,
    paddingRight: TASK_ROW_PADDING_RIGHT,
    gap: 12,
  },
  body: { flex: 1, minWidth: 0 },
  titleLine: { height: TITLE_LINE_H, justifyContent: 'center' },
  subtitleLine: { height: TASK_SUB_LINE_H, marginTop: 2, justifyContent: 'center' },
});

/** 段标题行：对齐 TodayScreen 的 sectionRow（marginVertical 8 / paddingHorizontal 18）。 */
const sectionStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: SECTION_ROW_H,
    marginVertical: 8,
    paddingHorizontal: 18,
  },
  /** 真实段头右侧那颗筛选按钮（padding 10 包 20pt 图标）占的位 */
  btnSpacer: { width: 40, height: 40 },
});

const todayStyles = StyleSheet.create({
  wrap: { flex: 1 },
});
