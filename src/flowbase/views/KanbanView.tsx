/**
 * KanbanView —— 看板视图（P2）。
 *
 * 按一个「单选/文本」字段分组成列（view.config 指定或自动挑第一个 select/text）；列内卡片展示
 * 标题 + 若干摘要字段 + presence 彩条。点卡片 → onRowPress 开 RecordSheet 编辑（改分组字段即换列）。
 * 数据/实时走 useTableRows（全量 + WS）。P2 暂不做拖拽换列（改组经记录卡片完成）。
 */
import React, { forwardRef, useImperativeHandle, useMemo } from 'react';
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
import { choiceOptions, formatValue } from '../fields/formatValue';
import type { TableViewHandle } from './viewHandle';

export type KanbanViewProps = {
  baseId: string;
  tableId: string;
  schema: Field[];
  view?: FbView | null;
  onRowPress: (row: RowRecord) => void;
  onSchemaChanged?: (schema: Field[]) => void;
};

const COL_W = 264;

function pickGroupField(schema: Field[], view?: FbView | null): Field | null {
  const cfg = (view?.config || {}) as Record<string, unknown>;
  const candidateIds = [cfg.group_field, cfg.groupFieldId, cfg.stack_field, cfg.stackFieldId]
    .filter((x): x is string => typeof x === 'string');
  for (const id of candidateIds) {
    const f = schema.find((s) => s.id === id);
    if (f) return f;
  }
  return schema.find((f) => f.type === 'select') || schema.find((f) => f.type === 'text') || null;
}

export const KanbanView = forwardRef<TableViewHandle, KanbanViewProps>(function KanbanView(
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

  const groupField = useMemo(() => pickGroupField(schema, view), [schema, view]);

  const titleField = useMemo(
    () => schema.find((f) => f.id !== groupField?.id) ?? schema[0],
    [schema, groupField],
  );
  const summaryFields = useMemo(
    () => schema.filter((f) => f.id !== groupField?.id && f.id !== titleField?.id).slice(0, 3),
    [schema, groupField, titleField],
  );

  const columns = useMemo(() => {
    if (!groupField) return [];
    const map = new Map<string, RowRecord[]>();
    // 用 select 选项播种，保证空列也在、顺序稳定
    if (groupField.type === 'select') {
      for (const o of choiceOptions(groupField)) map.set(o.value, []);
    }
    for (const r of rows) {
      const raw = r.data[groupField.id];
      const key = raw == null || raw === '' ? '' : String(raw);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries()).map(([key, items]) => ({
      key,
      label: key === '' ? '未分组' : key,
      items,
    }));
  }, [rows, groupField]);

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
  if (!groupField) {
    return (
      <View style={styles.centered}>
        <Text style={styles.hint}>没有可分组的字段（看板需要单选或文本字段）</Text>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      style={styles.root}
      contentContainerStyle={styles.boardContent}
      showsHorizontalScrollIndicator={false}
    >
      {columns.map((col) => (
        <View key={col.key || '__empty__'} style={styles.column}>
          <View style={styles.colHeader}>
            <Text style={styles.colTitle} numberOfLines={1}>
              {col.label}
            </Text>
            <Text style={styles.colCount}>{col.items.length}</Text>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.colBody}>
            {col.items.map((r) => {
              const pres = presenceByRow[r.row_id];
              const barColor = pres && pres.length ? pres[0].color : null;
              return (
                <TouchableOpacity
                  key={r.row_id}
                  style={styles.card}
                  activeOpacity={0.7}
                  onPress={() => onRowPress(r)}
                >
                  {barColor ? <View style={[styles.presenceBar, { backgroundColor: barColor }]} /> : null}
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {(titleField && formatValue(titleField, r.data[titleField.id])) || '未命名'}
                  </Text>
                  {summaryFields.map((f) => {
                    const v = formatValue(f, r.data[f.id]);
                    if (!v) return null;
                    return (
                      <Text key={f.id} style={styles.cardMeta} numberOfLines={1}>
                        <Text style={styles.cardMetaLabel}>{f.name}：</Text>
                        {v}
                      </Text>
                    );
                  })}
                </TouchableOpacity>
              );
            })}
            {col.items.length === 0 ? <Text style={styles.emptyCol}>空</Text> : null}
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  );
});

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    boardContent: { padding: 12, gap: 12 },
    column: {
      width: COL_W,
      backgroundColor: c.surfaceMuted,
      borderRadius: 14,
      overflow: 'hidden',
    },
    colHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    colTitle: { fontSize: 13, fontWeight: '700', color: c.textPrimary, flexShrink: 1, marginRight: 8 },
    colCount: { fontSize: 12, color: c.textMuted },
    colBody: { paddingHorizontal: 8, paddingBottom: 12, gap: 8 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 10,
      padding: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderSubtle,
      overflow: 'hidden',
    },
    presenceBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
    cardTitle: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    cardMeta: { fontSize: 12, color: c.textMuted, marginTop: 5 },
    cardMetaLabel: { color: c.placeholder },
    emptyCol: { fontSize: 12, color: c.placeholder, textAlign: 'center', paddingVertical: 12 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    hint: { fontSize: 13, color: c.placeholder, textAlign: 'center' },
  });
}
