/**
 * 自研 SVG 图表（bar / line / pie），基于 react-native-svg。ECharts 无原生版，仪表盘只需三种图，
 * 自绘一薄层足矣（延续 TaskFlowChartView 先例）。图表为纯渲染：接归一化的 series/slices + 尺寸。
 */
import React from 'react';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

export type Series = { name: string; color: string; values: Array<number | null> };
export type PieSlice = { name: string; value: number; color: string };

const AXIS = '#e4e7ec';
const LABEL = '#98a2b3';
const PAD = { l: 40, r: 10, t: 10, b: 34 };

/** 5 档「好看」刻度上界。 */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function axisBounds(series: Series[]) {
  let max = 0;
  let min = 0;
  for (const s of series)
    for (const v of s.values) {
      if (v == null || !Number.isFinite(v)) continue;
      if (v > max) max = v;
      if (v < min) min = v;
    }
  const top = niceMax(max || 1);
  const bottom = min < 0 ? -niceMax(-min) : 0;
  return { top, bottom: bottom === top ? top - 1 : bottom };
}

function AxisFrame({
  width,
  height,
  categories,
  top,
  bottom,
  yOf,
}: {
  width: number;
  height: number;
  categories: string[];
  top: number;
  bottom: number;
  yOf: (v: number) => number;
  plotW: number;
}) {
  const ticks = 4;
  const rotate = categories.length > 6;
  return (
    <>
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const val = bottom + ((top - bottom) * i) / ticks;
        const y = yOf(val);
        return (
          <G key={i}>
            <Line x1={PAD.l} y1={y} x2={width - PAD.r} y2={y} stroke={AXIS} strokeWidth={0.5} />
            <SvgText x={PAD.l - 4} y={y + 3} fontSize={9} fill={LABEL} textAnchor="end">
              {fmtTick(val)}
            </SvgText>
          </G>
        );
      })}
      {categories.map((c, i) => {
        const cw = (width - PAD.l - PAD.r) / categories.length;
        const x = PAD.l + cw * (i + 0.5);
        return (
          <SvgText
            key={i}
            x={x}
            y={height - PAD.b + 12}
            fontSize={9}
            fill={LABEL}
            textAnchor={rotate ? 'end' : 'middle'}
            transform={rotate ? `rotate(-30 ${x} ${height - PAD.b + 12})` : undefined}
          >
            {c.length > 8 ? c.slice(0, 8) + '…' : c}
          </SvgText>
        );
      })}
    </>
  );
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000000) return (v / 1000000).toFixed(a % 1000000 ? 1 : 0) + 'M';
  if (a >= 1000) return (v / 1000).toFixed(a % 1000 ? 1 : 0) + 'k';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

export function BarChart({
  categories,
  series,
  width,
  height,
}: {
  categories: string[];
  series: Series[];
  width: number;
  height: number;
}) {
  const { top, bottom } = axisBounds(series);
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const yOf = (v: number) => PAD.t + plotH * (1 - (v - bottom) / (top - bottom));
  const cw = plotW / Math.max(1, categories.length);
  const groupW = cw * 0.7;
  const barW = groupW / Math.max(1, series.length);
  const y0 = yOf(0);

  return (
    <Svg width={width} height={height}>
      <AxisFrame {...{ width, height, categories, top, bottom, yOf, plotW }} />
      {categories.map((_, ci) => {
        const center = PAD.l + cw * (ci + 0.5);
        return series.map((s, si) => {
          const v = s.values[ci];
          if (v == null || !Number.isFinite(v)) return null;
          const y = yOf(v);
          const x = center - groupW / 2 + si * barW;
          return (
            <Rect
              key={`${ci}-${si}`}
              x={x + 1}
              y={Math.min(y, y0)}
              width={Math.max(1, barW - 2)}
              height={Math.max(1, Math.abs(y - y0))}
              fill={s.color}
              rx={1.5}
            />
          );
        });
      })}
    </Svg>
  );
}

export function LineChart({
  categories,
  series,
  width,
  height,
  connectNulls = false,
}: {
  categories: string[];
  series: Series[];
  width: number;
  height: number;
  connectNulls?: boolean;
}) {
  const { top, bottom } = axisBounds(series);
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const yOf = (v: number) => PAD.t + plotH * (1 - (v - bottom) / (top - bottom));
  const cw = plotW / Math.max(1, categories.length);
  const xOf = (i: number) => PAD.l + cw * (i + 0.5);

  return (
    <Svg width={width} height={height}>
      <AxisFrame {...{ width, height, categories, top, bottom, yOf, plotW }} />
      {series.map((s, si) => {
        // 按 null 断段（connectNulls 时跳过 null 连相邻点）
        const segments: Array<Array<{ x: number; y: number }>> = [];
        let cur: Array<{ x: number; y: number }> = [];
        s.values.forEach((v, i) => {
          if (v == null || !Number.isFinite(v)) {
            if (!connectNulls && cur.length) {
              segments.push(cur);
              cur = [];
            }
            return;
          }
          cur.push({ x: xOf(i), y: yOf(v) });
        });
        if (cur.length) segments.push(cur);
        return (
          <G key={si}>
            {segments.map((seg, gi) => (
              <Path
                key={gi}
                d={seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')}
                stroke={s.color}
                strokeWidth={2}
                fill="none"
              />
            ))}
            {segments.flat().map((p, i) => (
              <Circle key={i} cx={p.x} cy={p.y} r={2.5} fill={s.color} />
            ))}
          </G>
        );
      })}
    </Svg>
  );
}

function arcPath(cx: number, cy: number, rO: number, rI: number, a0: number, a1: number): string {
  const pt = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${pt(rO, a0)} A ${rO} ${rO} 0 ${large} 1 ${pt(rO, a1)} L ${pt(rI, a1)} A ${rI} ${rI} 0 ${large} 0 ${pt(rI, a0)} Z`;
}

export function PieChart({
  slices,
  width,
  height,
}: {
  slices: PieSlice[];
  width: number;
  height: number;
}) {
  const total = slices.reduce((a, s) => a + (s.value > 0 ? s.value : 0), 0);
  const cx = width / 2;
  const cy = height / 2;
  const rO = Math.min(width, height) / 2 - 6;
  const rI = rO * 0.58;
  if (total <= 0) return <Svg width={width} height={height} />;

  const positive = slices.filter((s) => s.value > 0);
  // 单一分片（占满整圆）：A 命令画不出满圆 → 用同心环表达。
  if (positive.length === 1) {
    return (
      <Svg width={width} height={height}>
        <Circle cx={cx} cy={cy} r={(rO + rI) / 2} stroke={positive[0].color} strokeWidth={rO - rI} fill="none" />
      </Svg>
    );
  }

  let angle = -Math.PI / 2;
  return (
    <Svg width={width} height={height}>
      {positive.map((s, i) => {
        const a0 = angle;
        const a1 = angle + (s.value / total) * Math.PI * 2;
        angle = a1;
        return <Path key={i} d={arcPath(cx, cy, rO, rI, a0, a1)} fill={s.color} />;
      })}
    </Svg>
  );
}
