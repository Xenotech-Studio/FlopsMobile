/**
 * RecordSheet —— 记录卡片编辑器（P1 的编辑中枢）。
 *
 * 移动端不做桌面式内联单元格编辑：点行 → 底部卡片，按 schema 逐字段编辑。
 * 保存走 updateRow（CAS，带 base_version）或 insertRows；formula/link 只读。
 * 命中 409 version_conflict：把草稿 rebase 到服务端最新并提示，同时通知上层更新网格。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { shadowSheet } from '../../theme/shadows';
import { deleteRows, insertRows, isVersionConflict, updateRow } from '../api';
import type { Field, RowRecord } from '../types';
import { choiceOptions } from '../fields/formatValue';
import { FB_ROW_HEIGHT } from '../constants';

export type RecordSheetProps = {
  baseId: string;
  tableId: string;
  schema: Field[];
  /** 编辑的行；null = 新建。 */
  row: RowRecord | null;
  visible: boolean;
  onClose: () => void;
  onSaved: (row: RowRecord, isNew: boolean) => void;
  onDeleted: (rowId: string) => void;
};

const READONLY_TYPES = new Set<Field['type']>(['formula', 'link']);

export function RecordSheet({
  baseId,
  tableId,
  schema,
  row,
  visible,
  onClose,
  onSaved,
  onDeleted,
}: RecordSheetProps) {
  const modalRef = useRef<BottomSheetModal>(null);
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const isNew = row == null;
  const rowKey = row?.row_id ?? '__new__';

  // draft：number 以字符串暂存（保留编辑态），保存时再 coerce。
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const initDraft = useCallback(() => {
    const d: Record<string, unknown> = {};
    for (const f of schema) {
      const v = row?.data[f.id];
      if (f.type === 'number') d[f.id] = v == null ? '' : String(v);
      else if (f.type === 'checkbox') d[f.id] = !!v;
      else if (f.type === 'multi_select') d[f.id] = Array.isArray(v) ? v.map(String) : [];
      else d[f.id] = v == null ? '' : String(v);
    }
    setDraft(d);
    setConflict(false);
  }, [schema, row]);

  useEffect(() => {
    if (visible) {
      initDraft();
      modalRef.current?.present();
    } else {
      modalRef.current?.dismiss();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rowKey]);

  const setField = useCallback((id: string, v: unknown) => {
    setDraft((prev) => ({ ...prev, [id]: v }));
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={colors.bottomSheetBackdropOpacity}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    [colors.bottomSheetBackdropOpacity],
  );

  const onChange = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose],
  );

  /** 把某字段草稿 coerce 为发送值（null 表示清空）。 */
  const coerce = useCallback((f: Field, raw: unknown): unknown => {
    switch (f.type) {
      case 'number': {
        const s = String(raw ?? '').trim();
        if (s === '') return null;
        const n = Number(s);
        return Number.isNaN(n) ? null : n;
      }
      case 'checkbox':
        return !!raw;
      case 'multi_select':
        return Array.isArray(raw) ? raw : [];
      default: {
        const s = String(raw ?? '');
        return s === '' ? null : s;
      }
    }
  }, []);

  const save = useCallback(async () => {
    if (!session || saving) return;
    setSaving(true);
    try {
      if (isNew) {
        const values: Record<string, unknown> = {};
        for (const f of schema) {
          if (READONLY_TYPES.has(f.type)) continue;
          const v = coerce(f, draft[f.id]);
          if (v != null && !(Array.isArray(v) && v.length === 0)) values[f.id] = v;
        }
        const { rowIds } = await insertRows(session, baseId, tableId, [values]);
        const newRow: RowRecord = { row_id: rowIds[0], data: values, version: 0 };
        onSaved(newRow, true);
        onClose();
      } else {
        // 只发改动过的字段
        const values: Record<string, unknown> = {};
        for (const f of schema) {
          if (READONLY_TYPES.has(f.type)) continue;
          const v = coerce(f, draft[f.id]);
          const orig = row!.data[f.id] ?? null;
          if (JSON.stringify(v) !== JSON.stringify(orig)) values[f.id] = v;
        }
        if (Object.keys(values).length === 0) {
          onClose();
          return;
        }
        const res = await updateRow(session, baseId, tableId, row!.row_id, values, row!.version);
        onSaved({ row_id: res.rowId, data: res.data, version: res.version }, false);
        onClose();
      }
    } catch (e) {
      if (isVersionConflict(e)) {
        // rebase 到服务端最新，通知上层更新网格，保持编辑态
        const cd = e.body.current_data;
        const cv = e.body.current_version;
        onSaved({ row_id: row!.row_id, data: cd, version: cv }, false);
        const d: Record<string, unknown> = {};
        for (const f of schema) {
          const v = cd[f.id];
          if (f.type === 'number') d[f.id] = v == null ? '' : String(v);
          else if (f.type === 'checkbox') d[f.id] = !!v;
          else if (f.type === 'multi_select') d[f.id] = Array.isArray(v) ? v.map(String) : [];
          else d[f.id] = v == null ? '' : String(v);
        }
        setDraft(d);
        setConflict(true);
      } else {
        Alert.alert('保存失败', e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }, [session, saving, isNew, schema, draft, baseId, tableId, row, coerce, onSaved, onClose]);

  const confirmDelete = useCallback(() => {
    if (!session || isNew || !row) return;
    Alert.alert('删除记录', '确定删除这条记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRows(session, baseId, tableId, [row.row_id]);
            onDeleted(row.row_id);
            onClose();
          } catch (e) {
            Alert.alert('删除失败', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  }, [session, isNew, row, baseId, tableId, onDeleted, onClose]);

  return (
    <BottomSheetModal
      ref={modalRef}
      snapPoints={['70%', '95%']}
      index={0}
      onChange={onChange}
      onDismiss={onClose}
      enablePanDownToClose
      enableDynamicSizing={false}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backdropComponent={renderBackdrop}
      backgroundStyle={[styles.sheetBg, styles.sheetShadow]}
      handleIndicatorStyle={styles.handle}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.hBtn} activeOpacity={0.7}>
          <Text style={styles.cancel}>取消</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{isNew ? '新建记录' : '编辑记录'}</Text>
        <TouchableOpacity onPress={save} style={styles.hBtn} activeOpacity={0.7} disabled={saving}>
          <Text style={[styles.save, saving && styles.disabled]}>{saving ? '保存中' : '保存'}</Text>
        </TouchableOpacity>
      </View>

      {conflict ? (
        <View style={styles.conflictBar}>
          <Text style={styles.conflictText}>记录已被他人修改，已刷新为最新，请确认后再保存</Text>
        </View>
      ) : null}

      <BottomSheetScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {schema.map((f) => (
          <View key={f.id} style={styles.fieldBlock}>
            <Text style={styles.label}>{f.name}</Text>
            <FieldEditor field={f} value={draft[f.id]} onChange={(v) => setField(f.id, v)} colors={colors} />
          </View>
        ))}

        {!isNew ? (
          <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete} activeOpacity={0.7}>
            <Text style={styles.deleteText}>删除记录</Text>
          </TouchableOpacity>
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

function FieldEditor({
  field,
  value,
  onChange,
  colors,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  colors: AppColors;
}) {
  const styles = createStyles(colors);

  if (field.type === 'formula' || field.type === 'link') {
    const txt =
      field.type === 'link'
        ? value
          ? String(value)
          : ''
        : value != null
          ? String(value)
          : '';
    return (
      <View style={styles.readonlyBox}>
        <Text style={styles.readonlyText}>{txt || '—'}</Text>
        <Text style={styles.readonlyTag}>{field.type === 'formula' ? '公式（只读）' : '关联（暂只读）'}</Text>
      </View>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <Switch
        value={!!value}
        onValueChange={onChange}
        trackColor={{ true: colors.primary, false: colors.borderD5 }}
      />
    );
  }

  if (field.type === 'select') {
    const opts = choiceOptions(field);
    const cur = value ? String(value) : '';
    return (
      <View style={styles.chips}>
        {opts.map((o) => {
          const active = o.value === cur;
          return (
            <TouchableOpacity
              key={o.value}
              style={[styles.optChip, active && styles.optChipActive]}
              onPress={() => onChange(active ? '' : o.value)}
              activeOpacity={0.7}
            >
              <Text style={[styles.optChipText, active && styles.optChipTextActive]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
        {opts.length === 0 ? <Text style={styles.emptyOpt}>无预设选项</Text> : null}
      </View>
    );
  }

  if (field.type === 'multi_select') {
    const opts = choiceOptions(field);
    const cur = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (v: string) =>
      onChange(cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
    return (
      <View style={styles.chips}>
        {opts.map((o) => {
          const active = cur.includes(o.value);
          return (
            <TouchableOpacity
              key={o.value}
              style={[styles.optChip, active && styles.optChipActive]}
              onPress={() => toggle(o.value)}
              activeOpacity={0.7}
            >
              <Text style={[styles.optChipText, active && styles.optChipTextActive]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
        {opts.length === 0 ? <Text style={styles.emptyOpt}>无预设选项</Text> : null}
      </View>
    );
  }

  // text / long_text / number / url / email / date / datetime
  const multiline = field.type === 'long_text';
  const keyboardType =
    field.type === 'number' ? 'numbers-and-punctuation' : field.type === 'email' ? 'email-address' : 'default';
  const placeholder =
    field.type === 'date' ? 'YYYY-MM-DD' : field.type === 'datetime' ? 'YYYY-MM-DDTHH:mm' : '';
  return (
    <BottomSheetTextInput
      style={[styles.input, multiline && styles.inputMultiline]}
      value={value == null ? '' : String(value)}
      onChangeText={onChange}
      multiline={multiline}
      keyboardType={keyboardType as never}
      placeholder={placeholder}
      placeholderTextColor={colors.placeholder}
      autoCapitalize={field.type === 'email' || field.type === 'url' ? 'none' : 'sentences'}
    />
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    sheetBg: { backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
    sheetShadow: { ...shadowSheet },
    handle: { backgroundColor: c.borderD5, width: 36 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingTop: 6,
      paddingBottom: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    hBtn: {
      height: FB_ROW_HEIGHT,
      justifyContent: 'center',
      paddingHorizontal: 8,
      minWidth: 60,
    },
    title: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    cancel: { fontSize: 15, color: c.textMuted },
    save: { fontSize: 15, fontWeight: '600', color: c.primary, textAlign: 'right' },
    disabled: { opacity: 0.5 },
    conflictBar: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: c.roseBg },
    conflictText: { fontSize: 12, color: c.danger },
    content: { padding: 16, paddingBottom: 64 },
    fieldBlock: { marginBottom: 18 },
    label: { fontSize: 12, fontWeight: '600', color: c.textMuted, marginBottom: 8 },
    input: {
      borderWidth: 1,
      borderColor: c.borderSubtle,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: c.textPrimary,
      backgroundColor: c.background,
    },
    inputMultiline: { minHeight: 80, textAlignVertical: 'top' },
    readonlyBox: {
      borderWidth: 1,
      borderColor: c.borderSubtle,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: c.surfaceMuted,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    readonlyText: { fontSize: 15, color: c.textMuted, flexShrink: 1, marginRight: 8 },
    readonlyTag: { fontSize: 11, color: c.placeholder },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    optChip: {
      paddingVertical: 7,
      paddingHorizontal: 14,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.borderSubtle,
      backgroundColor: c.surface,
    },
    optChipActive: { backgroundColor: c.primary, borderColor: c.primary },
    optChipText: { fontSize: 13, color: c.textSecondary },
    optChipTextActive: { color: c.onPrimary, fontWeight: '600' },
    emptyOpt: { fontSize: 12, color: c.placeholder },
    deleteBtn: {
      marginTop: 8,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: c.errorBg,
    },
    deleteText: { fontSize: 14, fontWeight: '600', color: c.danger },
  });
}
