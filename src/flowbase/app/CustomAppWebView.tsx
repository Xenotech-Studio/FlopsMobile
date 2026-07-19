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
   * 缺省 false，保持页内嵌入行为不变。同时也是安全区自动内缩的开关（见 shim __SAFE_AREA_AUTO__）。
   */
  fillHeight?: boolean;
  /**
   * 设备信息（安全区 / 胶囊 / DPR…）。全屏 Applet 由 AppletScreen 用真实 insets 计算后传入，注入到
   * app 的 `--fb-*` CSS 变量 + `FlowBaseSDK.device`。缺省（页内嵌入）用 ZERO_DEVICE（全 0、无胶囊）。
   */
  device?: FlowBaseDevice;
  /**
   * 初始页（类小程序原生翻页）：子页 WebView 载入同一份 HTML，但通过它决定首屏展示哪个「页」。
   * 注入到 `window.FlowBaseSDK.initialPage`，并作为 `<html data-page="...">` 属性挂上——HTML 在加载
   * 时据此显示对应 div（JS 读 SDK.initialPage 或 CSS `html[data-page="x"] #page-x{display:block}`）。
   * 缺省（主页 / 页内嵌入）为 undefined，行为不变。
   */
  initialPage?: string;
  /**
   * 原生翻页回调：App 内调 `FlowBaseSDK.navigate('page',{title})` 时触发（走 navigate RPC）。全屏 Applet
   * 由承载屏据此 push 一层原生子页（右滑入 + 原生返回手势）。缺省则该调用静默解析、不做原生跳转。
   */
  onNavigate?: (args: { page?: string; title?: string }) => void;
};

// 设备信息（与桌面 AppView.jsx 语义一比一对齐）。
export type FlowBaseCapsule = {
  /** 相对安全区顶的 y（=距安全区顶的间隙） */
  top: number;
  height: number;
  /** 距屏幕左沿的 x（左/右两端） */
  left: number;
  right: number;
  width: number;
} | null;

export type FlowBaseDevice = {
  env: string; // 'native' | 'preview'
  pixelRatio: number;
  safeAreaInsets: { top: number; right: number; bottom: number; left: number };
  statusBarHeight: number;
  homeIndicatorHeight: number;
  keyboardHeight: number;
  capsule: FlowBaseCapsule;
};

// 缺省零安全区（页内嵌入 / 无设备信息时用）——全 0、无胶囊、env:'preview'。
const ZERO_DEVICE: FlowBaseDevice = {
  env: 'preview',
  pixelRatio: 1,
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  statusBarHeight: 0,
  homeIndicatorHeight: 0,
  keyboardHeight: 0,
  capsule: null,
};

// 注入 WebView 的 SDK shim：RN 版走 ReactNativeWebView.postMessage + window.__flowbaseDeliver 回传。
// 设备信息（安全区/胶囊/DPR…）与桌面 AppView 完全同构：
//   · 初值由 buildHtml 把 __*__ 占位替换成真实数值烘入（首帧即就位、不闪）；
//   · 后续变化（转屏/键盘）由原生侧 webRef.injectJavaScript(window.__flowbaseSetDevice(...)) 推送；
//   · CSS 变量 --fb-*（给 CSS 写 var()）与 window.FlowBaseSDK.device（给 JS 读）是同一份 _device 的两种投影。
// __SAFE_AREA_AUTO__ 为 true（全屏 Applet）时，还会把上下安全区 padding 自动贴到 <html>、由 <body> 接管
// 滚动——多数 app 不写任何 CSS 也自动避让状态栏 / home indicator（想全出血：html{padding:0!important}）。
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
  // —— 设备信息 ——（占位由 buildHtml 烘入）
  var _device={
    env:__DEVICE_ENV__,
    pixelRatio:__DEVICE_PIXEL_RATIO__,
    safeAreaInsets:{top:__SAFE_AREA_TOP__,right:__SAFE_AREA_RIGHT__,bottom:__SAFE_AREA_BOTTOM__,left:__SAFE_AREA_LEFT__},
    statusBarHeight:__STATUS_BAR_HEIGHT__,
    homeIndicatorHeight:__HOME_INDICATOR_HEIGHT__,
    keyboardHeight:__KEYBOARD_HEIGHT__,
    capsule:__DEVICE_CAPSULE__
  };
  var _safeAreaAuto=__SAFE_AREA_AUTO__;
  // —— 初始页（类小程序原生翻页）——（占位由 buildHtml 烘入；主页/无翻页时为 null）
  // 挂到 <html data-page="...">，App 可用 CSS(html[data-page="x"] #page-x{display:block}) 或读 SDK.initialPage
  // 来决定首屏展示哪个「页」。<html> 元素在 head 脚本执行时已存在，可即刻设属性（首帧就位、不闪）。
  var _initialPage=__INITIAL_PAGE__;
  function _applyInitialPage(){
    if(!_initialPage)return; var root=document.documentElement; if(!root)return;
    try{root.setAttribute('data-page',String(_initialPage));}catch(e){}
  }
  _applyInitialPage();
  if(_initialPage&&document.readyState==='loading') document.addEventListener('DOMContentLoaded',_applyInitialPage);
  var _deviceListeners=[];
  function _applyDeviceCSS(d){
    var root=document.documentElement; if(!root)return;
    var s=d.safeAreaInsets||{};
    root.style.setProperty('--fb-safe-area-top',(s.top||0)+'px');
    root.style.setProperty('--fb-safe-area-right',(s.right||0)+'px');
    root.style.setProperty('--fb-safe-area-bottom',(s.bottom||0)+'px');
    root.style.setProperty('--fb-safe-area-left',(s.left||0)+'px');
    root.style.setProperty('--fb-status-bar-height',(d.statusBarHeight||0)+'px');
    root.style.setProperty('--fb-home-indicator-height',(d.homeIndicatorHeight||0)+'px');
    root.style.setProperty('--fb-keyboard-height',(d.keyboardHeight||0)+'px');
    root.style.setProperty('--fb-pixel-ratio',String(d.pixelRatio||1));
    // 右上角胶囊：top 相对安全区顶、left/right 距屏幕左沿；无胶囊 → 全 0（app 用 var(--fb-capsule-*,0px) 降级）。
    var c=d.capsule||{};
    root.style.setProperty('--fb-capsule-top',(c.top||0)+'px');
    root.style.setProperty('--fb-capsule-height',(c.height||0)+'px');
    root.style.setProperty('--fb-capsule-left',(c.left||0)+'px');
    root.style.setProperty('--fb-capsule-right',(c.right||0)+'px');
  }
  // 全屏 Applet 才做：<html> 占满 viewport + 上下安全区 padding + 关 viewport 滚动，<body> 接管滚动。
  // 页内嵌入(_safeAreaAuto=false)不动 html/body，保持外层 ScrollView 自测高。
  function _applySafeArea(){
    var b=document.body; if(!b)return;
    var root=document.documentElement;
    var cs=getComputedStyle(root);
    root.style.height='100%'; root.style.width='100%'; root.style.boxSizing='border-box'; root.style.overflow='hidden';
    root.style.paddingTop=cs.getPropertyValue('--fb-safe-area-top')||'0px';
    root.style.paddingBottom=cs.getPropertyValue('--fb-safe-area-bottom')||'0px';
    b.style.minHeight='100%'; b.style.boxSizing='border-box'; b.style.overflow='auto';
  }
  _applyDeviceCSS(_device);
  if(_safeAreaAuto){
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_applySafeArea); else _applySafeArea();
  }
  // 原生侧推送设备信息变化（转屏/键盘/尺寸）：更新 _device → 刷 CSS 变量(+安全区内缩) → 通知 onChange 订阅者。
  window.__flowbaseSetDevice=function(d){
    if(!d||typeof d!=='object')return;
    _device=d; _applyDeviceCSS(_device); if(_safeAreaAuto)_applySafeArea();
    for(var i=0;i<_deviceListeners.length;i++){ try{_deviceListeners[i](_device);}catch(e){} }
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
  window.FlowBaseSDK={
    version:1,
    baseId:__BASE_ID__,
    // 子页首屏应展示的「页」标识（主页/无翻页为 null）。App 加载时读它决定显示哪个 div。
    initialPage:_initialPage,
    table:function(n){return tableHandle(n);},
    dashboard:function(n){return dashboardHandle(n);},
    // 原生翻页：请求承载屏 push 一层原生子页（右滑入 + 原生返回）。子页会以 initialPage=page 载入同一份
    // HTML。返回的 Promise 在原生受理后 resolve（不代表页面已切；仅表示已请求）。承载屏未接管时静默解析。
    navigate:function(page,opts){return rpc('navigate',{page:page,title:opts&&opts.title});},
    // 设备信息：同步只读快照 + onChange 订阅（首帧即可同步读，勿 await）。安全区读这里或 var(--fb-*)。
    device:{
      get env(){return _device.env;},
      get pixelRatio(){return _device.pixelRatio;},
      get safeAreaInsets(){return _device.safeAreaInsets;},
      get statusBarHeight(){return _device.statusBarHeight;},
      get homeIndicatorHeight(){return _device.homeIndicatorHeight;},
      get keyboardHeight(){return _device.keyboardHeight;},
      get capsule(){return _device.capsule;},
      get:function(){return _device;},
      onChange:function(cb){
        if(typeof cb!=='function')return function(){};
        _deviceListeners.push(cb);
        return function(){_deviceListeners=_deviceListeners.filter(function(f){return f!==cb;});};
      }
    }
  };
  function reportHeight(){
    var h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0);
    window.ReactNativeWebView.postMessage(JSON.stringify({__flowbase_resize:true,height:h}));
  }
  window.addEventListener('load',reportHeight);
  if(window.ResizeObserver&&document.body)new ResizeObserver(reportHeight).observe(document.body);
  setTimeout(reportHeight,50);
})();`;

// 把 shim 里的占位符替换成真实/模拟数值（与桌面 buildSrcDoc 同风格；全局替换避免遗漏）。
function bakeShim(
  baseId: string,
  device: FlowBaseDevice | undefined,
  safeAreaAuto: boolean,
  initialPage: string | undefined,
): string {
  const dev = device || ZERO_DEVICE;
  const sa = dev.safeAreaInsets || { top: 0, right: 0, bottom: 0, left: 0 };
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cap = dev.capsule;
  const capLiteral = cap
    ? JSON.stringify({
        top: num(cap.top),
        height: num(cap.height),
        left: num(cap.left),
        right: num(cap.right),
        width: num(cap.width != null ? cap.width : num(cap.right) - num(cap.left)),
      })
    : 'null';
  return SDK_SHIM.replace(/__BASE_ID__/g, JSON.stringify(String(baseId || '')))
    .replace(/__DEVICE_ENV__/g, JSON.stringify(String(dev.env || 'preview')))
    .replace(/__DEVICE_PIXEL_RATIO__/g, String(num(dev.pixelRatio) || 1))
    .replace(/__SAFE_AREA_TOP__/g, String(num(sa.top)))
    .replace(/__SAFE_AREA_RIGHT__/g, String(num(sa.right)))
    .replace(/__SAFE_AREA_BOTTOM__/g, String(num(sa.bottom)))
    .replace(/__SAFE_AREA_LEFT__/g, String(num(sa.left)))
    .replace(/__STATUS_BAR_HEIGHT__/g, String(num(dev.statusBarHeight)))
    .replace(/__HOME_INDICATOR_HEIGHT__/g, String(num(dev.homeIndicatorHeight)))
    .replace(/__KEYBOARD_HEIGHT__/g, String(num(dev.keyboardHeight)))
    .replace(/__DEVICE_CAPSULE__/g, capLiteral)
    .replace(/__SAFE_AREA_AUTO__/g, safeAreaAuto ? 'true' : 'false')
    .replace(/__INITIAL_PAGE__/g, initialPage ? JSON.stringify(String(initialPage)) : 'null');
}

function buildHtml(
  source: string,
  baseId: string,
  device: FlowBaseDevice | undefined,
  safeAreaAuto: boolean,
  initialPage: string | undefined,
): string {
  const shim = bakeShim(baseId, device, safeAreaAuto, initialPage);
  // default-src 'none' 封死一切网络；仅放行内联脚本/样式 + data: 图片，供 App 源码运行。
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  // data-page 直接烘在 <html> 标签上：首次 parse 即就位，CSS `html[data-page="x"]{}` 无闪切；
  // shim 里再兜一次（DOMContentLoaded），双保险。属性值转义引号，防止破坏标签。
  const pageAttr = initialPage ? ` data-page="${String(initialPage).replace(/"/g, '&quot;')}"` : '';
  return (
    `<!doctype html><html${pageAttr}><head><meta charset="utf-8">` +
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

export function CustomAppWebView({
  baseId,
  appId,
  tables,
  contentBottomInset,
  fillHeight,
  device,
  initialPage,
  onNavigate,
}: CustomAppWebViewProps) {
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const webRef = useRef<WebView>(null);
  // 设备信息初值烘进 HTML（首帧就位、不闪）；后续变化经 injectJavaScript 推送，不重建 WebView。
  // 用 ref 读当前值供 html 首次烘焙，避免把 device 放进 html 的 useMemo 依赖（否则一变就重载丢状态）。
  const deviceRef = useRef(device);
  deviceRef.current = device;
  // onNavigate 用 ref 读，避免把它塞进 onMessage 依赖（承载屏每次 render 传新函数会白重建 onMessage）。
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

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
      // navigate：不走数据 RPC 白名单，转交承载屏做原生 push；受理后即 resolve（承载屏未接管则静默 resolve）。
      if (String(d.method || '') === 'navigate') {
        const a = (d.args as { page?: unknown; title?: unknown }) || {};
        const page = a.page != null ? String(a.page) : undefined;
        const title = a.title != null ? String(a.title) : undefined;
        onNavigateRef.current?.({ page, title });
        reply({ result: { ok: true } });
        return;
      }
      handleRpc(String(d.method || ''), (d.args as Record<string, unknown>) || {})
        .then((result) => reply({ result }))
        .catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }));
    },
    [handleRpc],
  );

  const html = useMemo(
    () => (app ? buildHtml(app.config?.source || '', baseId, deviceRef.current, !!fillHeight, initialPage) : ''),
    [app, baseId, fillHeight, initialPage],
  );

  // device 运行时变化（转屏 / 键盘 / 尺寸）→ 推进 WebView，无需重建（守 __flowbaseSetDevice 已就绪）。
  useEffect(() => {
    if (!device) return;
    webRef.current?.injectJavaScript(
      `window.__flowbaseSetDevice && window.__flowbaseSetDevice(${JSON.stringify(device)}); true;`,
    );
  }, [device]);

  // 每次加载完成后按当前 device 再刷一次：兜住「加载期间 device 变过 / 首帧注入早于 shim 就绪」的竞态。
  const onLoadEnd = useCallback(() => {
    const d = deviceRef.current;
    if (!d) return;
    webRef.current?.injectJavaScript(
      `window.__flowbaseSetDevice && window.__flowbaseSetDevice(${JSON.stringify(d)}); true;`,
    );
  }, []);

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
      onLoadEnd={onLoadEnd}
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
