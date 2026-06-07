/**
 * DividerHandle —— 骑在两栏分界线上的纵向胶囊切换手柄（共享视觉 + 常量）。
 *
 * 视觉 = AnimatedCircleButton 玻璃胶囊（iOS 26+ Liquid Glass material / iOS<26·Android bouncy
 *   fallback）+ 三横线图标，窄而高、上下半圆。两处用它：
 *     1) DrawerShell：全局菜单侧栏 ↔ 主区 分界线（绑 sidebarAnimWidth）。
 *     2) DocsScreen（iPad）：文档目录树 ↔ 文档预览 分界线（绑 treeW）。
 *
 * 复用边界：本组件只管「胶囊视觉 + tap」。外层「绝对定位容器(left 动画跟某条线走) + 拖动手势
 *   GestureDetector」由各站点自己包——因为它们各绑不同 shared value、各有自己的 pan 实例
 *   （GestureDetector 不能把同一 Gesture 对象挂两处）。容器/拦截带的 layout 常量与 style 也在此
 *   导出，保证两端尺寸/位置公式一致。
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { AnimatedCircleButton } from '../../components/AnimatedCircleButton';

/** 纵向胶囊（窄而高）。展开时骑在分界线上；折叠时离屏左缘 DIVIDER_TOGGLE_MARGIN 完整显示。 */
export const DIVIDER_TOGGLE_W = 26;
export const DIVIDER_TOGGLE_H = 56;
export const DIVIDER_TOGGLE_MARGIN = 12;

/** 拖动拦截带：在手柄那段高度覆盖返回手势触发区，吃掉这段 Y 的横向拖（区域划分，无时序竞争）。
 *  带要从分界线左边一点盖到右边 > 50pt（返回手势触发区）。总宽 = LEFT + RIGHT。 */
export const EDGE_INTERCEPT_H = DIVIDER_TOGGLE_H + 48;
export const EDGE_INTERCEPT_LEFT = 24; // 分界线左侧覆盖（含手柄左半）
export const EDGE_INTERCEPT_RIGHT = 64; // 分界线右侧覆盖（盖满返回手势触发区 ~50pt + 冗余）
export const EDGE_INTERCEPT_W = EDGE_INTERCEPT_LEFT + EDGE_INTERCEPT_RIGHT;

/** 手柄胶囊本体（不含外层定位容器/手势）。tap=onPress；拖动由外层 GestureDetector 接管。 */
export function DividerHandle({
  onPress,
  iconColor,
}: {
  onPress: () => void;
  /** 三横线图标颜色（传 theme 的 textSecondary）。 */
  iconColor: string;
}) {
  return (
    <AnimatedCircleButton
      style={dividerHandleStyles.dividerToggleBtn}
      onPress={onPress}
      /* 触摸响应区比视觉胶囊大不少（不改显示尺寸）：四周各扩 28pt，窄胶囊也好点中、好拖。 */
      hitSlop={{ top: 28, bottom: 28, left: 28, right: 28 }}
      iosSfSymbol={{
        /* 三横线（菜单）图标，小一号。 */
        name: 'line.3.horizontal',
        size: 11,
        color: iconColor,
      }}
    >
      {/* iOS<26 / Android fallback：reorder-three 比 menu 三横线更窄。 */}
      <Ionicons name="reorder-three" size={15} color={iconColor} />
    </AnimatedCircleButton>
  );
}

export const dividerHandleStyles = StyleSheet.create({
  /** 手柄容器：绝对定位，left 由各站点的 animated style 驱动；纵向居中。zIndex 盖在两栏之上。 */
  dividerToggle: {
    position: 'absolute',
    top: '50%',
    marginTop: -DIVIDER_TOGGLE_H / 2,
    zIndex: 100,
  },
  /** 纵向胶囊本体：窄而高，borderRadius = 半宽 → 上下半圆胶囊形。 */
  dividerToggleBtn: {
    width: DIVIDER_TOGGLE_W,
    height: DIVIDER_TOGGLE_H,
    borderRadius: DIVIDER_TOGGLE_W / 2,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 拖动拦截带：手柄那段高度（竖直居中）、以分界线为中心的横向带，透明，承载各站点的拦截 pan。 */
  edgeIntercept: {
    position: 'absolute',
    top: '50%',
    marginTop: -EDGE_INTERCEPT_H / 2,
    width: EDGE_INTERCEPT_W,
    height: EDGE_INTERCEPT_H,
    zIndex: 99,
  },
});
