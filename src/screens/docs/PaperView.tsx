/**
 * PaperView —— paper 类型文档的移动端查看器（对齐 web PaperEditor 的「查看」部分）。
 *
 * 两个视图，顶部胶囊切换：
 *  - PDF：react-native-pdf 读 meta.pdf_url（原生 PDFKit/Pdfium，翻页/缩放原生支持）
 *  - HTML：调 /api/paper/fetch-arxiv-html(variant=processed) 拿后处理正文，喂 WebView
 *          （baseUrl=arxiv_html_url 解析相对图片/链接；WebView 本身隔离，省掉 web 的 Shadow DOM）。
 *          参考文献内联在返回的 HTML 里展示（折中：不另做原生列表 + 悬停卡）。
 *  HTML 标签仅在 meta.arxiv_html_url 存在时出现。无缓存时给「获取 HTML」按钮触发服务端爬取。
 *
 * 作者向能力（上传/替换 PDF、重解析、重后处理、锁定、variant 切换）留 web/桌面，移动端只读。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Pdf from 'react-native-pdf';
import { WebView } from 'react-native-webview';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { fetchPaperArxivHtml } from '../../api';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';

type PaperMeta = Record<string, unknown> | null | undefined;

function metaString(meta: PaperMeta, key: string): string {
  const v = meta?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

export type ViewMode = 'pdf' | 'html';

export type PaperViewProps = {
  docId: string;
  meta: PaperMeta;
  /** 受控视图模式（切换器在 DocPreviewScreen 的 header 居中渲染）。 */
  viewMode: ViewMode;
  contentTopInset?: number;
  contentBottomInset?: number;
};

/** paper meta 是否有 arXiv HTML 入口（决定 header 是否显示 PDF/HTML 切换器）。 */
export function paperHasHtml(meta: PaperMeta): boolean {
  return metaString(meta, 'arxiv_html_url') !== '';
}

/** paper 锚点内嵌子文档引用（对齐 web normalizeSubdocRefs）：meta.subdocs = [{id,type}]。 */
export type SubdocRef = { id: string; type: string };
export function normalizeSubdocRefs(meta: PaperMeta): SubdocRef[] {
  const raw = meta?.subdocs;
  if (!Array.isArray(raw)) return [];
  const out: SubdocRef[] = [];
  for (const x of raw) {
    if (x && typeof x === 'object') {
      const id = (x as Record<string, unknown>).id;
      const type = (x as Record<string, unknown>).type;
      if (typeof id === 'string' && id && typeof type === 'string' && type) {
        out.push({ id, type });
      }
    }
  }
  return out;
}
/** html 加载态：idle 未拉 / loading / ready 有内容 / miss 服务端无缓存 / error */
type HtmlState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'miss' }
  | { kind: 'error'; error: string };

export function PaperView({ docId, meta, viewMode, contentTopInset, contentBottomInset }: PaperViewProps) {
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const pdfUrl = metaString(meta, 'pdf_url');
  const arxivHtmlUrl = metaString(meta, 'arxiv_html_url');
  const htmlAvailable = arxivHtmlUrl !== '';

  const [htmlState, setHtmlState] = useState<HtmlState>({ kind: 'idle' });
  /** 丢弃切文档/换 URL 后仍返回的旧 fetch */
  const reqSeqRef = useRef(0);

  const loadHtml = useCallback(
    async (opts: { cacheOnly: boolean; forceRefresh?: boolean }) => {
      if (!session || !docId) return;
      reqSeqRef.current += 1;
      const seq = reqSeqRef.current;
      setHtmlState({ kind: 'loading' });
      try {
        const r = await fetchPaperArxivHtml(session, {
          itemId: docId,
          variant: 'processed',
          cacheOnly: opts.cacheOnly,
          forceRefresh: opts.forceRefresh,
        });
        if (seq !== reqSeqRef.current) return;
        if (!r.ok) {
          setHtmlState({ kind: 'error', error: r.error || '加载失败' });
          return;
        }
        if (r.cacheMiss || !r.html) {
          // cache_only 命中空 → 提示用户主动获取；非 cache_only 仍空 → 也按 miss 处理
          setHtmlState(opts.cacheOnly ? { kind: 'miss' } : { kind: 'error', error: '未获取到 HTML 内容' });
          return;
        }
        setHtmlState({ kind: 'ready', html: r.html });
      } catch (e) {
        if (seq !== reqSeqRef.current) return;
        setHtmlState({ kind: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    },
    [session, docId],
  );

  // 切到 HTML 且还没拉过 → 先读缓存（不触发爬取）
  useEffect(() => {
    if (viewMode === 'html' && htmlAvailable && htmlState.kind === 'idle') {
      loadHtml({ cacheOnly: true });
    }
  }, [viewMode, htmlAvailable, htmlState.kind, loadHtml]);

  // 切文档：重置 html 加载态。只认 docId（文档真身份）——pdfUrl/arxivHtmlUrl 在渲染中可能
  // 短暂变化导致多跑一次、把在飞的请求作废。也不再 bump reqSeqRef（并发由 loadHtml 自己的 seq 管，
  // reset 不该误杀刚发出的请求）。
  useEffect(() => {
    setHtmlState({ kind: 'idle' });
  }, [docId]);

  // HTML 不可用却被切到 html（理论上 header 不会给入口）→ 兜底当 pdf
  const mode: ViewMode = viewMode === 'html' && htmlAvailable ? 'html' : 'pdf';

  const topPad = contentTopInset ?? 0;
  const botPad = contentBottomInset ?? 0;

  /* 沉浸式：内容贯穿全高（root flex:1，无 padding），顶部 Blur 头 + 底部渐变遮罩由 DocPreviewScreen
     盖在上面。PDF/WebView 都铺满；正文避开遮罩靠各自的内部 inset（PDF=滚动 contentInset，
     HTML=注入 body padding），背景仍贯穿到遮罩下。 */
  return (
    <View style={styles.root}>
      {mode === 'pdf' ? (
        pdfUrl ? (
          /* 全宽贯穿（PDF 滚动时延伸到顶）；contentInsetTop（patch 加的原生 prop）让静止(offset 0)时
             顶部留出 header+安全区高度。要调留白就改这个值。 */
          <Pdf
            source={{ uri: pdfUrl, cache: true }}
            style={styles.pdf}
            // 全宽无边缘（对齐 web）：按宽适配、页间距 0
            fitPolicy={0}
            spacing={0}
            // 顶部留白（静止时）：比完整 header 高略小一点，更紧凑。调系数即可。
            contentInsetTop={Math.round(topPad)}
            trustAllCerts={false}
            onError={() => {}}
          />
        ) : (
          <Centered styles={styles} colors={colors} icon="document-outline" title="无 PDF" hint="本论文还没有关联 PDF 文件" />
        )
      ) : (
        <HtmlBody
          state={htmlState}
          baseUrl={arxivHtmlUrl}
          topInset={topPad}
          bottomInset={botPad}
          styles={styles}
          colors={colors}
          onFetch={() => loadHtml({ cacheOnly: false })}
          onRefresh={() => loadHtml({ cacheOnly: false, forceRefresh: true })}
        />
      )}
    </View>
  );
}

/** 给后处理 HTML 注入 body 内边距：
 *  - 上下 = 顶/底遮罩高度，让正文避开遮罩（背景仍贯穿到遮罩下）
 *  - 左右 = clamp(12px,2.4vw,28px)，对齐 web 后处理给正文容器加的左右留白，避免文字贴边 */
function injectScrollInset(html: string, top: number, bottom: number): string {
  /* 约束版心 + 宽媒体不溢出（对齐 web 后处理给 .paper-html-shadow-inner 注入的那套）：
     - body 上下避开遮罩、左右 clamp 留白、overflow-x:hidden + 长词折行，杜绝整页横向滚动
     - 图片/svg/video 限 max-width:100%；带 width/height 属性的小图标保留其约束（height:auto 只给无尺寸图）
     - 宽表格/pre/公式（mjx-container）各自内部横滚，而不是把整页撑宽 */
  /* viewport：后处理 HTML 常缺 <meta viewport>，WebView 会按默认 ~980px 布局再缩放，
     导致横向溢出 + 图被压窄。强制 width=device-width 让 max-width:100% 真的等于屏宽。 */
  const viewport = `<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">`;
  const style =
    `<style>` +
    /* 横向用 overflow-x:clip（硬裁剪，不产生滚动容器、也不会像 hidden 那样把 overflow-y 逼成 auto）：
       - hidden 放 body 会让 body 变纵向滚动容器 → 两个滚动嵌套；只放 html 又拦不住 WKWebView 的横向 pan。
       - clip 两个都放：横向真裁掉（contentSize 不再超宽 → 无横向 pan → 不跟 pager 抢），纵向仍只有一个滚动器。
       （overflow:clip 需 iOS16+ WebKit；iOS15 忽略退回有横滚，属极少数。） */
    `html{margin:0!important;width:100%!important;max-width:100%!important;overflow-x:clip!important;-webkit-overflow-scrolling:touch;}` +
    `body{margin:0!important;width:100%!important;max-width:100%!important;overflow-x:clip!important;box-sizing:border-box;overflow-wrap:anywhere;-webkit-overflow-scrolling:touch;` +
    `padding-top:${Math.round(Math.max(top, 0))}px !important;` +
    `padding-bottom:${Math.round(Math.max(bottom, 0))}px !important;` +
    `padding-left:clamp(12px,2.4vw,28px) !important;` +
    `padding-right:clamp(12px,2.4vw,28px) !important;}` +
    /* 关键：对「一切元素」都 max-width:100%——逐层级联到视口内，任何宽容器/表格/图/公式都收住，
       WebView 内不再有横向溢出（也就不会有跟 pager 抢手势的内部横滚）。min-width:0 防止 min-width 撑宽。
       公式若是 SVG 输出，max-width:100% 会等比缩小到适配（不变形）。 */
    `*{max-width:100%!important;min-width:0!important;box-sizing:border-box;}` +
    // 图/svg/video 高度自适应保宽高比（行内带 width/height 的小图标不在此列，保留固定高不炸开）
    `img:not([width]):not([height]),svg,picture,video{height:auto;}` +
    `figure img,.ltx_figure img,.ltx_graphics{height:auto!important;}` +
    // 宽表格/代码/公式：裁剪、绝不内部横滚（WebView 内任何横滚都会跟 pager 横滑抢手势）
    `table,.ltx_tabular,pre,mjx-container{overflow-x:hidden!important;}` +
    `</style>`;
  const inject = viewport + style;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  return inject + html;
}

/** 后处理 HTML 的 WebView，含渲染期加载遮罩（盖住 HTML/MathJax 还在排版、内容高度未定、
 *  暂时滚不动的那段空窗）+ 禁横向滚动条。 */
function HtmlWebView({
  html,
  baseUrl,
  topInset,
  bottomInset,
  styles,
  colors,
  onRefresh,
}: {
  html: string;
  baseUrl: string;
  topInset: number;
  bottomInset: number;
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
  onRefresh: () => void;
}) {
  const injected = useMemo(() => injectScrollInset(html, topInset, bottomInset), [html, topInset, bottomInset]);
  /* source 必须 memo：每次渲染新建 {html} 对象会让 WebView 反复 reload → 永远 loading。 */
  const source = useMemo(
    () => ({ html: injected, baseUrl: baseUrl || undefined }),
    [injected, baseUrl],
  );
  return (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      <WebView
        source={source}
        style={styles.webview}
        originWhitelist={['*']}
        showsHorizontalScrollIndicator={false}
        decelerationRate={0.998}
        directionalLockEnabled
        // 链接走系统浏览器，不在内嵌 WebView 里跳走整页
        onShouldStartLoadWithRequest={(req) => {
          if (req.url === 'about:blank' || req.url.startsWith('data:')) return true;
          if (req.navigationType === 'click') {
            Linking.openURL(req.url).catch(() => {});
            return false;
          }
          return true;
        }}
      />
      <TouchableOpacity style={styles.refreshFab} onPress={onRefresh} activeOpacity={0.8} accessibilityLabel="重新爬取 HTML">
        <Ionicons name="refresh" size={16} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

function HtmlBody({
  state,
  baseUrl,
  topInset,
  bottomInset,
  styles,
  colors,
  onFetch,
  onRefresh,
}: {
  state: HtmlState;
  baseUrl: string;
  topInset: number;
  bottomInset: number;
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
  onFetch: () => void;
  onRefresh: () => void;
}) {
  if (state.kind === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.textMuted} />
        <Text style={styles.hint}>正在加载 arXiv HTML…</Text>
      </View>
    );
  }
  if (state.kind === 'ready') {
    return <HtmlWebView html={state.html} baseUrl={baseUrl} topInset={topInset} bottomInset={bottomInset} styles={styles} colors={colors} onRefresh={onRefresh} />;
  }
  if (state.kind === 'miss') {
    return (
      <View style={styles.centered}>
        <Ionicons name="globe-outline" size={44} color={colors.placeholder} style={{ marginBottom: 12 }} />
        <Text style={styles.emptyTitle}>尚未缓存 HTML</Text>
        <Text style={styles.hint}>服务端还没有这篇论文的 arXiv HTML 快照，点击获取（首次爬取较慢）</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={onFetch} activeOpacity={0.85}>
          <Text style={styles.primaryBtnText}>获取 HTML</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{state.error}</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={onFetch} activeOpacity={0.85}>
          <Text style={styles.primaryBtnText}>重试获取</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return <View style={styles.centered}><ActivityIndicator color={colors.textMuted} /></View>;
}

function Centered({
  styles,
  colors,
  icon,
  title,
  hint,
}: {
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
  icon: string;
  title: string;
  hint: string;
}) {
  return (
    <View style={styles.centered}>
      <Ionicons name={icon} size={48} color={colors.placeholder} style={{ marginBottom: 12, opacity: 0.6 }} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    root: { flex: 1 },
    // PDF 全宽贯穿；底色 = 白（跟 PDF 页面一致），过度下拉/页间露出的也是白，不跳色
    pdf: { flex: 1, backgroundColor: '#fff' },
    webview: { flex: 1, backgroundColor: '#fff' },
    webLoadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
    },
    refreshFab: {
      position: 'absolute',
      right: 16,
      bottom: 16,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    emptyTitle: { fontSize: 15, fontWeight: '600', color: c.textMuted, marginBottom: 6 },
    hint: { fontSize: 13, color: c.placeholder, textAlign: 'center', lineHeight: 19, marginTop: 4 },
    errorText: { fontSize: 13, color: c.placeholder, textAlign: 'center', marginBottom: 12 },
    primaryBtn: {
      marginTop: 16,
      paddingHorizontal: 20,
      paddingVertical: 9,
      borderRadius: 18,
      backgroundColor: c.surfaceMuted,
    },
    primaryBtnText: { fontSize: 14, color: c.textPrimary, fontWeight: '500' },
  });
}
