/**
 * 只读单元格内容渲染（网格 & 记录卡片摘要复用）。
 * 只负责「内容」，外层宽/高/边框由 GridView 控制，保证行高固定、frozen 列对齐。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AppColors } from '../../theme/appColors';
import type { Field } from '../types';
import { formatValue, selectChoiceColor } from './formatValue';

export function CellContent({
  field,
  value,
  colors,
}: {
  field: Field;
  value: unknown;
  colors: AppColors;
}) {
  const styles = getStyles(colors);

  if (field.type === 'checkbox') {
    return (
      <View style={styles.center}>
        <Text style={[styles.checkbox, value ? styles.checkboxOn : styles.checkboxOff]}>
          {value ? '✓' : ''}
        </Text>
      </View>
    );
  }

  if (field.type === 'select') {
    const v = value == null || value === '' ? '' : String(value);
    if (!v) return <View style={styles.center} />;
    const bg = selectChoiceColor(field, v) || colors.surfaceMuted;
    return (
      <View style={styles.chipWrap}>
        <View style={[styles.chip, { backgroundColor: bg }]}>
          <Text style={styles.chipText} numberOfLines={1}>
            {v}
          </Text>
        </View>
      </View>
    );
  }

  const text = formatValue(field, value);
  const numeric = field.type === 'number';
  const muted = field.type === 'formula';
  return (
    <Text
      style={[styles.text, numeric && styles.numeric, muted && styles.muted]}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}

function getStyles(c: AppColors) {
  return StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    text: { fontSize: 13, color: c.textPrimary },
    numeric: { textAlign: 'right' },
    muted: { color: c.textMuted },
    checkbox: { fontSize: 14, fontWeight: '700' },
    checkboxOn: { color: c.primary },
    checkboxOff: { color: c.placeholder },
    chipWrap: { flexDirection: 'row', alignItems: 'center' },
    chip: {
      paddingVertical: 2,
      paddingHorizontal: 8,
      borderRadius: 8,
      maxWidth: '100%',
    },
    chipText: { fontSize: 12, color: c.textPrimary },
  });
}
