/**
 * DocPreviewScreen —— 文档下钻的"整页"预览页（替代旧 DocsScreen 内部的横向面板栈）。
 *
 * 路由参数只携带 { id }；本页用 docsTreeStore 把 id 解析成项本身 + 直接子项：
 *  - 文件夹（folder / cooperateInbox）→ FolderView，点子项 → push 更深一层 DocPreview（更深滑入）。
 *  - 文档 → DocBodyView，⋯ 菜单可"复制为 Markdown / 刷新文档"。
 *  - id 在缓存里找不到（极少：树还没加载 / 项已删）→ 占位 + 返回键。
 *
 * 平台无关：useNavigation 在 compact 下解析到 RootStack、iPad 下解析到 MainPane 嵌套栈，
 * 两栈都注册了 DocPreview，所以 push/goBack 自动落到正确的栈，整页右滑入。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  type StyleProp,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';
import PagerView from 'react-native-pager-view';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { type FlowDocTreeItem, getFlowDocItemName } from '../../api';
import { useSession } from '../../context/SessionContext';
import LinearGradient from 'react-native-linear-gradient';
import { BlurHeaderBackground } from '../../components/BlurHeaderBackground';
import { docsTreeStore } from './docsTreeStore';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { RootStackParamList } from '../../navigation/types';
import { HEADER_CIRCLE_BTN_SIZE } from '../../theme/layout';
import { shadowCircleButtonThemed, shadowMenu } from '../../theme/shadows';
import { TASK_FONT_SIZE_TITLE } from '../../theme/typography';
import { FolderView } from './FolderView';
import { DocBodyView, type DocBodyViewHandle } from './DocBodyView';
import { paperHasHtml, normalizeSubdocRefs, type ViewMode } from './PaperView';
import { HeaderCircleButton } from '../../components/HeaderCircleButton';
import { MenuView } from '@react-native-menu/menu';
import {
  IS_IOS_LIQUID_GLASS,
  type AnimatedCircleButtonMenuAction,
} from '../../components/AnimatedCircleButton';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const FOLDER_LIKE_TYPES = new Set(['folder', 'cooperateInbox']);

export type DocPreviewScreenProps = {
  /** 要预览的项 id（路由参数解析后传入；DocsScreen / 上一层 DocPreview push 时携带）。 */
  id: string;
  /** 左上角目录按钮回调。默认 navigation.popToTop()（iPad 整页路由用）；
   *  手机抽屉式预览传 goPeek（半开露目录而非弹掉整页）。 */
  onGoDirectory?: () => void;
  /** 文件夹内点子项回调。默认 navigation.replace（iPad）；
   *  手机抽屉式预览传「改本地 previewId」（原地替换、不叠层、不重新滑入）。 */
  onSelectChild?: (child: FlowDocTreeItem) => void;
  /** 左上角按钮外层的动画样式（手机抽屉式：随半开降低 opacity，跟白遮罩一起变淡 = 被遮罩盖住）。
   *  native 按钮浮在白遮罩之上挡不住，靠自身变淡露出底下白遮罩来等效。 */
  headerLeftStyle?: StyleProp<ViewStyle>;
};

/** hex(#rrggbb) → rgba（底部长缓渐变遮罩用）。 */
function hexToRgba(hex: string, a: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

export function DocPreviewScreen({
  id,
  onGoDirectory,
  onSelectChild,
  headerLeftStyle,
}: DocPreviewScreenProps) {
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  const navigation = useNavigation<Nav>();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const { session } = useSession();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const docBodyRef = useRef<DocBodyViewHandle | null>(null);
  /** 横滑分页器（走马灯切 tab）+ 当前页索引（与 header 切换器双向同步，ref 比对避免回环）。 */
  const pagerRef = useRef<PagerView | null>(null);
  const pagerPageRef = useRef(0);
  /** paper header tab：'pdf' / 'html' / 某个 subdoc id。切文档时重置为 pdf。 */
  const [activeTab, setActiveTab] = useState<string>('pdf');
  useEffect(() => {
    setActiveTab('pdf');
  }, [id]);
  /** subdoc id → 标题（异步拉，用作 tab 标签）。 */
  const [subdocNames, setSubdocNames] = useState<Record<string, string>>({});
  /** header（=文档区）实测宽度。iPad/宽屏有侧栏时只占右侧，不能用整窗宽算切换器/标题布局。 */
  const [headerWidth, setHeaderWidth] = useState(0);

  /** 从缓存解析项 + 直接子项；缓存内容稳定（DocsScreen 加载后写入），用 id 做 memo key。 */
  const item = useMemo(() => docsTreeStore.get(id), [id]);
  const children = useMemo(() => docsTreeStore.children(id), [id]);

  const isFolder = item ? FOLDER_LIKE_TYPES.has(item.type) : false;
  const headerTitle = item
    ? item.name?.trim() || (isFolder ? '未命名文件夹' : '未命名文档')
    : '文档';
  const isPaper = item?.type === 'paper';
  const paperHtml = isPaper && paperHasHtml(item?.meta);
  /** paper 锚点内嵌子文档（meta.subdocs）。 */
  const subdocRefs = useMemo(
    () => (isPaper ? normalizeSubdocRefs(item?.meta) : []),
    [isPaper, item?.meta],
  );
  /** paper 且有 HTML 或有 subdoc 时，header 居中显示可滚动 tab（PDF/HTML/各 subdoc）。 */
  const showPaperTabs = isPaper && (paperHtml || subdocRefs.length > 0);
  /** 全部 tab（PDF / HTML? / 各 subdoc），strip 与下拉共用。 */
  const paperTabs = useMemo(() => {
    if (!showPaperTabs) return [] as { key: string; label: string }[];
    const tabs: { key: string; label: string }[] = [{ key: 'pdf', label: 'PDF' }];
    if (paperHtml) tabs.push({ key: 'html', label: 'HTML' });
    for (const s of subdocRefs) tabs.push({ key: s.id, label: subdocNames[s.id] || '笔记' });
    return tabs;
  }, [showPaperTabs, paperHtml, subdocRefs, subdocNames]);

  /** 估算展开 strip 宽：PDF/HTML 固定 68，subdoc 按名字长度估（CJK 偏宽）。 */
  const paperStripW = useMemo(() => {
    let w = 6; // pill 内边距
    for (const t of paperTabs) {
      w +=
        t.key === 'pdf' || t.key === 'html'
          ? 68
          : Math.min(120, Math.max(60, 24 + t.label.length * 13));
    }
    return w;
  }, [paperTabs]);
  /** 布局基准宽 = 实测 header 宽（文档区），未测到先用整窗宽兜底。 */
  const layoutW = headerWidth > 0 ? headerWidth : winWidth;
  /** 标题+切换器可用宽（扣掉左右按钮区）；切换器预算 = 可用宽 - 标题保底 100；
   *  展开 strip 超预算就收成 ☰（标题始终至少留 100）。 */
  const headerInner = layoutW - (16 + HEADER_CIRCLE_BTN_SIZE + 8) - (8 + HEADER_CIRCLE_BTN_SIZE + 16);
  /** 标题保底宽：越大 → 切换器越早收成 ☰ 窄版（给左侧标题留更多空间）。 */
  const PAPER_TITLE_RESERVE = 160;
  const paperSelectorBudget = headerInner - PAPER_TITLE_RESERVE;
  /** 完整标签的 strip 放不下 → 未选中 tab 收成 ☰ 窄段（仍是正常 tab，只是不显字）。 */
  const paperTabsCollapsed = showPaperTabs && paperStripW > paperSelectorBudget;
  /** header 切换器点选 → 翻页器跳到对应页；横滑反向经 onPageSelected 回写 activeTab（ref 比对避免回环）。 */
  const activeTabIndex = paperTabs.findIndex((t) => t.key === activeTab);
  useEffect(() => {
    if (!showPaperTabs || activeTabIndex < 0) return;
    if (activeTabIndex !== pagerPageRef.current) {
      pagerPageRef.current = activeTabIndex;
      pagerRef.current?.setPage(activeTabIndex);
    }
  }, [activeTabIndex, showPaperTabs]);
  /** 当前切换器实际宽（收起态=选中段+其余 ☰32；展开态=完整 strip），用于：标题让位到居中切换器左缘前。 */
  const paperActiveLabel = paperTabs.find((t) => t.key === activeTab)?.label ?? 'PDF';
  const paperActiveSegW =
    activeTab === 'pdf' || activeTab === 'html'
      ? 68
      : Math.min(120, Math.max(60, 24 + paperActiveLabel.length * 13));
  const paperPillW = paperTabsCollapsed
    ? 6 + paperActiveSegW + 32 * Math.max(0, paperTabs.length - 1)
    : paperStripW;
  const paperTitleAvailW = Math.floor(
    layoutW / 2 - paperPillW / 2 - (16 + HEADER_CIRCLE_BTN_SIZE + 8) - 8,
  );
  /** 标题可用宽低于此阈值（更窄）→ 干脆不显示标题，只留居中切换器。 */
  const PAPER_TITLE_MIN_W = 56;
  const showPaperTitle = !showPaperTabs || paperTitleAvailW >= PAPER_TITLE_MIN_W;
  const paperTitleMaxW = Math.max(40, paperTitleAvailW);

  /** 拉 subdoc 标题（subdoc 引用只有 {id,type}，名字另取；不在树缓存里）。 */
  useEffect(() => {
    if (!session || subdocRefs.length === 0) return;
    let cancelled = false;
    subdocRefs.forEach((s) => {
      if (subdocNames[s.id] !== undefined) return;
      getFlowDocItemName(session, s.id)
        .then((name) => {
          if (!cancelled && name) {
            setSubdocNames((prev) => (prev[s.id] === name ? prev : { ...prev, [s.id]: name }));
          }
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [session, subdocRefs, subdocNames]);

  /** 当前 tab 指向的 subdoc（'pdf'/'html' 时为 undefined = 看 paper 本体）。 */
  const activeSubdoc = subdocRefs.find((s) => s.id === activeTab);
  const bodyDocId = activeSubdoc ? activeSubdoc.id : item?.id ?? '';
  const bodyDocType = activeSubdoc ? activeSubdoc.type : item?.type ?? '';
  const bodyMeta = activeSubdoc ? undefined : item?.meta;
  const bodyPaperMode: ViewMode = activeTab === 'html' ? 'html' : 'pdf';
  const bodyTitle = activeSubdoc
    ? subdocNames[activeSubdoc.id] || '笔记'
    : headerTitle;

  /** 顶栏渐变基色：默认与其它页一致(chatScreenBackground)；flowbase 的表格是纯白背景，
   *  这里精确改用 background(纯白)，避免渐变与表格产生色差。 */
  const headerGradientBase =
    bodyDocType === 'flowbase' ? colors.background : colors.chatScreenBackground;

  /** 回到文档树（目录）。prop 优先(手机抽屉式 = 半开露目录)；否则整页路由 popToTop 回到树。 */
  const onGoTree = useCallback(() => {
    setOptionsOpen(false);
    if (onGoDirectory) {
      onGoDirectory();
      return;
    }
    navigation.popToTop();
  }, [navigation, onGoDirectory]);

  /** 文件夹里点子项 → prop 优先(手机抽屉式 = 改本地 previewId 原地替换)；
   *  否则整页路由 replace 切到该项预览（不叠新一层页面，栈深度不变；返回始终回树）。 */
  const onChildSelect = useCallback(
    (child: FlowDocTreeItem) => {
      if (onSelectChild) {
        onSelectChild(child);
        return;
      }
      navigation.replace('DocPreview' as never, { id: child.id } as never);
    },
    [navigation, onSelectChild]
  );

  const onCopyMarkdown = useCallback(() => {
    setOptionsOpen(false);
    docBodyRef.current?.copyMarkdown();
  }, []);

  const onReload = useCallback(() => {
    setOptionsOpen(false);
    /* 文档 → 重载正文；文件夹 → 重载文档树（让缓存/视觉刷新）。 */
    docBodyRef.current?.reload();
  }, []);

  const onOptionsPress = useCallback(() => {
    setOptionsOpen((v) => !v);
  }, []);

  /** flowbase 刷新：docBodyRef.reload 只作用于 flowdoc 正文，对 flowbase 无效 → 用 nonce 改 key
   *  让 FlowBaseScreen 整块重挂、重新拉数据。 */
  const [flowbaseNonce, setFlowbaseNonce] = useState(0);
  const onFlowbaseRefresh = useCallback(() => setFlowbaseNonce((n) => n + 1), []);

  /** ⋯ 菜单项按当前文档类型决定；三种渲染路径（iOS26 glass / iOS15-25 MenuView / Android popover）
   *  与 Android 弹层都从这一份数据生成。sf=SF Symbol（iOS 原生菜单图标），ion=Ionicons（Android 弹层）。 */
  type DocMenuItem = { id: string; title: string; sf: string; ion: string; run: () => void };
  const menuItems = useMemo<DocMenuItem[]>(() => {
    if (bodyDocType === 'flowbase') {
      return [{ id: 'refresh', title: '刷新', sf: 'arrow.clockwise', ion: 'refresh', run: onFlowbaseRefresh }];
    }
    if (isFolder) {
      return [{ id: 'reloadTree', title: '刷新文档树', sf: 'arrow.clockwise', ion: 'refresh', run: () => {} }];
    }
    if (item) {
      return [
        { id: 'copyMd', title: '复制为 Markdown', sf: 'doc.on.clipboard', ion: 'copy-outline', run: onCopyMarkdown },
        { id: 'reload', title: '刷新文档', sf: 'arrow.clockwise', ion: 'refresh', run: onReload },
      ];
    }
    return [];
  }, [bodyDocType, isFolder, item, onFlowbaseRefresh, onCopyMarkdown, onReload]);

  const nativeMenuActions = useMemo<AnimatedCircleButtonMenuAction[]>(
    () => menuItems.map((m) => ({ id: m.id, title: m.title, image: m.sf })),
    [menuItems],
  );
  const onMenuSelect = useCallback(
    (id: string) => menuItems.find((m) => m.id === id)?.run(),
    [menuItems],
  );
  const onMenuViewPress = useCallback(
    (e: { nativeEvent: { event: string } }) => onMenuSelect(e.nativeEvent.event),
    [onMenuSelect],
  );

  const headerHeight = insets.top + 8 + 12 + HEADER_CIRCLE_BTN_SIZE;
  /** 底部渐变遮罩带高度（长缓渐变，从顶端就掉透明度、无纯色平台）。 */
  const footerHeight = insets.bottom + 72;

  /** paper 切换器胶囊（展开内联靠右 / 收起绝对居中两处共用同一节点）。 */
  const paperPillNode = showPaperTabs ? (
    <View style={styles.paperPill}>
      {paperTabs.map((t) => {
        const active = activeTab === t.key;
        const asIcon = paperTabsCollapsed && !active; // 空间不足时，未选中 tab 显示 ☰
        return (
          <TouchableOpacity
            key={t.key}
            style={[
              styles.paperSeg,
              asIcon
                ? styles.paperSegIcon
                : t.key !== 'pdf' && t.key !== 'html' && styles.paperSegSubdoc,
              active && styles.paperSegActive,
            ]}
            onPress={() => setActiveTab(t.key)}
            activeOpacity={0.8}
            accessibilityLabel={asIcon ? t.label : undefined}
          >
            {asIcon ? (
              <Ionicons name="menu" size={16} color={colors.textMuted} />
            ) : (
              <Text
                style={[styles.paperSegText, active && styles.paperSegTextActive]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {t.label}
              </Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  ) : null;

  return (
    <View style={styles.container}>
      {/* 主区：内容铺满整页，上下留出遮罩带高度 → 滚动贯穿顶/底渐变遮罩下。 */}
      <View style={styles.mainArea}>
        {item == null ? (
          <View style={[styles.centered, { paddingTop: headerHeight }]}>
            <Text style={styles.placeholderText}>文档不存在，请返回</Text>
          </View>
        ) : isFolder ? (
          <FolderView
            folder={item}
            items={children}
            onSelect={onChildSelect}
            contentTopInset={headerHeight}
            contentBottomInset={footerHeight}
          />
        ) : showPaperTabs ? (
          /* paper 多 tab：横滑分页器（走马灯切 tab），与 header 切换器双向同步。
             每页一个 DocBodyView：pdf/html = 同一 paper 不同 viewMode；subdoc = 各自文档。
             ref 只挂当前页（⋯ 的复制/刷新作用于当前页）。 */
          <PagerView
            key={id}
            ref={pagerRef}
            style={styles.pager}
            initialPage={Math.max(0, activeTabIndex)}
            offscreenPageLimit={1}
            onPageSelected={(e) => {
              const i = e.nativeEvent.position;
              pagerPageRef.current = i;
              const k = paperTabs[i]?.key;
              if (k) setActiveTab(k);
            }}
          >
            {paperTabs.map((t) => {
              const isPdfHtml = t.key === 'pdf' || t.key === 'html';
              return (
                <View key={t.key} style={styles.pagerPage} collapsable={false}>
                  <DocBodyView
                    ref={activeTab === t.key ? docBodyRef : undefined}
                    docId={isPdfHtml ? item.id : t.key}
                    docType={isPdfHtml ? 'paper' : subdocRefs.find((s) => s.id === t.key)?.type ?? 'document'}
                    title={isPdfHtml ? headerTitle : subdocNames[t.key] || '笔记'}
                    meta={isPdfHtml ? item.meta : undefined}
                    paperViewMode={t.key === 'html' ? 'html' : 'pdf'}
                    contentTopInset={headerHeight}
                    contentBottomInset={footerHeight}
                  />
                </View>
              );
            })}
          </PagerView>
        ) : (
          <DocBodyView
            key={bodyDocType === 'flowbase' ? `${bodyDocId}:${flowbaseNonce}` : bodyDocId}
            ref={docBodyRef}
            docId={bodyDocId}
            docType={bodyDocType}
            title={bodyTitle}
            meta={bodyMeta}
            paperViewMode={bodyPaperMode}
            contentTopInset={headerHeight}
            contentBottomInset={footerHeight}
          />
        )}
      </View>

      {/* 底部渐变遮罩带：长缓渐变，从顶端就掉透明度、无纯色平台（内容滚到下面被柔化遮挡）。 */}
      <View style={[styles.bottomFade, { height: footerHeight }]} pointerEvents="none">
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[
            hexToRgba(colors.chatScreenBackground, 0),
            hexToRgba(colors.chatScreenBackground, 0.08),
            hexToRgba(colors.chatScreenBackground, 0.22),
            hexToRgba(colors.chatScreenBackground, 0.45),
            hexToRgba(colors.chatScreenBackground, 0.98),
          ]}
          locations={[0, 0.25, 0.5, 0.75, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
        />
      </View>

      {/* 顶部 header：目录按钮 + 标题 + ⋯ */}
      <View
        style={[styles.topBar, { paddingTop: insets.top + 8 }]}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w > 0) setHeaderWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
        }}
      >
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={insets.top + 8}
          gradientBaseHex={headerGradientBase}
        />
        {/* 左上角=目录按钮：回到文档树（预览不叠层，等价于"返回到目录"）。
         *  外层 Animated.View 随半开降低 opacity，跟白遮罩一起变淡（native 按钮挡不住，靠变淡等效被盖）。 */}
        <Animated.View style={[styles.headerLeft, headerLeftStyle]}>
          <HeaderCircleButton
            ionicon="list-outline"
            sfSymbol="list.bullet"
            iconSize={24}
            onPress={onGoTree}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          />
        </Animated.View>
        {/* 标题靠左占弹性区。paper 切换器始终绝对居中 → 标题限宽不顶到切换器；更窄时干脆不显示。 */}
        <View style={styles.headerTitleWrap}>
          {showPaperTitle ? (
            <Text
              style={[
                styles.headerTitle,
                showPaperTabs ? { maxWidth: paperTitleMaxW } : null,
              ]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {headerTitle}
            </Text>
          ) : null}
        </View>
        {/* ⋯ 菜单三条路（对齐 ChatScreen）：iOS26 glass 原生 UIMenu / iOS15-25 MenuView 原生 UIMenu /
            Android 走下方 JS 弹层。无菜单项（如空文档）则不显示按钮。 */}
        {menuItems.length === 0 ? null : IS_IOS_LIQUID_GLASS ? (
          <HeaderCircleButton
            ionicon="ellipsis-horizontal"
            sfSymbol="ellipsis"
            menuActions={nativeMenuActions}
            onMenuAction={onMenuSelect}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          />
        ) : Platform.OS === 'ios' ? (
          <MenuView
            title=""
            actions={nativeMenuActions}
            onPressAction={onMenuViewPress}
            shouldOpenOnLongPress={false}
          >
            <View style={styles.circleBtn}>
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
            </View>
          </MenuView>
        ) : (
          <HeaderCircleButton
            ionicon="ellipsis-horizontal"
            sfSymbol="ellipsis"
            onPress={onOptionsPress}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          />
        )}

        {/* 切换器始终绝对居中（左右对称留出按钮区，与左侧标题无关）。box-none 让两侧穿透到按钮。 */}
        {showPaperTabs ? (
          <View style={[styles.paperTabsCenter, { top: insets.top + 8 }]} pointerEvents="box-none">
            {paperPillNode}
          </View>
        ) : null}
      </View>

      {/* 更多菜单（Android 弹层；iOS 走原生 UIMenu 不进这里）。菜单项与原生一致，来自同一份 menuItems。 */}
      {optionsOpen && menuItems.length > 0 ? (
        <>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOptionsOpen(false)}
          />
          <View
            style={[
              styles.optionsMenu,
              { top: insets.top + 8 + HEADER_CIRCLE_BTN_SIZE + 4, right: 16 },
            ]}
          >
            {menuItems.map((m) => (
              <TouchableOpacity
                key={m.id}
                style={styles.optionsItem}
                onPress={() => {
                  setOptionsOpen(false);
                  m.run();
                }}
              >
                <Ionicons name={m.ion} size={16} color={colors.textPrimary} style={styles.optionsIcon} />
                <Text style={styles.optionsItemText}>{m.title}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    /* 背景透明：由下层供色。整页路由(iPad)下层是 stack card(chatScreenBackground)；
     *  手机抽屉式下层是 overlay inner（背景随开抽屉进度渐变到纯白，文字在上层始终可见）。 */
    container: { flex: 1, backgroundColor: 'transparent' },
    mainArea: { flex: 1 },
    pager: { flex: 1 },
    pagerPage: { flex: 1 },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    placeholderText: { color: c.placeholder, fontSize: 14 },
    topBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    circleBtn: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.surface,
      ...shadowCircleButtonThemed(c),
    },
    headerTitleWrap: { flex: 1, alignItems: 'flex-start', paddingHorizontal: 8 },
    /** 切换器绝对居中层（左右对称留出按钮区 → 居中） */
    paperTabsCenter: {
      position: 'absolute',
      left: 16 + HEADER_CIRCLE_BTN_SIZE + 8,
      right: 16 + HEADER_CIRCLE_BTN_SIZE + 8,
      height: HEADER_CIRCLE_BTN_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    paperPill: {
      flexDirection: 'row',
      alignItems: 'stretch',
      height: HEADER_CIRCLE_BTN_SIZE, // 与左右圆按钮等高
      backgroundColor: c.surface, // 白底，跟左右圆按钮一致
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      padding: 3,
      ...shadowCircleButtonThemed(c),
    },
    paperSeg: {
      width: 68, // PDF/HTML 固定等宽，与内容无关（对齐 web）
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    },
    /** subdoc tab：名字长度不定，给上下限 + 省略号（不再固定 68） */
    paperSegSubdoc: { width: undefined, minWidth: 60, maxWidth: 120, paddingHorizontal: 14 },
    /** ☰ 段（未选中且空间不足）：更窄 */
    paperSegIcon: { width: 32 },
    paperSegActive: { backgroundColor: c.surfaceMuted }, // 白底胶囊上，选中段用 muted 反白对比
    paperSegText: { fontSize: 13, color: c.textMuted, fontWeight: '500' },
    paperSegTextActive: { color: c.textPrimary },
    headerTitle: {
      fontSize: TASK_FONT_SIZE_TITLE,
      fontWeight: '400',
      color: c.textPrimary,
    },
    bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    optionsMenu: {
      position: 'absolute',
      zIndex: 50,
      backgroundColor: c.surface,
      borderRadius: 12,
      paddingVertical: 6,
      minWidth: 180,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
      ...shadowMenu,
    },
    optionsItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    optionsIcon: { marginRight: 10 },
    optionsItemText: { fontSize: 14, color: c.textPrimary },
  });
}
