/**
 * VisualWidgetCard —— show_visual 图卡（移动端）。
 *
 * 与 Web/Desktop 的 flops-chat-ui/ToolBlock/cards/VisualWidgetCard.jsx 同一形态：
 *   · **裸模式**：不套 ToolCardFrame，没有边框/底色/标题栏/状态徽章，透明容器直接嵌在对话流里，
 *     观感等同正文里的一张图；
 *   · 受控 WebView 跑同一份 widget_code（CSP 封网 + 自测高 + sendPrompt 回注），与桌面 iframe 同构；
 *   · 回注：图内调 sendPrompt(text) → postMessage 给原生 → onEcho(text) → 宿主拼【图卡·title】发新消息。
 *
 * WebView 用法对齐仓内既有沙箱实现 flowbase/app/CustomAppWebView.tsx（originWhitelist/关滚动/
 * 禁外链跳转/自测高那套），别再另起一套。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { AppColors } from '../../theme/appColors';
import { toolCardPropsEqual } from './toolCardMemo';

export type VisualWidgetCardProps = {
  /** SVG 源码，或单文件 HTML 的 <body> 内容 */
  code: string;
  /** 'svg' | 'html'；其它值按 html 处理 */
  mode: string;
  /** 卡片标题，同时是回注溯源标识 */
  title: string;
  /** 工具是否已完成（未完成不建 HTML，避免流式期未闭合标签反复重载 WebView） */
  isCompleted: boolean;
  /** 后端判失败时的错误文案；非空则只渲染一行小字 */
  error?: string;
  colors: AppColors;
  isDark: boolean;
  /** 图内 sendPrompt(text) 的落地：宿主据此拼前缀并作为新用户消息发出 */
  onEcho?: (text: string) => void;
};

const HEIGHT_MIN = 80;
const HEIGHT_MAX = 4000;
const HEIGHT_DEFAULT = 180;

/** 单次回注文本上限（与 Web WIDGET_ECHO_MAX_TEXT 同口径） */
const ECHO_MAX_TEXT = 4000;
/** 同卡两次回注的最小间隔，挡误触连点与脚本循环（与 Web WIDGET_ECHO_DEBOUNCE_MS 一致） */
const ECHO_DEBOUNCE_MS = 400;
/** postMessage 哨兵字段名（与 Web WIDGET_MSG_SENTINEL 一致） */
const MSG_SENTINEL = '__flops_widget';

/**
 * 注入 WebView 的 shim（烘进 <head>，保证 body 里的用户脚本调用时它已就位）：
 *   · sendPrompt(text)：这张卡与外界通信的**唯一出口**，只发文本；
 *   · 自动测高：body 尺寸变化 → postMessage 高度给原生，WebView 高度随内容自适应。
 * 走 window.ReactNativeWebView.postMessage（RN 桥）而非 parent.postMessage —— 这是与桌面版
 * 唯一的实质差异，消息体形状保持一致。
 */
const WIDGET_SHIM = `(function(){
  var SENT = __SENTINEL__;
  var MAX = __MAX_TEXT__;
  var seq = 0;
  function post(kind, patch){
    var msg = { kind: kind };
    msg[SENT] = true;
    for (var k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) msg[k] = patch[k]; }
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }
  function nonce(){ seq += 1; return 'w' + Date.now().toString(36) + '-' + seq; }
  window.sendPrompt = function(text){
    var t = String(text == null ? '' : text);
    if (!t.trim()) return false;
    post('send', { text: t.slice(0, MAX), nonce: nonce() });
    return true;
  };
  // 测高优先取 body 的盒子：documentElement.scrollHeight 会被 viewport 兜底（永远 >= 当前
  // WebView 高度），拿它当主口径的话高度只增不减，内容变矮后会留一大片空白。body 没这个钳制。
  // 向上取整：真实高度常带小数（行高算出来 400.4px），向下取整会差那零点几像素导致内容被裁。
  function reportHeight(){
    var b = document.body;
    var de = document.documentElement;
    var h = b ? Math.max(b.scrollHeight, b.offsetHeight, b.getBoundingClientRect().height) : 0;
    if (!(h > 0)) h = de ? de.scrollHeight : 0;
    post('resize', { height: Math.ceil(h) });
  }
  function setupHeight(){
    reportHeight();
    if (window.ResizeObserver && document.body) { new ResizeObserver(reportHeight).observe(document.body); }
    setTimeout(reportHeight, 50);
    setTimeout(reportHeight, 300);
  }
  if (document.readyState === 'complete') setupHeight();
  else window.addEventListener('load', setupHeight);
})();`;

/** 封网 CSP：不给任何网络出口，只放行内联脚本/样式与 data: 图片字体（与 Web/Desktop 逐字一致）。 */
const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/** 组装 WebView 的 HTML：CSP + shim + 用户代码。svg 与 html 只差外层包裹与基础样式。 */
function buildHtml(mode: string, code: string, theme: 'light' | 'dark'): string {
  const shim = WIDGET_SHIM.replace(/__SENTINEL__/g, JSON.stringify(MSG_SENTINEL)).replace(
    /__MAX_TEXT__/g,
    String(ECHO_MAX_TEXT),
  );
  const body = mode === 'svg' ? `<div class="flops-vw-svg-wrap">${code || ''}</div>` : code || '';
  return (
    `<!doctype html><html data-theme="${theme}" style="color-scheme:${theme}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>html,body{margin:0;padding:0;background:transparent;` +
    `font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;}` +
    // 滚动条轨道无论何时都不显示（同 Web 版；WebView 内是独立文档，宿主样式进不来）
    `html{scrollbar-width:none;-ms-overflow-style:none;}` +
    `html::-webkit-scrollbar,body::-webkit-scrollbar{display:none;width:0;height:0;}` +
    // 只在 svg 模式的包裹层限宽：html 模式作者自管排版
    `.flops-vw-svg-wrap{display:flex;justify-content:center;}` +
    `.flops-vw-svg-wrap>svg{max-width:100%;height:auto;display:block;}</style>` +
    `<script>${shim}</script>` +
    `</head><body>${body}</body></html>`
  );
}

function VisualWidgetCardImpl({
  code,
  mode,
  title,
  isCompleted,
  error,
  colors,
  isDark,
  onEcho,
}: VisualWidgetCardProps) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [height, setHeight] = useState(HEIGHT_DEFAULT);
  const lastSendAtRef = useRef(0);
  const lastNonceRef = useRef('');

  // 完成态才建 HTML：流式期参数还没闭合，边流边渲会让 WebView 反复重载。
  // 主题进 deps：移动端跟随系统深浅色切换很常见，宁可重载一次也别让图表停在错的配色上
  //（桌面版为了保住 widget 交互态选择不重建，这里取舍相反）。
  const html = useMemo(() => {
    if (!isCompleted || error || !code.trim()) return '';
    return buildHtml(mode === 'svg' ? 'svg' : 'html', code, isDark ? 'dark' : 'light');
  }, [isCompleted, error, code, mode, isDark]);

  const onMessage = useCallback(
    (ev: WebViewMessageEvent) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(ev.nativeEvent.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!d || d[MSG_SENTINEL] !== true) return;
      if (d.kind === 'resize') {
        const h = Number(d.height);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(h, HEIGHT_MIN), HEIGHT_MAX));
        return;
      }
      if (d.kind !== 'send') return;
      const text = String(d.text == null ? '' : d.text)
        .trim()
        .slice(0, ECHO_MAX_TEXT);
      if (!text) return;
      const nonce = String(d.nonce || '');
      if (nonce && nonce === lastNonceRef.current) return; // 同一次点击的重复投递
      const now = Date.now();
      if (now - lastSendAtRef.current < ECHO_DEBOUNCE_MS) return;
      lastSendAtRef.current = now;
      lastNonceRef.current = nonce;
      onEcho?.(text);
    },
    [onEcho],
  );

  if (error) {
    return (
      <View style={styles.root}>
        <Text style={styles.msgErr}>{error}</Text>
      </View>
    );
  }
  if (!isCompleted) {
    return (
      <View style={styles.root}>
        <Text style={styles.msg}>正在生成可视化…</Text>
      </View>
    );
  }
  if (!html) {
    return (
      <View style={styles.root}>
        <Text style={styles.msg}>没有可渲染的内容</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <WebView
        source={{ html }}
        originWhitelist={['about:*']}
        javaScriptEnabled
        onMessage={onMessage}
        // 高度随内容自适应，自己不滚（外层聊天列表负责滚动）
        scrollEnabled={false}
        nestedScrollEnabled={false}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        // 禁止跳外部（放行 about:/data: 初始加载）；CSP 已封网，双保险
        onShouldStartLoadWithRequest={(req) => !/^(https?|file):/i.test(req.url || '')}
        // 透明底：图卡直接嵌在对话流里，不能有 WebView 默认白底
        opaque={false}
        backgroundColor="transparent"
        androidLayerType="hardware"
        style={[styles.web, { height }]}
        accessibilityLabel={title || '可视化'}
      />
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    // 裸容器：无背景/边框/圆角/内边距，只留极小的垂直呼吸
    root: { width: '100%', marginVertical: 2 },
    web: { width: '100%', backgroundColor: 'transparent' },
    // 加载/无内容/错误：小字弱色，融进正文不抢戏
    msg: { fontSize: 11, lineHeight: 16, color: c.textMuted },
    msgErr: { fontSize: 11, lineHeight: 16, color: c.danger },
  });
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const VisualWidgetCard = React.memo(
  VisualWidgetCardImpl,
  toolCardPropsEqual<VisualWidgetCardProps>(['code', 'mode', 'title', 'isCompleted', 'error', 'colors', 'isDark'])
);

export default VisualWidgetCard;
