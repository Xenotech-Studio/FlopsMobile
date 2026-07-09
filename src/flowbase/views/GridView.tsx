/**
 * GridView —— 只读多维表格。
 *
 * 所有列统一横向滚动（移动端屏窄，不做 Desktop 那种冻结首列）+ 纵向虚拟化 + 分页；
 * WS 实时把他端变更应用到行，并按 occupantAt 画单元格级 presence 边框/角标/实时值。
 * 数据/socket 细节走共用 plumbing（applyRtChanges / useTableSocket），本组件专注布局。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  LayoutChangeEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { queryRows } from '../api';
import type { Field, FieldType, RowRecord } from '../types';
import { CellContent } from '../fields/CellRenderer';
import { FB_ROW_HEIGHT, FB_ROW_RADIUS } from '../constants';
import { applyRtChanges } from '../rt/applyChanges';
import { useTableSocket, type Collaborator } from '../rt/useTableSocket';
import type { RtChange } from '../rt/socket';
import type { TableViewHandle } from './viewHandle';

// 行 / 表头高度统一引用全局 FB_ROW_HEIGHT（chip / 按钮也用它，改一处即整体调整）。
const ROW_H = FB_ROW_HEIGHT;
const HEADER_H = FB_ROW_HEIGHT;
const PAGE = 50;
// 行号（#）列：宽度 = 内容左边距 16px，兼作左侧留白让数据列与顶部 page tab 对齐。
const INDEX_W = 17;

const TYPE_WIDTH: Partial<Record<FieldType, number>> = {
  checkbox: 64,
  number: 104,
  select: 128,
  multi_select: 168,
  long_text: 200,
  date: 112,
  datetime: 132,
  url: 176,
  email: 176,
  link: 150,
};
const colWidth = (f: Field) => TYPE_WIDTH[f.type] ?? 140;

/** 单元格右上角 presence 角标（彩色小圆点 + 白色描边），对齐 Desktop PresenceBadge。 */
const PRESENCE_BADGE_STYLE = {
  position: 'absolute' as const,
  top: 1,
  right: 1,
  width: 8,
  height: 8,
  borderRadius: 4,
  borderWidth: 1.5,
  borderColor: '#fff',
};

/** 他人选中/编辑某格的视觉：内嵌彩色边框（选中 1px / 编辑 2px）+ 角标。pointerEvents none 不挡点击。 */
function PresenceDecor({ occupant }: { occupant: Collaborator | null }) {
  if (!occupant) return null;
  return (
    <>
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          { borderWidth: occupant.editing ? 2 : 1, borderColor: occupant.color },
        ]}
      />
      <View pointerEvents="none" style={[PRESENCE_BADGE_STYLE, { backgroundColor: occupant.color }]} />
    </>
  );
}

export type GridViewHandle = TableViewHandle;

export type GridViewProps = {
  baseId: string;
  tableId: string;
  schema: Field[];
  onRowPress: (row: RowRecord) => void;
  onAddRow?: () => void;
  /** WS 收到 schema_changed 时上抛，让宿主刷新 schema。 */
  onSchemaChanged?: (schema: Field[]) => void;
  contentBottomInset?: number;
};

export const GridView = forwardRef<GridViewHandle, GridViewProps>(function GridView(
  { baseId, tableId, schema, onRowPress, onAddRow, onSchemaChanged, contentBottomInset },
  ref,
) {
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const widths = useMemo(() => schema.map(colWidth), [schema]);
  const totalW = useMemo(() => INDEX_W + widths.reduce((a, b) => a + b, 0), [widths]);
  const firstFieldId = schema[0]?.id;

  const [rows, setRows] = useState<RowRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [containerH, setContainerH] = useState(0);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);

  const seqRef = useRef(0);
  const rowsRef = useRef<RowRecord[]>([]);
  const snapshotReadyRef = useRef(false);
  const loadRef = useRef<(reset: boolean) => void>(() => {});

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const applyChanges = useCallback(
    (changes: RtChange[], meta: { catchup?: boolean; reload?: boolean }) => {
      if (meta.reload) {
        loadRef.current(true);
        return;
      }
      const res = applyRtChanges(rowsRef.current, changes, seqRef.current);
      seqRef.current = res.maxSeq;
      if (res.changed) setRows(res.rows);
      if (res.totalDelta) setTotal((t) => Math.max(0, t + res.totalDelta));
      if (res.schema) onSchemaChanged?.(res.schema);
    },
    [onSchemaChanged],
  );

  const getSeq = useCallback(() => seqRef.current, []);
  const { connected, occupancy, occupantAt, sendPresence, markReady } = useTableSocket({
    session,
    tableId,
    getSeq,
    onChange: applyChanges,
    snapshotReadyRef,
  });

  const load = useCallback(
    async (reset: boolean) => {
      if (!session || loadingRef.current) return;
      loadingRef.current = true;
      if (reset) {
        setLoading(true);
        setError(null);
        offsetRef.current = 0;
      } else {
        setLoadingMore(true);
      }
      try {
        const res = await queryRows(session, baseId, tableId, {
          limit: PAGE,
          offset: reset ? 0 : offsetRef.current,
        });
        setTotal(res.total);
        offsetRef.current = (reset ? 0 : offsetRef.current) + res.rows.length;
        setRows((prev) => (reset ? res.rows : [...prev, ...res.rows]));
        if (reset) {
          seqRef.current = res.seq;
          snapshotReadyRef.current = true;
          markReady();
        }
      } catch (e) {
        if (reset) setError(e instanceof Error ? e.message : String(e));
      } finally {
        loadingRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [session, baseId, tableId, markReady],
  );

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    setRows([]);
    load(true);
  }, [load]);

  const hasMore = rows.length < total;
  const onEndReached = useCallback(() => {
    if (hasMore && !loadingRef.current) load(false);
  }, [hasMore, load]);

  useImperativeHandle(
    ref,
    () => ({
      applyRowUpdate: (row) =>
        setRows((prev) => prev.map((r) => (r.row_id === row.row_id ? { ...r, ...row } : r))),
      prependRow: (row) => {
        setRows((prev) => [row, ...prev]);
        setTotal((t) => t + 1);
      },
      removeRow: (rowId) => {
        setRows((prev) => prev.filter((r) => r.row_id !== rowId));
        setTotal((t) => Math.max(0, t - 1));
      },
      // Mobile 按整条记录编辑（RecordSheet），没有单元格粒度 → 用首列作为代表格广播，
      // editing:false（仅「在看这行」，不上锁；并发写靠 CAS 兜底）。
      setLocalPresence: (rowId) =>
        sendPresence({
          cell: rowId && firstFieldId ? { row_id: rowId, field_id: firstFieldId } : null,
          editing: false,
        }),
    }),
    [sendPresence, firstFieldId],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<RowRecord> | null | undefined, index: number) => ({
      length: ROW_H,
      offset: ROW_H * index,
      index,
    }),
    [],
  );
  const keyExtractor = useCallback((r: RowRecord) => r.row_id, []);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setContainerH((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
  }, []);

  if (schema.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.hint}>这张表还没有字段</Text>
      </View>
    );
  }

  const bodyH = Math.max(0, containerH - HEADER_H);

  // 单元格内容：他人正在编辑该格且带实时值 → 显示协作者实时值（斜体着色，对齐 Desktop）；否则常规内容。
  const cellBody = (field: Field, item: RowRecord, occ: Collaborator | null) =>
    occ && occ.editing && occ.value != null ? (
      <Text style={[styles.remoteValue, { color: occ.color }]} numberOfLines={1}>
        {occ.value}
      </Text>
    ) : (
      <CellContent field={field} value={item.data[field.id]} colors={colors} />
    );

  const renderRow = ({ item, index }: { item: RowRecord; index: number }) => (
    <TouchableOpacity
      style={[styles.row, { width: totalW, height: ROW_H }]}
      activeOpacity={0.6}
      onPress={() => onRowPress(item)}
    >
      <View style={[styles.indexCell, { width: INDEX_W, height: ROW_H }]}>
        <Text style={styles.indexText} numberOfLines={1}>
          {index + 1}
        </Text>
      </View>
      {schema.map((f, i) => {
        const occ = occupantAt(item.row_id, f.id);
        return (
          <View key={f.id} style={[styles.cell, { width: widths[i], height: ROW_H }]}>
            {cellBody(f, item, occ)}
            <PresenceDecor occupant={occ} />
          </View>
        );
      })}
    </TouchableOpacity>
  );

  return (
    <View style={styles.root}>
      <View style={styles.body} onLayout={onContainerLayout}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.textMuted} />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={() => load(true)}>
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : containerH <= 0 ? null : (
          // 表头 + 正文同处一个横向 ScrollView → 横向滚动天然同步；正文纵向由内层 FlatList 虚拟化。
          <ScrollView horizontal showsHorizontalScrollIndicator bounces={false}>
            <View style={{ width: totalW, height: containerH }}>
              <View style={[styles.headerRow, { width: totalW, height: HEADER_H }]}>
                <View style={[styles.indexCell, styles.indexHead, { width: INDEX_W, height: HEADER_H }]}>
                  <Text style={styles.indexText}>#</Text>
                </View>
                {schema.map((f, i) => (
                  <View key={f.id} style={[styles.headerCell, { width: widths[i], height: HEADER_H }]}>
                    <Text style={styles.headerText} numberOfLines={1}>
                      {f.name}
                    </Text>
                  </View>
                ))}
              </View>
              <FlatList
                data={rows}
                extraData={occupancy}
                style={{ height: bodyH }}
                onEndReached={onEndReached}
                onEndReachedThreshold={0.4}
                renderItem={renderRow}
                keyExtractor={keyExtractor}
                getItemLayout={getItemLayout}
                ListEmptyComponent={
                  <View style={styles.emptyRows}>
                    <Text style={styles.hint}>还没有记录</Text>
                  </View>
                }
                ListFooterComponent={
                  loadingMore ? (
                    <View style={styles.footerLoading}>
                      <ActivityIndicator color={colors.textMuted} size="small" />
                    </View>
                  ) : null
                }
              />
            </View>
          </ScrollView>
        )}
      </View>

      <View style={[styles.toolbar, contentBottomInset ? { paddingBottom: contentBottomInset } : null]}>
        <TouchableOpacity style={styles.addBtn} onPress={onAddRow} activeOpacity={0.7} disabled={!onAddRow}>
          <Text style={styles.addBtnText}>＋ 新建记录</Text>
        </TouchableOpacity>
        <View style={styles.statusWrap}>
          <View style={[styles.liveDot, { backgroundColor: connected ? colors.primary : colors.placeholder }]} />
          <Text style={styles.count}>
            {connected ? '实时' : '离线'} · {total} 行
          </Text>
        </View>
      </View>
    </View>
  );
});

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    body: { flex: 1 },
    row: { flexDirection: 'row' },
    cell: {
      justifyContent: 'center',
      paddingHorizontal: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderSubtle,
    },
    remoteValue: { fontSize: 13, fontStyle: 'italic' },
    // 行号（#）列：无横向 padding（16px 太窄），居中小号淡字。
    // 右边缘纵向分割线用 borderD4（比横向行线深、更明显）；序号文字比这条线更淡。
    indexCell: {
      alignItems: 'center',
      justifyContent: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderSubtle,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.borderD4,
    },
    indexHead: { backgroundColor: c.surfaceMuted, borderBottomColor: c.border },
    // 比竖线(borderD4)更淡：亮色更接近白底、暗色更接近黑底，两个主题都低对比。
    indexText: { fontSize: 10, color: c.borderMuted },
    headerRow: { flexDirection: 'row' },
    headerCell: {
      justifyContent: 'center',
      paddingHorizontal: 10,
      backgroundColor: c.surfaceMuted,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    headerText: { fontSize: 12, fontWeight: '600', color: c.textMuted },
    emptyRows: { paddingVertical: 40, alignItems: 'center' },
    footerLoading: { paddingVertical: 16, alignItems: 'center' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    hint: { fontSize: 13, color: c.placeholder },
    errorText: { fontSize: 13, color: c.placeholder, marginBottom: 12, textAlign: 'center' },
    retryBtn: {
      paddingVertical: 6,
      paddingHorizontal: 18,
      borderRadius: 14,
      backgroundColor: c.surfaceMuted,
    },
    retryText: { fontSize: 13, color: c.textPrimary },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      backgroundColor: c.surface,
    },
    addBtn: {
      height: FB_ROW_HEIGHT,
      justifyContent: 'center',
      paddingHorizontal: 14,
      borderRadius: FB_ROW_RADIUS,
      backgroundColor: c.primary,
    },
    addBtnText: { fontSize: 13, fontWeight: '600', color: c.onPrimary },
    statusWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    liveDot: { width: 7, height: 7, borderRadius: 4 },
    count: { fontSize: 12, color: c.textMuted },
  });
}
