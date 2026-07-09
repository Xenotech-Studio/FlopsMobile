/**
 * CalendarView —— 日历视图（P2）。
 *
 * 按一个 date/datetime 字段落日（view.config 指定或自动挑第一个）；月网格 + 选中日的事件列表
 * （移动端标准做法：网格给概览，下方列表可完整访问当天所有记录）。点事件 → onRowPress 编辑。
 * 数据/实时走 useTableRows（全量 + WS）。
 */
import React, { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { Field, RowRecord, View as FbView } from '../types';
import { useTableRows } from '../hooks/useTableRows';
import { formatValue } from '../fields/formatValue';
import type { TableViewHandle } from './viewHandle';

export type CalendarViewProps = {
  baseId: string;
  tableId: string;
  schema: Field[];
  view?: FbView | null;
  onRowPress: (row: RowRecord) => void;
  onSchemaChanged?: (schema: Field[]) => void;
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTH_LABEL = (y: number, m: number) => `${y} 年 ${m + 1} 月`;
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

function pickDateField(schema: Field[], view?: FbView | null): Field | null {
  const cfg = (view?.config || {}) as Record<string, unknown>;
  const ids = [cfg.date_field, cfg.dateFieldId, cfg.start_field, cfg.startFieldId].filter(
    (x): x is string => typeof x === 'string',
  );
  for (const id of ids) {
    const f = schema.find((s) => s.id === id);
    if (f) return f;
  }
  return schema.find((f) => f.type === 'date' || f.type === 'datetime') || null;
}

/** 把一行的日期字段值归一到 'YYYY-MM-DD'。 */
function dayKey(field: Field, value: unknown): string | null {
  if (value == null || value === '') return null;
  const s = String(value);
  if (field.type === 'date') return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return keyOf(d.getFullYear(), d.getMonth(), d.getDate());
}

export const CalendarView = forwardRef<TableViewHandle, CalendarViewProps>(function CalendarView(
  { baseId, tableId, schema, view, onRowPress, onSchemaChanged },
  ref,
) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const { rows, loading, error, presenceByRow, applyRowUpdate, prependRow, removeRow, setLocalPresence } =
    useTableRows(baseId, tableId, { schema, onSchemaChanged });

  useImperativeHandle(ref, () => ({ applyRowUpdate, prependRow, removeRow, setLocalPresence }), [
    applyRowUpdate,
    prependRow,
    removeRow,
    setLocalPresence,
  ]);

  const dateField = useMemo(() => pickDateField(schema, view), [schema, view]);
  const titleField = useMemo(
    () => schema.find((f) => f.id !== dateField?.id) ?? schema[0],
    [schema, dateField],
  );

  const [{ y, m }, setMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [selected, setSelected] = useState(() => {
    const d = new Date();
    return keyOf(d.getFullYear(), d.getMonth(), d.getDate());
  });
  const todayKey = useMemo(() => {
    const d = new Date();
    return keyOf(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);

  const byDay = useMemo(() => {
    const map = new Map<string, RowRecord[]>();
    if (!dateField) return map;
    for (const r of rows) {
      const k = dayKey(dateField, r.data[dateField.id]);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return map;
  }, [rows, dateField]);

  const cells = useMemo(() => {
    const startWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const weeks = Math.ceil((startWeekday + daysInMonth) / 7);
    const out: Array<{ day: number; key: string } | null> = [];
    for (let i = 0; i < weeks * 7; i++) {
      const day = i - startWeekday + 1;
      out.push(day >= 1 && day <= daysInMonth ? { day, key: keyOf(y, m, day) } : null);
    }
    return out;
  }, [y, m]);

  const gotoPrev = () => setMonth((p) => (p.m === 0 ? { y: p.y - 1, m: 11 } : { y: p.y, m: p.m - 1 }));
  const gotoNext = () => setMonth((p) => (p.m === 11 ? { y: p.y + 1, m: 0 } : { y: p.y, m: p.m + 1 }));

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.hint}>{error}</Text>
      </View>
    );
  }
  if (!dateField) {
    return (
      <View style={styles.centered}>
        <Text style={styles.hint}>没有日期字段（日历需要 date / datetime 字段）</Text>
      </View>
    );
  }

  const dayEvents = byDay.get(selected) ?? [];

  return (
    <View style={styles.root}>
      {/* 月导航 */}
      <View style={styles.monthBar}>
        <TouchableOpacity onPress={gotoPrev} style={styles.navBtn} activeOpacity={0.7}>
          <Text style={styles.navText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.monthLabel}>{MONTH_LABEL(y, m)}</Text>
        <TouchableOpacity onPress={gotoNext} style={styles.navBtn} activeOpacity={0.7}>
          <Text style={styles.navText}>›</Text>
        </TouchableOpacity>
      </View>

      {/* 星期表头 */}
      <View style={styles.weekRow}>
        {WEEKDAYS.map((w) => (
          <Text key={w} style={styles.weekday}>
            {w}
          </Text>
        ))}
      </View>

      {/* 日网格 */}
      <View style={styles.grid}>
        {cells.map((cell, i) => {
          if (!cell) return <View key={`b${i}`} style={styles.cell} />;
          const count = byDay.get(cell.key)?.length ?? 0;
          const isSel = cell.key === selected;
          const isToday = cell.key === todayKey;
          return (
            <TouchableOpacity
              key={cell.key}
              style={styles.cell}
              activeOpacity={0.7}
              onPress={() => setSelected(cell.key)}
            >
              <View style={[styles.dayCircle, isSel && styles.daySelected]}>
                <Text style={[styles.dayNum, isSel && styles.dayNumSelected, isToday && !isSel && styles.dayToday]}>
                  {cell.day}
                </Text>
              </View>
              {count > 0 ? <View style={[styles.eventDot, isSel && styles.eventDotSelected]} /> : <View style={styles.dotSpacer} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* 选中日事件列表 */}
      <View style={styles.listHeaderRow}>
        <Text style={styles.listHeader}>{selected}</Text>
        <Text style={styles.listCount}>{dayEvents.length} 条</Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {dayEvents.length === 0 ? (
          <Text style={styles.emptyDay}>这天没有记录</Text>
        ) : (
          dayEvents.map((r) => {
            const pres = presenceByRow[r.row_id];
            const barColor = pres && pres.length ? pres[0].color : null;
            return (
              <TouchableOpacity
                key={r.row_id}
                style={styles.eventCard}
                activeOpacity={0.7}
                onPress={() => onRowPress(r)}
              >
                {barColor ? <View style={[styles.presenceBar, { backgroundColor: barColor }]} /> : null}
                <Text style={styles.eventTitle} numberOfLines={1}>
                  {(titleField && formatValue(titleField, r.data[titleField.id])) || '未命名'}
                </Text>
                <Text style={styles.eventTime}>{formatValue(dateField, r.data[dateField.id])}</Text>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );
});

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    monthBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    navBtn: { paddingHorizontal: 16, paddingVertical: 4 },
    navText: { fontSize: 24, color: c.textPrimary, fontWeight: '400' },
    monthLabel: { fontSize: 16, fontWeight: '700', color: c.textHeader },
    weekRow: { flexDirection: 'row', paddingHorizontal: 8 },
    weekday: { flex: 1, textAlign: 'center', fontSize: 11, color: c.textMuted, paddingVertical: 6 },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      paddingBottom: 6,
    },
    cell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 3 },
    dayCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    daySelected: { backgroundColor: c.primary },
    dayNum: { fontSize: 14, color: c.textPrimary },
    dayNumSelected: { color: c.onPrimary, fontWeight: '700' },
    dayToday: { color: c.primary, fontWeight: '700' },
    eventDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.primary, marginTop: 2 },
    eventDotSelected: { backgroundColor: c.primary },
    dotSpacer: { height: 7, marginTop: 2 },
    listHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 8,
    },
    listHeader: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    listCount: { fontSize: 12, color: c.textMuted },
    list: { flex: 1 },
    listContent: { paddingHorizontal: 16, paddingBottom: 48, gap: 8 },
    emptyDay: { fontSize: 13, color: c.placeholder, textAlign: 'center', paddingVertical: 24 },
    eventCard: {
      backgroundColor: c.surface,
      borderRadius: 10,
      padding: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderSubtle,
      overflow: 'hidden',
    },
    presenceBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
    eventTitle: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    eventTime: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    hint: { fontSize: 13, color: c.placeholder, textAlign: 'center' },
  });
}
