/**
 * DashboardView —— 仪表盘（P3）。移动端不做 Desktop 的自由网格，改为**纵向卡片流**。
 * 拉 getDashboard(config.components) + queryDashboard(并行解析) → 按组件类型渲染：
 *   metric 大数字卡 / chart 自研 SVG 柱线饼 / pivot 交叉表 / view 原始行表。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { getDashboard, getTableSchema, queryDashboard } from '../api';
import type { ComponentResult, Dashboard, DashboardComponent, Field } from '../types';
import { BarChart, LineChart, PieChart, type PieSlice, type Series } from './charts';
import { CHART_PALETTE, fieldName, fmtNum, groupLabel } from './format';

const CHART_H = 190;
const CARD_PAD = 14;

export type DashboardViewProps = {
  baseId: string;
  dashId: string;
  contentBottomInset?: number;
};

export function DashboardView({ baseId, dashId, contentBottomInset }: DashboardViewProps) {
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [dash, setDash] = useState<Dashboard | null>(null);
  const [results, setResults] = useState<Record<string, ComponentResult>>({});
  const [schemas, setSchemas] = useState<Record<string, Field[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      const d = await getDashboard(session, baseId, dashId);
      const comps = d.config?.components ?? [];
      const tids = [...new Set(comps.map((c) => c.table_id).filter((t): t is string => !!t))];
      const [res, schemaEntries] = await Promise.all([
        queryDashboard(session, baseId, dashId),
        Promise.all(
          tids.map(async (tid) => [tid, (await getTableSchema(session, baseId, tid)).schema] as const),
        ),
      ]);
      setDash(d);
      setResults(res);
      setSchemas(Object.fromEntries(schemaEntries));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session, baseId, dashId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);

  const components = dash?.config?.components ?? [];

  if (loading) {
    return (
      <View style={styles.centered} onLayout={onLayout}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centered} onLayout={onLayout}>
        <Text style={styles.hint}>{error}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, contentBottomInset ? { paddingBottom: contentBottomInset + 32 } : null]}
      onLayout={onLayout}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
          tintColor={colors.textMuted}
        />
      }
    >
      {components.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.hint}>这个仪表盘还没有组件</Text>
        </View>
      ) : (
        components.map((comp) => (
          <ComponentCard
            key={comp.id}
            component={comp}
            result={results[comp.id]}
            schema={comp.table_id ? schemas[comp.table_id] : undefined}
            width={Math.max(0, width - 32)}
            colors={colors}
          />
        ))
      )}
    </ScrollView>
  );
}

function ComponentCard({
  component,
  result,
  schema,
  width,
  colors,
}: {
  component: DashboardComponent;
  result: ComponentResult | undefined;
  schema: Field[] | undefined;
  width: number;
  colors: AppColors;
}) {
  const styles = createStyles(colors);
  const title = component.title || component.type;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} numberOfLines={1}>
        {title}
      </Text>
      {!result ? (
        <View style={styles.cardBody}>
          <ActivityIndicator color={colors.textMuted} size="small" />
        </View>
      ) : result.error ? (
        <Text style={styles.errText}>⚠ {result.error}</Text>
      ) : (
        <ComponentBody component={component} result={result} schema={schema} width={width} colors={colors} />
      )}
    </View>
  );
}

function ComponentBody({
  component,
  result,
  schema,
  width,
  colors,
}: {
  component: DashboardComponent;
  result: ComponentResult;
  schema: Field[] | undefined;
  width: number;
  colors: AppColors;
}) {
  switch (component.type) {
    case 'metric':
      return <MetricBody result={result} colors={colors} />;
    case 'chart':
      return <ChartBody component={component} result={result} width={width} colors={colors} />;
    case 'pivot':
      return <PivotBody result={result} schema={schema} colors={colors} />;
    case 'view':
      return <RowsBody component={component} result={result} schema={schema} colors={colors} />;
    default:
      return <Empty text={`未知组件类型: ${component.type}`} colors={colors} />;
  }
}

function MetricBody({ result, colors }: { result: ComponentResult; colors: AppColors }) {
  const styles = createStyles(colors);
  const tVal = result.transform?.value;
  let value: unknown = tVal;
  let unit = result.transform?.unit;
  if (tVal == null) {
    const g = (result.groups || [])[0];
    const aliases = result.aggregate || (g ? Object.keys(g.aggregates || {}) : []);
    const alias = aliases[0];
    value = g && alias ? g.aggregates[alias] : null;
    unit = alias;
  }
  return (
    <View style={styles.metricWrap}>
      <Text style={styles.metricValue}>{fmtNum(value)}</Text>
      {unit ? <Text style={styles.metricUnit}>{unit}</Text> : null}
    </View>
  );
}

function ChartBody({
  component,
  result,
  width,
  colors,
}: {
  component: DashboardComponent;
  result: ComponentResult;
  width: number;
  colors: AppColors;
}) {
  const styles = createStyles(colors);
  const groupBy = result.group_by || [];
  const aggregates = result.aggregate || [];
  const groups = result.groups || [];
  const chartType = component.chart_type || 'bar';
  if (!groups.length) return <Empty text="暂无数据" colors={colors} />;
  if (width <= 0) return <View style={{ height: CHART_H }} />;

  const categories = groups.map((g) => groupLabel(g.group, groupBy));
  const nullConnect = component.null_connect || 'zero';
  const cellVal = (raw: unknown): number | null => {
    if (raw == null || raw === '') return nullConnect === 'zero' ? 0 : null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  if (chartType === 'pie') {
    const alias = aggregates[0];
    const slices: PieSlice[] = groups.map((g, i) => ({
      name: categories[i],
      value: Number(g.aggregates?.[alias] ?? 0),
      color: CHART_PALETTE[i % CHART_PALETTE.length],
    }));
    return (
      <View>
        <PieChart slices={slices} width={width} height={CHART_H} />
        <Legend items={slices.map((s) => ({ name: s.name, color: s.color }))} colors={colors} />
      </View>
    );
  }

  const series: Series[] = aggregates.map((alias, i) => ({
    name: alias,
    color: CHART_PALETTE[i % CHART_PALETTE.length],
    values: groups.map((g) => cellVal(g.aggregates?.[alias])),
  }));
  return (
    <View>
      {chartType === 'line' ? (
        <LineChart
          categories={categories}
          series={series}
          width={width}
          height={CHART_H}
          connectNulls={nullConnect === 'skip'}
        />
      ) : (
        <BarChart categories={categories} series={series} width={width} height={CHART_H} />
      )}
      {series.length > 1 ? (
        <Legend items={series.map((s) => ({ name: s.name, color: s.color }))} colors={colors} />
      ) : null}
    </View>
  );
}

function Legend({ items, colors }: { items: Array<{ name: string; color: string }>; colors: AppColors }) {
  const styles = createStyles(colors);
  return (
    <View style={styles.legend}>
      {items.map((it, i) => (
        <View key={i} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: it.color }]} />
          <Text style={styles.legendText} numberOfLines={1}>
            {it.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PivotBody({
  result,
  schema,
  colors,
}: {
  result: ComponentResult;
  schema: Field[] | undefined;
  colors: AppColors;
}) {
  const styles = createStyles(colors);
  const groupBy = result.group_by || [];
  const aggregates = result.aggregate || [];
  const rowFid = groupBy[0];
  const colFid = groupBy[1];
  const alias = aggregates[0];

  const { rowKeys, colKeys, cells } = useMemo(() => {
    const rowSet = new Map<string, true>();
    const colSet = new Map<string, true>();
    const cellMap = new Map<string, number>();
    for (const g of result.groups || []) {
      const rk = g.group?.[rowFid];
      const rKey = rk == null || rk === '' ? '(空)' : String(rk);
      rowSet.set(rKey, true);
      const val = Number(g.aggregates?.[alias] ?? 0);
      if (colFid) {
        const ck = g.group?.[colFid];
        const cKey = ck == null || ck === '' ? '(空)' : String(ck);
        colSet.set(cKey, true);
        cellMap.set(`${rKey} ${cKey}`, val);
      } else {
        cellMap.set(rKey, val);
      }
    }
    return { rowKeys: [...rowSet.keys()], colKeys: [...colSet.keys()], cells: cellMap };
  }, [result, rowFid, colFid, alias]);

  if (!rowKeys.length) return <Empty text="暂无数据" colors={colors} />;
  const headers = colFid ? colKeys : [alias];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
      <View>
        <View style={styles.tRow}>
          <View style={[styles.tCell, styles.tHead, styles.tRowHead]}>
            <Text style={styles.tHeadText}>{fieldName(schema, rowFid) || '行'}</Text>
          </View>
          {headers.map((h) => (
            <View key={h} style={[styles.tCell, styles.tHead]}>
              <Text style={styles.tHeadText} numberOfLines={1}>
                {h}
              </Text>
            </View>
          ))}
        </View>
        {rowKeys.map((r) => (
          <View key={r} style={styles.tRow}>
            <View style={[styles.tCell, styles.tRowHead]}>
              <Text style={styles.tRowHeadText} numberOfLines={1}>
                {r}
              </Text>
            </View>
            {(colFid ? colKeys : [null]).map((c, i) => (
              <View key={i} style={styles.tCell}>
                <Text style={styles.tCellText}>
                  {fmtNum(c ? cells.get(`${r} ${c}`) : cells.get(r))}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function RowsBody({
  component,
  result,
  schema,
  colors,
}: {
  component: DashboardComponent;
  result: ComponentResult;
  schema: Field[] | undefined;
  colors: AppColors;
}) {
  const styles = createStyles(colors);
  const rows = result.rows || [];
  const cols = useMemo(() => {
    const want = (component.query?.fields as string[] | undefined) || undefined;
    const list = Array.isArray(want) && want.length ? want : (schema || []).map((f) => f.id);
    return list.map((fid) => ({ id: fid, name: fieldName(schema, fid) }));
  }, [component, schema]);
  if (!rows.length) return <Empty text="暂无数据" colors={colors} />;

  const fmtVal = (v: unknown): string => {
    if (v == null || v === '') return '';
    if (Array.isArray(v)) return v.join('、');
    if (v === true) return '✓';
    if (v === false) return '';
    return String(v);
  };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
      <View>
        <View style={styles.tRow}>
          {cols.map((c) => (
            <View key={c.id} style={[styles.tCell, styles.tHead]}>
              <Text style={styles.tHeadText} numberOfLines={1}>
                {c.name}
              </Text>
            </View>
          ))}
        </View>
        {rows.slice(0, 100).map((r) => (
          <View key={r.row_id} style={styles.tRow}>
            {cols.map((c) => (
              <View key={c.id} style={styles.tCell}>
                <Text style={styles.tCellText} numberOfLines={1}>
                  {fmtVal(r.data?.[c.id])}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Empty({ text, colors }: { text: string; colors: AppColors }) {
  const styles = createStyles(colors);
  return (
    <View style={styles.cardBody}>
      <Text style={styles.hint}>{text}</Text>
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    content: { padding: 16, paddingBottom: 48, gap: 14 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    hint: { fontSize: 13, color: c.placeholder },

    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderSubtle,
      padding: CARD_PAD,
    },
    cardTitle: { fontSize: 14, fontWeight: '600', color: c.textPrimary, marginBottom: 10 },
    cardBody: { minHeight: 60, alignItems: 'center', justifyContent: 'center' },
    errText: { fontSize: 13, color: c.danger, paddingVertical: 12 },

    metricWrap: { alignItems: 'center', paddingVertical: 12 },
    metricValue: { fontSize: 34, fontWeight: '700', color: c.textHeader },
    metricUnit: { fontSize: 12, color: c.textMuted, marginTop: 6 },

    legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8, justifyContent: 'center' },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 140 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { fontSize: 11, color: c.textMuted },

    tableScroll: { maxHeight: 320 },
    tRow: { flexDirection: 'row' },
    tCell: {
      minWidth: 88,
      paddingVertical: 6,
      paddingHorizontal: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderSubtle,
      justifyContent: 'center',
    },
    tHead: { backgroundColor: c.surfaceMuted },
    tRowHead: { minWidth: 96 },
    tHeadText: { fontSize: 11, fontWeight: '600', color: c.textMuted },
    tRowHeadText: { fontSize: 12, color: c.textPrimary, fontWeight: '500' },
    tCellText: { fontSize: 12, color: c.textPrimary, textAlign: 'right' },
  });
}
