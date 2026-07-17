/**
 * FlowBaseScreen —— 多维表格（FlowBase）在 mobile 端的入口屏。
 *
 * 由 DocBodyView 在 `docType === 'flowbase'` 时渲染（与 paper 同构：自带数据加载，
 * 不走 flowdoc 快照逻辑）。base_id 来自 flowdoc 树节点 `meta.base_id`。
 *
 * P1：解析 base → 表切换 → 只读 GridView（虚拟化 + 冻结首列）+ RecordSheet 记录卡片编辑。
 * 视图切换渲染（grid/kanban/calendar）、WS 实时在后续期。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import {
  getBase,
  getTableSchema,
  listViews,
  createView,
  listDashboards,
  listApps,
  FlowBaseApiError,
} from './api';
import type { App, Base, Dashboard, Field, RowRecord, Table, View as FbView } from './types';
import { GridView } from './views/GridView';
import { KanbanView } from './views/KanbanView';
import { CalendarView } from './views/CalendarView';
import type { TableViewHandle } from './views/viewHandle';
import { RecordSheet } from './views/RecordSheet';
import { DashboardView } from './dashboard/DashboardView';
import { CustomAppWebView } from './app/CustomAppWebView';
import { FB_ROW_HEIGHT, FB_ROW_RADIUS } from './constants';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { RootStackParamList } from '../navigation/types';

type PageKind = 'table' | 'dashboard' | 'app';
type PageEntry = { kind: PageKind; id: string; name: string };
/** 与 Web 一致：`${kind}:${id}` 作为混排顺序键。 */
const entryKey = (e: { kind: string; id: string }) => `${e.kind}:${e.id}`;

export type FlowBaseScreenProps = {
  /** flowdoc 树节点 id（诊断/未来按需回查 meta 用）。 */
  docId: string;
  /** 节点 meta.base_id 指针；缺失则报错提示。 */
  baseId: string | null;
  contentTopInset?: number;
  contentBottomInset?: number;
};

const VIEW_TYPE_LABEL: Record<string, string> = {
  grid: '表格',
  kanban: '看板',
  calendar: '日历',
};

const VIEW_ICON: Record<string, string> = {
  grid: 'grid-outline',
  kanban: 'albums-outline',
  calendar: 'calendar-outline',
};

/** page 平铺时按类型加一个小图标以区分表/仪表盘/应用。 */
const PAGE_ICON: Record<PageKind, string> = {
  table: 'grid-outline',
  dashboard: 'stats-chart-outline',
  app: 'cube-outline',
};

export function FlowBaseScreen({
  docId: _docId,
  baseId,
  contentTopInset,
  contentBottomInset,
}: FlowBaseScreenProps) {
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();

  const [base, setBase] = useState<Base | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Base 级别的仪表盘 / 应用（与表平级，混排成 pages，按 base.config.entry_order 排序）
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [activePageKey, setActivePageKey] = useState<string | null>(null);

  const [schema, setSchema] = useState<Field[]>([]);
  const [views, setViews] = useState<FbView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [loadedTableId, setLoadedTableId] = useState<string | null>(null); // schema/views 已就绪的表
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);

  // 单一 ref 指向当前激活视图（grid/kanban/calendar），RecordSheet 的补丁经它作用。
  const viewRef = useRef<TableViewHandle>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [editingRow, setEditingRow] = useState<RowRecord | null>(null);

  const loadBase = useCallback(async () => {
    if (!session) {
      setError('未登录');
      setLoading(false);
      return;
    }
    if (!baseId) {
      setError('该节点未关联 Base（meta.base_id 缺失）');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { base: b, tables: ts } = await getBase(session, baseId);
      setBase(b);
      setTables(ts);
      // 仪表盘/应用容错拉取（缺失不影响表功能）
      const [dl, al] = await Promise.all([
        listDashboards(session, baseId).catch(() => [] as Dashboard[]),
        listApps(session, baseId).catch(() => [] as App[]),
      ]);
      setDashboards(dl);
      setApps(al);
    } catch (e) {
      setError(e instanceof FlowBaseApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session, baseId]);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  // 混排 pages = 表 + 仪表盘 + app，按 base.config.entry_order 排序（未登记的稳定排在后面）——对齐 Web。
  const entries = useMemo<PageEntry[]>(() => {
    const list: PageEntry[] = [
      ...tables.map((t) => ({ kind: 'table' as const, id: t.id, name: t.name || '未命名表' })),
      ...dashboards.map((d) => ({ kind: 'dashboard' as const, id: d.id, name: d.name || '未命名仪表盘' })),
      ...apps.map((a) => ({ kind: 'app' as const, id: a.id, name: a.name || '未命名应用' })),
    ];
    const ord = Array.isArray(base?.config?.entry_order)
      ? (base!.config!.entry_order as Array<{ kind: string; id: string }>)
      : [];
    const pos = new Map(ord.map((o, i) => [`${o.kind}:${o.id}`, i]));
    return list
      .map((e, i) => ({ e, i, p: pos.has(entryKey(e)) ? (pos.get(entryKey(e)) as number) : Infinity }))
      .sort((a, b) => (a.p !== b.p ? a.p - b.p : a.i - b.i))
      .map((x) => x.e);
  }, [tables, dashboards, apps, base]);

  const activePage = useMemo(
    () => entries.find((e) => entryKey(e) === activePageKey) ?? entries[0] ?? null,
    [entries, activePageKey],
  );
  const activeTableId = activePage?.kind === 'table' ? activePage.id : null;
  const activeDashId = activePage?.kind === 'dashboard' ? activePage.id : null;
  const activeAppId = activePage?.kind === 'app' ? activePage.id : null;
  const activeApp = useMemo(
    () => (activeAppId ? apps.find((a) => a.id === activeAppId) ?? null : null),
    [apps, activeAppId],
  );

  // 切到别的表 → 回到该表默认视图
  useEffect(() => {
    setActiveViewId(null);
  }, [activeTableId]);

  const loadTable = useCallback(async () => {
    if (!session || !baseId || !activeTableId) return;
    setTableLoading(true);
    setTableError(null);
    try {
      const [schemaRes, viewsRes] = await Promise.all([
        getTableSchema(session, baseId, activeTableId),
        listViews(session, baseId, activeTableId),
      ]);
      setSchema(schemaRes.schema);
      setViews(viewsRes);
      setLoadedTableId(activeTableId);
    } catch (e) {
      setSchema([]);
      setViews([]);
      setTableError(e instanceof Error ? e.message : String(e));
    } finally {
      setTableLoading(false);
    }
  }, [session, baseId, activeTableId]);

  useEffect(() => {
    loadTable();
  }, [loadTable]);

  const activeView = useMemo(
    () =>
      views.find((v) => v.id === activeViewId) ??
      views.find((v) => v.is_default) ??
      views[0] ??
      null,
    [views, activeViewId],
  );
  const activeViewType = String(activeView?.view_type ?? 'grid');

  const openEdit = useCallback((r: RowRecord) => {
    setEditingRow(r);
    setSheetVisible(true);
    viewRef.current?.setLocalPresence(r.row_id); // 广播「我在看/编辑这行」
  }, []);
  const openNew = useCallback(() => {
    setEditingRow(null);
    setSheetVisible(true);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetVisible(false);
    viewRef.current?.setLocalPresence(null); // 离开 → 清除 presence
  }, []);
  const onSaved = useCallback((r: RowRecord, isNew: boolean) => {
    if (isNew) viewRef.current?.prependRow(r);
    else viewRef.current?.applyRowUpdate(r);
  }, []);
  const onDeleted = useCallback((id: string) => viewRef.current?.removeRow(id), []);

  // 新建视图（grid/kanban/calendar）并切过去——对齐 Desktop 的「+ 视图」。
  const addView = useCallback(
    (viewType: string) => {
      if (!session || !baseId || !activeTableId) return;
      createView(session, baseId, activeTableId, viewType, VIEW_TYPE_LABEL[viewType])
        .then((v) => {
          setViews((prev) => [...prev, v]);
          setActiveViewId(v.id);
        })
        .catch((e) => Alert.alert('新建视图失败', e instanceof Error ? e.message : String(e)));
    },
    [session, baseId, activeTableId],
  );
  const promptAddView = useCallback(() => {
    Alert.alert('新建视图', undefined, [
      { text: '表格', onPress: () => addView('grid') },
      { text: '看板', onPress: () => addView('kanban') },
      { text: '日历', onPress: () => addView('calendar') },
      { text: '取消', style: 'cancel' },
    ]);
  }, [addView]);

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
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={loadBase}>
          <Text style={styles.retryText}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* 顶部：page tab bar + 视图 chips（定高，不随网格滚动）。表名/base 名已在 doc header + page tab
          里显示，这里不再重复大标题。 */}
      <View style={[styles.head, contentTopInset ? { paddingTop: contentTopInset + 8 } : null]}>
        {/* Page tab bar：表 / 仪表盘 / app 平级混排（顺序来自 base.config.entry_order），对齐 Web */}
        {entries.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipRow}
            contentContainerStyle={styles.chipRowContent}
          >
            {entries.map((e) => {
              const active = activePage ? entryKey(e) === entryKey(activePage) : false;
              return (
                <TouchableOpacity
                  key={entryKey(e)}
                  style={[styles.pageChip, active && styles.chipActive]}
                  onPress={() => setActivePageKey(entryKey(e))}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={PAGE_ICON[e.kind]}
                    size={13}
                    color={active ? colors.onPrimary : colors.textMuted}
                  />
                  <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                    {e.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : null}

        {/* 表页的视图切换（grid/kanban/calendar）+ 新建视图。表未有视图时也显示（只有「+」），
            这样用户随时能加看板/日历——对齐 Desktop。 */}
        {activePage?.kind === 'table' && loadedTableId === activeTableId ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.viewRow}
            contentContainerStyle={styles.chipRowContent}
          >
            {views.map((v) => {
              const active = activeView?.id === v.id;
              const label = v.name || VIEW_TYPE_LABEL[String(v.view_type)] || String(v.view_type);
              return (
                <TouchableOpacity
                  key={v.id}
                  style={[styles.viewChip, active && styles.viewChipActive]}
                  onPress={() => setActiveViewId(v.id)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={VIEW_ICON[String(v.view_type)] || 'grid-outline'}
                    size={12}
                    color={active ? colors.primary : colors.textMuted}
                  />
                  <Text style={[styles.viewChipText, active && styles.viewChipTextActive]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={styles.viewChip} onPress={promptAddView} activeOpacity={0.7}>
              <Ionicons name="add" size={14} color={colors.textMuted} />
              <Text style={styles.viewChipText}>视图</Text>
            </TouchableOpacity>
          </ScrollView>
        ) : null}
      </View>

      {/* 主区：按当前 page 渲染 */}
      {activePage?.kind === 'dashboard' && activeDashId ? (
        <DashboardView baseId={baseId!} dashId={activeDashId} contentBottomInset={contentBottomInset} />
      ) : activePage?.kind === 'app' && activeAppId ? (
        activeApp?.config?.platform === 'mobile' ? (
          // 手机版 app：不页内嵌入，改引导到全屏 Applet（类小程序体验）
          <View style={styles.appletCard}>
            <Ionicons name="phone-portrait-outline" size={34} color={colors.textMuted} />
            <Text style={styles.appletCardText}>该应用是手机版，点击全屏打开</Text>
            <TouchableOpacity
              style={styles.appletCardBtn}
              onPress={() =>
                navigation.navigate('Applet', {
                  appId: activeAppId,
                  baseId: baseId!,
                  appName: activeApp?.name,
                })
              }
              activeOpacity={0.85}
            >
              <Text style={styles.appletCardBtnText}>打开</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <CustomAppWebView
            baseId={baseId!}
            appId={activeAppId}
            tables={tables}
            contentBottomInset={contentBottomInset}
          />
        )
      ) : tables.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.hint}>这个 Base 还没有数据表</Text>
        </View>
      ) : tableLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : tableError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{tableError}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadTable}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : activeTableId && loadedTableId === activeTableId ? (
        activeViewType === 'kanban' ? (
          <KanbanView
            key={`${activeTableId}:${activeView?.id}`}
            ref={viewRef}
            baseId={baseId!}
            tableId={activeTableId}
            schema={schema}
            view={activeView}
            onRowPress={openEdit}
            onSchemaChanged={setSchema}
          />
        ) : activeViewType === 'calendar' ? (
          <CalendarView
            key={`${activeTableId}:${activeView?.id}`}
            ref={viewRef}
            baseId={baseId!}
            tableId={activeTableId}
            schema={schema}
            view={activeView}
            onRowPress={openEdit}
            onSchemaChanged={setSchema}
          />
        ) : (
          <GridView
            key={`${activeTableId}:${activeView?.id}`}
            ref={viewRef}
            baseId={baseId!}
            tableId={activeTableId}
            schema={schema}
            onRowPress={openEdit}
            onAddRow={openNew}
            onSchemaChanged={setSchema}
            contentBottomInset={contentBottomInset}
          />
        )
      ) : (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      )}

      {activeTableId ? (
        <RecordSheet
          baseId={baseId!}
          tableId={activeTableId}
          schema={schema}
          row={editingRow}
          visible={sheetVisible}
          onClose={closeSheet}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      ) : null}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    head: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.background,
    },
    chipRow: { flexGrow: 0 },
    pageChip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      height: FB_ROW_HEIGHT,
      paddingHorizontal: 12,
      borderRadius: FB_ROW_RADIUS,
      backgroundColor: c.surfaceMuted,
      maxWidth: 200,
    },
    viewRow: { marginTop: 8, flexGrow: 0 },
    chipRowContent: { gap: 8, paddingRight: 8 },
    chipActive: { backgroundColor: c.primary },
    chipText: { fontSize: 13, color: c.textSecondary, fontWeight: '500' },
    chipTextActive: { color: c.onPrimary },
    viewChip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      height: FB_ROW_HEIGHT,
      paddingHorizontal: 12,
      borderRadius: FB_ROW_RADIUS,
      borderWidth: 1,
      borderColor: c.borderSubtle,
      backgroundColor: c.surface,
    },
    viewChipActive: { borderColor: c.primary },
    viewChipText: { fontSize: 12, color: c.textPrimary },
    viewChipTextActive: { color: c.primary, fontWeight: '600' },

    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    hint: { fontSize: 13, color: c.placeholder },
    errorText: {
      color: c.placeholder,
      fontSize: 13,
      marginBottom: 12,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    retryBtn: {
      alignSelf: 'center',
      paddingVertical: 6,
      paddingHorizontal: 18,
      borderRadius: 14,
      backgroundColor: c.surface,
    },
    retryText: { fontSize: 13, color: c.textPrimary },
    // 手机版 app 引导卡：居中图标 + 说明 + 打开按钮
    appletCard: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 14,
    },
    appletCardText: { fontSize: 14, color: c.textMuted, textAlign: 'center' },
    appletCardBtn: {
      paddingVertical: 9,
      paddingHorizontal: 28,
      borderRadius: 18,
      backgroundColor: c.primary,
    },
    // c.background 作 on-primary：亮色白字压深底、暗色深字压亮底，两主题都够对比
    appletCardBtnText: { fontSize: 14, fontWeight: '600', color: c.background },
  });
}
