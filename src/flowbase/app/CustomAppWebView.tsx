/**
 * CustomAppWebView —— 自定义 App（P3）。
 *
 * 一个 app = Agent 写的自包含 HTML+CSS+JS（config.source）。与 Web/Desktop 的沙箱 iframe 一致，
 * 移动端用**受控 WebView** 跑同一份 source：CSP 封网 + 注入只读 `window.FlowBaseSDK`，App 内不
 * 直连后端——所有取数走 `ReactNativeWebView.postMessage` RPC，由**原生侧**（持有 session token）
 * 校验后调 REST 再 `injectJavaScript` 回传。token 绝不进 WebView；base_id 锁死；默认只读。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import {
  flowbaseRequest,
  getApp,
  getDashboard,
  getTableSchema,
  listDashboards,
  queryDashboard,
} from '../api';
import type { App, Table } from '../types';

export type CustomAppWebViewProps = {
  baseId: string;
  appId: string;
  /** 本 Base 的表（名字→id 解析用；锁在本 Base 内）。 */
  tables: Table[];
  contentBottomInset?: number;
  /**
   * 全屏模式（类小程序 Applet）：WebView 直接 flex:1 铺满，由 App 内部滚动，
   * 不走「自测高 + 外层 ScrollView」那套（那套是给 FlowBase 页内嵌入用的）。
   * 缺省 false，保持页内嵌入行为不变。
   */
  fillHeight?: boolean;
};

// 注入 WebView 的 SDK shim：RN 版走 ReactNativeWebView.postMessage + window.__flowbaseDeliver 回传。
const SDK_SHIM = `(function(){
  var seq=0, pending={};
  function rpc(method,args){
    return new Promise(function(resolve,reject){
      var id='r'+(++seq);
      pending[id]={resolve:resolve,reject:reject};
      window.ReactNativeWebView.postMessage(JSON.stringify({__flowbase_rpc:true,id:id,method:method,args:args||{}}));
    });
  }
  window.__flowbaseDeliver=function(d){
    if(!d||d.__flowbase_rpc_reply!==true)return;
    var p=pending[d.id]; if(!p)return; delete pending[d.id];
    if(d.error)p.reject(new Error(d.error)); else p.resolve(d.result);
  };
  function tableHandle(name){return{
    list:function(){return rpc('table.list',{name:name});},
    query:function(opts){return rpc('table.query',{name:name,opts:opts||{}});},
    getRow:function(rowId){return rpc('table.getRow',{name:name,row_id:rowId});}
  };}
  function dashboardHandle(name){return{
    list:function(){return rpc('dashboard.list',{});},
    results:function(){return rpc('dashboard.results',{name:name});}
  };}
  window.FlowBaseSDK={version:1,baseId:__BASE_ID__,table:function(n){return tableHandle(n);},dashboard:function(n){return dashboardHandle(n);}};
  function reportHeight(){
    var h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0);
    window.ReactNativeWebView.postMessage(JSON.stringify({__flowbase_resize:true,height:h}));
  }
  window.addEventListener('load',reportHeight);
  if(window.ResizeObserver&&document.body)new ResizeObserver(reportHeight).observe(document.body);
  setTimeout(reportHeight,50);
})();`;

function buildHtml(source: string, baseId: string): string {
  const shim = SDK_SHIM.replace('__BASE_ID__', JSON.stringify(String(baseId || '')));
  // default-src 'none' 封死一切网络；仅放行内联脚本/样式 + data: 图片，供 App 源码运行。
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style>` +
    `<script>${shim}</script>` +
    `</head><body>${source || ''}</body></html>`
  );
}

// order_by（"field" / "field desc" / {field,direction}）→ {sort, order}
function splitOrderBy(orderBy: unknown): { sort: string | null; order: string } {
  if (orderBy && typeof orderBy === 'object') {
    const o = orderBy as { field?: string; direction?: string; order?: string };
    return { sort: o.field ?? null, order: o.direction || o.order || 'asc' };
  }
  if (typeof orderBy === 'string' && orderBy.trim()) {
    const parts = orderBy.trim().split(/\s+/);
    if (parts.length === 2 && /^(asc|desc)$/i.test(parts[1])) return { sort: parts[0], order: parts[1].toLowerCase() };
    return { sort: orderBy.trim(), order: 'asc' };
  }
  return { sort: null, order: 'asc' };
}

export function CustomAppWebView({ baseId, appId, tables, contentBottomInset, fillHeight }: CustomAppWebViewProps) {
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const webRef = useRef<WebView>(null);

  const [app, setApp] = useState<App | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(360);

  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const dashboardsRef = useRef<Array<{ id: string; name: string }> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!session) return;
      setLoading(true);
      setError(null);
      try {
        const a = await getApp(session, baseId, appId);
        if (alive) setApp(a);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, baseId, appId]);

  const resolveTable = useCallback((name: unknown): Table => {
    const key = String(name == null ? '' : name);
    const list = tablesRef.current || [];
    const hit = list.find((t) => t.name === key) || list.find((t) => t.id === key);
    if (!hit) throw new Error(`table not found in this base: ${key}`);
    return hit;
  }, []);

  const ensureDashboards = useCallback(async () => {
    if (dashboardsRef.current) return dashboardsRef.current;
    const dl = await listDashboards(session!, baseId);
    dashboardsRef.current = dl.map((d) => ({ id: d.id, name: d.name }));
    return dashboardsRef.current;
  }, [session, baseId]);

  // RPC 分发（原生侧策略执行点）：只读白名单；未知/写方法一律拒绝；base_id 恒为本组件 prop。
  const handleRpc = useCallback(
    async (method: string, args: Record<string, unknown>): Promise<unknown> => {
      const a = args || {};
      const s = session!;
      switch (method) {
        case 'table.list': {
          const t = resolveTable(a.name);
          const res = await getTableSchema(s, baseId, t.id);
          return { table_id: t.id, name: t.name, schema: res.schema, row_count: t.row_count ?? 0 };
        }
        case 'table.query': {
          const t = resolveTable(a.name);
          const o = (a.opts as Record<string, unknown>) || {};
          const qs = new URLSearchParams();
          const filt = o.filter != null ? o.filter : (o as { filters?: unknown }).filters;
          if (filt != null) qs.set('filter', typeof filt === 'string' ? filt : JSON.stringify(filt));
          const { sort, order } = splitOrderBy(o.order_by != null ? o.order_by : o.sort);
          if (sort) qs.set('sort', sort);
          if (order) qs.set('order', order);
          if (o.limit != null) qs.set('limit', String(o.limit));
          if (o.offset != null) qs.set('offset', String(o.offset));
          if (Array.isArray(o.fields)) qs.set('fields', (o.fields as string[]).join(','));
          if (o.group_by != null)
            qs.set('group_by', Array.isArray(o.group_by) ? (o.group_by as string[]).join(',') : String(o.group_by));
          if (o.aggregate != null) qs.set('aggregate', JSON.stringify(o.aggregate));
          if (o.having != null) qs.set('having', JSON.stringify(o.having));
          const data = await flowbaseRequest<Record<string, unknown>>(
            s,
            'GET',
            `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(t.id)}/rows?${qs.toString()}`,
          );
          delete data.success;
          return data;
        }
        case 'table.getRow': {
          const t = resolveTable(a.name);
          const rowId = String(a.row_id || '');
          if (!rowId) throw new Error('row_id is required');
          const qs = new URLSearchParams();
          qs.set('filter', JSON.stringify([{ field: 'row_id', op: 'eq', value: rowId }]));
          qs.set('limit', '1');
          const data = await flowbaseRequest<{ rows?: unknown[] }>(
            s,
            'GET',
            `/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(t.id)}/rows?${qs.toString()}`,
          );
          return (data.rows && data.rows[0]) || null;
        }
        case 'dashboard.list': {
          const dl = await ensureDashboards();
          return { dashboards: dl };
        }
        case 'dashboard.results': {
          const dl = await ensureDashboards();
          const key = String(a.name == null ? '' : a.name);
          const d = dl.find((x) => x.name === key) || dl.find((x) => x.id === key);
          if (!d) throw new Error(`dashboard not found in this base: ${key}`);
          const [detail, results] = await Promise.all([
            getDashboard(s, baseId, d.id),
            queryDashboard(s, baseId, d.id),
          ]);
          return { config: detail.config || {}, results };
        }
        default:
          throw new Error(`method not permitted: ${method}`);
      }
    },
    [session, baseId, resolveTable, ensureDashboards],
  );

  const onMessage = useCallback(
    (ev: WebViewMessageEvent) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(ev.nativeEvent.data);
      } catch {
        return;
      }
      if (d.__flowbase_resize === true) {
        const h = Number(d.height);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(h, 80), 8000));
        return;
      }
      if (d.__flowbase_rpc !== true || !d.id) return;
      const id = d.id;
      const reply = (patch: Record<string, unknown>) =>
        webRef.current?.injectJavaScript(
          `window.__flowbaseDeliver(${JSON.stringify({ __flowbase_rpc_reply: true, id, ...patch })}); true;`,
        );
      handleRpc(String(d.method || ''), (d.args as Record<string, unknown>) || {})
        .then((result) => reply({ result }))
        .catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }));
    },
    [handleRpc],
  );

  const html = useMemo(() => (app ? buildHtml(app.config?.source || '', baseId) : ''), [app, baseId]);

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
  if (!app) {
    return (
      <View style={styles.centered}>
        <Text style={styles.hint}>应用不存在</Text>
      </View>
    );
  }

  const webView = (
    <WebView
      ref={webRef}
      source={{ html }}
      originWhitelist={['about:*']}
      javaScriptEnabled
      onMessage={onMessage}
      // 全屏模式让 App 自己滚；页内嵌入模式关滚动，由外层 ScrollView + 自测高承载。
      scrollEnabled={!!fillHeight}
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      allowUniversalAccessFromFileURLs={false}
      // 禁止 App 内导航到外部（放行 about:/data: 等初始加载，拒绝 http(s)/file）；CSP 已封网，双保险。
      onShouldStartLoadWithRequest={(req) => !/^(https?|file):/i.test(req.url || '')}
      style={fillHeight ? styles.webFill : [styles.web, { height }]}
    />
  );

  // 全屏 Applet：WebView 直接铺满，忽略自测高度（App 内部滚动）。
  if (fillHeight) {
    return <View style={styles.root}>{webView}</View>;
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, contentBottomInset ? { paddingBottom: contentBottomInset + 24 } : null]}
    >
      {webView}
    </ScrollView>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    content: { padding: 12 },
    web: { width: '100%', backgroundColor: c.surface, borderRadius: 8 },
    webFill: { flex: 1, width: '100%', backgroundColor: c.surface },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    hint: { fontSize: 13, color: c.placeholder },
  });
}
