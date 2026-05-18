/**
 * ComposerContextRing
 *
 * 输入框旁的环形进度条：跟 FlopsWeb src/components/ComposerContextRing.jsx 对齐。
 * 默认尺寸 14×14，stroke 2，绿色背景轨 + 主色填充。
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useAppTheme } from '../../context/ThemeContext';

const VB = 16;

export type ComposerContextRingProps = {
  /** 0–100，超出范围会被 clip */
  percent: number;
  /** 显示边长（pt），默认 14 — 跟 11pt chip 文字大致同档但稍大一些避免太小看不清 */
  size?: number;
};

export function ComposerContextRing({ percent, size = 14 }: ComposerContextRingProps) {
  const { colors } = useAppTheme();
  const p = Math.min(100, Math.max(0, Number(percent) || 0));
  const stroke = 2;
  const r = (VB - stroke) / 2;
  const cx = VB / 2;
  const cy = VB / 2;
  const c = 2 * Math.PI * r;
  const dash = (p / 100) * c;

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={colors.borderMuted}
          strokeWidth={stroke}
        />
        <Circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          /** 跟 meta row chips 文字 / 统计图 icon 同 placeholder 色，整体弱化不抢戏。
           *  对齐 FlopsWeb .composer-context-ring-progress 用 text-muted。 */
          stroke={colors.placeholder}
          strokeWidth={stroke}
          strokeLinecap={p > 0.5 ? 'round' : 'butt'}
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </Svg>
    </View>
  );
}
