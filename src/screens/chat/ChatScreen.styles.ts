import { Platform, StyleSheet } from 'react-native';
import { shadowCircleButtonThemed, shadowMenu, shadowSheet } from '../../theme/shadows';
import {
  HEADER_CIRCLE_BTN_SIZE,
  CHAT_COMPOSER_SEND_BTN_SIZE,
  COMPOSER_PILL_SIZE,
  COMPOSER_CARD_RADIUS,
} from '../../theme/layout';
import { TASK_FONT_SIZE_TITLE } from '../../theme/typography';
import type { AppColors } from '../../theme/appColors';

/** 历史消息区水平内边距（略收窄左右留白） */
const CHAT_SCROLL_PADDING_H = 5;
/** 空对话欢迎语在 scroll 水平留白基础上再增加的左右内边距 */
const EMPTY_WELCOME_PADDING_EXTRA_H = 20;
/** 底栏输入框 + 发送键所在行的水平内边距 */
const COMPOSER_ROW_PADDING_H = 16;
/**
 * 底部模型/助手/用量选择条的水平内边距（与输入行独立，可单独调）
 */
const COMPOSER_META_ROW_PADDING_LEFT = 32;
const COMPOSER_META_ROW_PADDING_RIGHT = 32;

/* ============================================================
 * Composer 设计语言：所有跟单行胶囊高度（COMPOSER_PILL_SIZE）相关的
 * padding / inset 都从这里派生，改了主值其它自动跟。
 * ============================================================ */
/** Card 圆角（= COMPOSER_PILL_SIZE/2）。从 layout 统一常量 re-export，跟今日页搜索框 / FAB 同一套。 */
export { COMPOSER_CARD_RADIUS };
/** 内嵌 + / ⏹ 圆钮尺寸 */
const COMPOSER_PLUS_BTN_SIZE = 32;
/** + center 到 card 上 / 下 / 左 三边的距离 = COMPOSER_PILL_SIZE / 2；
 *  对应 + 边沿到 card 边沿的 inset。绝对定位的 `bottom` / `left` 都用这个。 */
const COMPOSER_PLUS_BTN_INSET =
  (COMPOSER_PILL_SIZE - COMPOSER_PLUS_BTN_SIZE) / 2;
/** + 的真实可点区（native view bounds）：把原来 hitSlop 6 的范围做进 view 尺寸里。
 *  Android 上 hitSlop 只在 JS 命中层（TouchTargetHelper）生效，native touch 分发按真实
 *  view bounds 走——落在 hitSlop 环带的 touch 会穿给底下撑满整卡的 EditText，native
 *  focus + 弹键盘（JS 侧却按 + 命中、菜单照开）。touch target 做成真实尺寸后 native / JS
 *  命中一致；按钮无背景，视觉仍是居中 32 位的图标，+ 圆心不动（同心放大）。 */
const COMPOSER_PLUS_BTN_TOUCH_SIZE = COMPOSER_PLUS_BTN_SIZE + 12;
const COMPOSER_PLUS_BTN_TOUCH_INSET =
  (COMPOSER_PILL_SIZE - COMPOSER_PLUS_BTN_TOUCH_SIZE) / 2;
/** 发送/停止键比 + 略大（实色圆钮视觉更重）；icon 不跟着变大。跟右半圆同心 → inset 按自身尺寸算。 */
const COMPOSER_SEND_BTN_SIZE = 38;
const COMPOSER_SEND_BTN_INSET =
  (COMPOSER_PILL_SIZE - COMPOSER_SEND_BTN_SIZE) / 2;
/** + 右沿到输入区 cursor 左边缘的视觉间距 */
const COMPOSER_PLUS_TO_INPUT_GAP = 6;
/** 麦克风键：与发送键同尺寸（背景圆 / 涟漪跟发送圆钮一样大，视觉成比例），跟 +/发送键同心一排。 */
const COMPOSER_MIC_BTN_SIZE = COMPOSER_SEND_BTN_SIZE;
/** mic 与发送键之间的间隙：两者都有 38px touch target 但 icon 只有 20px，用小间隙让视觉更紧凑。 */
const COMPOSER_MIC_TO_SEND_GAP = 2;
/** mic 右沿 inset：iOS / Android 都有发送键 → mic 一律落在发送键左边（贴近，只留 MIC_TO_SEND_GAP）。 */
const COMPOSER_MIC_BTN_RIGHT =
  COMPOSER_SEND_BTN_INSET + COMPOSER_SEND_BTN_SIZE + COMPOSER_MIC_TO_SEND_GAP;
/** Card 整体水平 padding（short / tall 同值）；inputShort 内部还有自己的 paddingH = 同值 */
const COMPOSER_CARD_PADDING_H = 8;
/** Tall 模式 card 顶部空白（让输入区跟胶囊顶有呼吸） */
const COMPOSER_TALL_PAD_TOP = 18;
/** Tall 模式 card 底部 padding（独立于 + 的 inset） */
const COMPOSER_TALL_PAD_BOTTOM = 4;
/** Short 模式 inputArea 左 padding：让 cursor 落在 + 右沿 + GAP。
 *  card paddingLeft + inputArea paddingLeft + inputShort paddingHorizontal = + 右沿 + GAP
 *  → inputArea paddingLeft = inset + plusSize + gap - 2 × cardPadH = 10+32+6-16 = 32 */
const COMPOSER_INPUT_PAD_LEFT_SHORT =
  COMPOSER_PLUS_BTN_INSET +
  COMPOSER_PLUS_BTN_SIZE +
  COMPOSER_PLUS_TO_INPUT_GAP -
  COMPOSER_CARD_PADDING_H * 2;
/** Tall 模式 inputArea 底 padding：让 input 内容底跟 + 顶留 GAP。
 *  + 顶到 card 底 = inset + plusSize；inputArea 底到 card 底 = card.paddingBottom + paddingBottom
 *  → paddingBottom = inset + plusSize + gap - card.paddingBottom = 10+32+6-4 = 44 */
const COMPOSER_INPUT_PAD_BOTTOM_TALL =
  COMPOSER_PLUS_BTN_INSET +
  COMPOSER_PLUS_BTN_SIZE +
  COMPOSER_PLUS_TO_INPUT_GAP -
  COMPOSER_TALL_PAD_BOTTOM;

/* ============================================================
 * UITextView.textContainerInset / Android EditText.padding 四边（让 input 撑满整张 card,
 * 文本视觉留白由 native 内 inset 给）。新写法的 callsite 不再用 wrapper View 叠 padding,
 * 直接把这些值传给 FlowDocSlateAdapter.textContainerInset。
 * ============================================================ */
/** Short 模式（单行胶囊）四边 inset：
 *  - left: 原 card.paddingH + composerInputArea.paddingLeft + composerInputShort.paddingH
 *  - right: 原 card.paddingH + composerInputShort.paddingH
 *  - top/bottom: 看着像在 40pt 胶囊里居中。
 *    iOS: top 实测 16（lineHeight 在 UITextView 上行为 + 字形光学重心偏上需要更多 top）
 *    Android: top 实测 8（EditText 的 gravity:CENTER_VERTICAL 已经帮忙做了一半几何居中,
 *      只需要少量 top 补字形光学偏上） */
export const COMPOSER_TEXT_INSET_SHORT = {
  top: Platform.OS === 'ios' ? 16 : 8,
  left:
    COMPOSER_CARD_PADDING_H +
    COMPOSER_INPUT_PAD_LEFT_SHORT +
    COMPOSER_CARD_PADDING_H,
  bottom: 9,
  /* 右侧最靠里的键是麦克风（iOS 上它又在发送键左边）→ 右 inset 一律按 mic 左沿让位（mic 左沿 + GAP），
     文字不被 mic / 发送键压住。 */
  right: COMPOSER_MIC_BTN_RIGHT + COMPOSER_MIC_BTN_SIZE + COMPOSER_PLUS_TO_INPUT_GAP,
};
/** Tall 模式（多行卡片）四边 inset：
 *  - left/right: 原 card.paddingH + composerInputTall.paddingH (= 8 + 12 = 20)
 *  - top: 原 card.paddingTop = 18
 *  - bottom: 原 card.paddingBottom + composerInputAreaTall.paddingBottom = 4 + 44 = 48 */
export const COMPOSER_TEXT_INSET_TALL = {
  top: COMPOSER_TALL_PAD_TOP,
  left: COMPOSER_CARD_PADDING_H + 12,
  bottom: COMPOSER_TALL_PAD_BOTTOM + COMPOSER_INPUT_PAD_BOTTOM_TALL,
  right: COMPOSER_CARD_PADDING_H + 12,
};

export function createChatStyles(c: AppColors) {
  return StyleSheet.create({

  container: { flex: 1, backgroundColor: c.chatScreenBackground },
  containerInner: { flex: 1 },
  keyboardView: { flex: 1 },
  scrollAndGradientWrap: { flex: 1, position: 'relative' },
  /* ── 协同工作模式（见 ChatScreen 的 collabActive 分叉）──
   * 层序（containerInner 内的兄弟顺序即 z 序，topBar 靠 zIndex:30 恒在最上）：
   *   工作区层 → sheet（聊天消息区）→ KeyboardAvoidingView（composer）。
   * 于是 composer 永远浮在 sheet 之上、折叠 sheet 也能边看文档边输入。 */
  /** 工作区层：铺满整页垫在最底下。header / composer 都是绝对浮层，正文靠 inset 自己让位。
   *  底色刻意比 sheet 暗一档（drawerBackground，跟抽屉外壳同一套「底层压暗 → 上层浮起来」的做法）：
   *  这块 sheet 是常驻的、**没有 backdrop dim**，两块画布同色时圆角和阴影都无从显形 ——
   *  暗色下尤其明显，SHADOW_COLOR 是半透明黑，落在 #101010 上等于没画。 */
  collabWorkspaceLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.drawerBackground,
    /**
     * **显式压到最底**，不吃「兄弟顺序即 z 序」那套隐式约定。
     *
     * 实测教训：这层里的底部渐变遮罩（不透明）本该被 sheet 盖住，实际却画在了 sheet 之上 ——
     * 早先它多铺 8pt 时，把 sheet 顶上 8pt 的面、圆角弧和投影一起抹掉了（截图逐像素量到
     * 正好 8.0pt，且那一条连 sheet 投影都没有）。收回那 8pt 只治了标，sheet 向上的投影仍被
     * 这条贴着顶沿的近实色带子吃掉。containerInner 里另外三个兄弟：leftEdgeGesture / topBar
     * 都已显式 zIndex 30，sheet 与 KAV(composer) 无 zIndex（靠兄弟顺序保持 composer 在
     * sheet 之上）—— 这里给 -1 只把本层压到最底，不动那两者的相对次序。
     */
    zIndex: -1,
  },
  /** 工作区层里再套一层：溶解过渡拿它做淡出 + 微缩，底色留在外层（外层要插值成聊天页画布色）。 */
  collabWorkspaceInner: { flex: 1 },
  /** sheet 面：保持聊天页主画布色（消息气泡/工具卡都是照这个底调的，不能动），
   *  层次交给「底层更暗 + 上缘 hairline + 向上投影」三件套。 */
  collabSheetBackground: {
    backgroundColor: c.chatScreenBackground,
    /** 32 = 项目里所有 sheet 的统一圆角（ProfileSheet / ModelSelectSheet / DocsTreeSheet…）。 */
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    /**
     * 收边 hairline：阴影在暗色下几乎不可见（sheet 面 #101010 与工作区 #070708 只差一档），
     * 靠这条边把 sheet 顶沿连同圆角一起钉出来；亮色下它很淡，只作收边。
     *
     * **四边都给**，不能只写 borderTopWidth：单边 border + 圆角会让两端走各自的渲染路径，
     * 圆角处那段弧描不出来 —— 表现就是「顶边是直的、左右上角看着是直角」。左右两条落在
     * 屏幕最外侧那列像素上、下边在屏幕外，实际只看得见顶上这一条。
     */
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    /** 项目通用 sheet 投影（向上，height:-4）—— 与 ProfileSheet / ModelSelectSheet 同一预设。 */
    ...shadowSheet,
  },
  /** 握把本体。尺寸要写全 —— 把手改成自渲染（溶解时要淡出）后，gorhom 默认 indicator
   *  那份样式（4 高 / 圆角 / 居中）不再叠上来。 */
  collabSheetHandle: {
    backgroundColor: c.borderD4,
    width: 36,
    height: 4,
    borderRadius: 4,
    alignSelf: 'center',
  },
  /** 把手条本体：高度钉死成 COLLAB_SHEET_HANDLE_H（= gorhom 默认的 10+4+10），
   *  聊天区高度按「当前档高 - 这个数」算，浮动一下就会差一截。 */
  collabSheetHandleBar: { height: 24, paddingVertical: 10, justifyContent: 'center' },
  /** sheet 里聊天区的容器。**刻意不用 flex:1** —— 高度由 ChatScreen 按当前档位算好后
   *  显式下发（见 collabSheetChatHeight）。flex 会让它去跟父级的高度传递链纠缠，而那条链
   *  正是「视口比 sheet 高、滚不到底」的根子。 */
  collabSheetContent: { width: '100%' },
  /** 把手下沿那一条淡出：消息区滚上来的内容在这儿化开，而不是被 overflow 齐刷刷切一刀。
   *  12pt —— 起初给了 24（与把手条等高），实测过渡带拖得太长；这个量够化开又不拖泥带水。 */
  collabSheetTopFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 12,
  },
  /** 容器高度还没量出来那一帧的兜底：先撑满，别塌成 0 高。 */
  collabSheetContentFill: { flex: 1 },
  /** 与主画布同色：避免暗色下 overlayScrim（近黑半透明）比 #101010 更暗一块 */
  historyLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.chatScreenBackground,
    zIndex: 20,
  },
  /** server SIGTERM 期间的临时 banner：贴在消息流末尾（与 FlopsWeb 的 chat-reload-pending-banner 对齐） */
  reloadPendingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    gap: 8,
    marginTop: 12,
    marginBottom: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: c.toolCardBg,
  },
  reloadPendingText: {
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  bottomOverlayInner: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'column',
    justifyContent: 'flex-end',
  },
  /** 底部留白留给绝对定位的模型/助手/用量条（与改前「模型贴在输入区底」同一思路，不把整块顶高） */
  inputRowInOverlay: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: COMPOSER_ROW_PADDING_H,
    paddingRight: COMPOSER_ROW_PADDING_H,
    paddingTop: 12,
    paddingBottom: 26,
    gap: 12,
    overflow: 'visible',
  },
  /** 叠在输入行底部留白内；左右 padding 见 COMPOSER_META_ROW_*，与输入行解耦 */
  composerMetaRowAbsolute: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -5,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: COMPOSER_META_ROW_PADDING_LEFT,
    paddingRight: COMPOSER_META_ROW_PADDING_RIGHT,
    gap: 8,
  },
  composerMetaPills: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    gap: 10,
  },
  composerMetaChip: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  composerMetaChipReadonly: {
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'flex-start',
  },
  composerAgentReadonlyText: {
    fontSize: 11,
    color: c.placeholder,
  },
  /** 右下角：环形上下文进度 + 统计图 icon 两个小元素并排 */
  composerUsageInMetaRow: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  composerUsageIconBtn: {
    paddingVertical: 1,
    paddingHorizontal: 1,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    /** 须高于 historyLoadingOverlay(20)，拉历史时仍可点返回 / 标题区 / 加号 */
    zIndex: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  circleBtn: {
    width: HEADER_CIRCLE_BTN_SIZE,
    height: HEADER_CIRCLE_BTN_SIZE,
    borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.surface,
    ...shadowCircleButtonThemed(c),
  },
  /** ⋯ 圆按钮在没 conversationId 时灰化（MenuView 不能直接 disable，靠样式 + pointerEvents） */
  circleBtnDisabled: { opacity: 0.4 },
  /** 左上角按钮槽：相对定位容器，让未读 badge 绝对锚在按钮右上角。宽高交给内部按钮撑。 */
  headerLeftSlot: { position: 'relative' },
  /** 协同入口按钮槽：相对定位容器，好让角标锚到右上角。 */
  headerCollabSlot: { position: 'relative' },
  /**
   * 右上角双选项胶囊：协同入口 + ⋯ 并排成一颗。外形跟 header 圆钮同一套（同底色、
   * 同阴影），圆角取高度一半，宽度由两格自适应撑开。
   */
  headerCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: HEADER_CIRCLE_BTN_SIZE,
    borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    backgroundColor: c.surface,
    /** 收一条 hairline：胶囊底色(#ffffff) 跟顶栏画布(#f9fafb) 只差一档，浅色下光靠投影
     *  轮廓很弱 —— 用户实测反馈就是「看不出胶囊、像两个图标浮在页面上」。圆钮不需要是
     *  因为它更小、投影更聚拢；这颗横着摊开，边缘得钉一下。 */
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    ...shadowCircleButtonThemed(c),
  },
  /** iOS 26 胶囊：本体是 BouncyGlassCard（系统玻璃），这里只排版 —— 底色/圆角都归它，
   *  圆角走 cornerRadius prop（进玻璃本体的 cornerConfiguration），不在样式里给。 */
  headerGlassCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: HEADER_CIRCLE_BTN_SIZE,
  },
  /** 胶囊里的一格：比圆钮窄，两格并排才不至于太胖；不带底色，底色归胶囊。 */
  headerCapsuleSegment: {
    width: 40,
    height: HEADER_CIRCLE_BTN_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 两格之间的分隔：只占中段高度，不顶到胶囊上下边。 */
  headerCapsuleDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: c.border,
  },
  /** 胶囊里的角标：收在这一格右上角**内侧**（挂到胶囊外会像浮在按钮外的孤点），
   *  比独立圆钮那颗小一号，免得压到分隔线。 */
  headerCapsuleBadge: {
    position: 'absolute',
    top: 5,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: c.textSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  /** 未读对话数 badge：锚在返回/汉堡按钮右上角。灰底白字，无描边。 */
  headerUnreadBadge: {
    position: 'absolute',
    top: -5,
    right: -6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: c.textSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerUnreadBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  /** Android ⋯ 菜单 popover：iOS 走 MenuView native，本组只给 Android 用。
   *  backdrop = 整屏透明遮罩（点空白关）；卡片 absolute 锚定在右上角圆按钮下方。
   *  设计跟 TodayScreen FAB 菜单同款：常驻 mount + SharedValue 驱动可见性,
   *  圆角跟 ⋯ 圆按钮一致 (HEADER_CIRCLE_BTN_SIZE/2 = 26)，无 border，靠 shadowMenu
   *  区分背景。 */
  convMenuBackdrop: {
    backgroundColor: 'transparent',
    zIndex: 9000,
    elevation: 9000,
  },
  convMenuCard: {
    position: 'absolute',
    minWidth: 240,
    backgroundColor: c.surface,
    borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    overflow: 'hidden',
    paddingVertical: 6,
    paddingHorizontal: 18,
    zIndex: 9999,
    elevation: 9999,
    ...shadowMenu,
  },
  convMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  convMenuItemText: { fontSize: 15, color: c.textPrimary, fontWeight: '500' },
  /** Switch 行里让文字占满、把 Switch 推到右缘 */
  convMenuItemTextGrow: { flex: 1 },
  convMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.borderMuted,
    marginHorizontal: 8,
  },
  convMenuSectionDivider: {
    height: 4,
    backgroundColor: c.borderMuted,
    marginVertical: 4,
    marginHorizontal: -8,
  },
  leftEdgeGesture: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 24,
    /** 须高于 historyLoadingOverlay(20)，否则拉历史时全屏遮罩会挡住侧滑返回 */
    zIndex: 30,
  },
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    alignItems: 'flex-start',
    /** 跟左侧返回圆钮拉开距离：左 14、右 8 不对称，给标题更多呼吸 */
    paddingLeft: 14,
    paddingRight: 8,
  },
  headerTitle: { fontSize: TASK_FONT_SIZE_TITLE, fontWeight: '700', color: c.textHeader },
  /** 与 composerUsageText 同档：小号、placeholder 同色（跟输入框 placeholder 一致弱化），常规字重 */
  composerModelTriggerText: {
    flexShrink: 1,
    fontSize: 11,
    color: c.placeholder,
  },
  composerUsageText: {
    fontSize: 11,
    color: c.placeholder,
    textAlign: 'right',
    maxWidth: '100%',
  },
  globalError: { color: c.danger, fontSize: 13, paddingHorizontal: CHAT_SCROLL_PADDING_H, paddingVertical: 8 },
  /* S9 加密子对话解不开（父对话已删/不在本账号）时的说明条。不是错误，是状态，所以用弱化色。 */
  convLockedNotice: { color: c.textMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: CHAT_SCROLL_PADDING_H, paddingVertical: 8 },
  scroll: { flex: 1 },
  /** 重挂后还没被钉到底的那一两帧：只藏画面、不动布局（见 ChatMessageArea 的 pinSettling）。 */
  scrollSettling: { opacity: 0 },
  scrollContent: {
    paddingHorizontal: CHAT_SCROLL_PADDING_H,
    paddingVertical: 20,
    paddingBottom: 32,
    // 内容列居中、限宽 380（原来靠内层 chatContentWrap 实现；为了让 maintainVisibleContentPosition
    // 能逐条锚定消息，消息必须是 ScrollView 内容的直接子节点 → 把限宽/居中挪到 contentContainer 自身）。
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
  },
  emptyStage: {
    flex: 1,
    paddingVertical: 40,
    paddingHorizontal: EMPTY_WELCOME_PADDING_EXTRA_H,
  },
  welcomeTitle: { fontSize: 22, fontWeight: '700', color: c.textHeader, marginBottom: 8 },
  welcomeSubtitle: { fontSize: 15, color: c.textMuted },
  bubbleWrap: { marginBottom: 14 },
  userBubbleWrap: { alignItems: 'flex-end' },
  assistantBubbleWrap: { width: '100%' },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  userBubble: { backgroundColor: c.userBubble },
  assistantBubble: {
    width: '100%',
    maxWidth: '100%',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  bubbleRole: { fontSize: 11, color: c.textMuted, marginBottom: 3, lineHeight: 16 },
  userText: { fontSize: 16, lineHeight: 22, color: c.onUserBubble },
  assistantText: { fontSize: 16, color: c.textPrimary, lineHeight: 24 },
  streamStatus: { fontSize: 14, color: c.textMuted, fontStyle: 'italic' },
  errorWrap: { marginBottom: 18, padding: 14, backgroundColor: c.errorBg, borderRadius: 8 },
  errorText: { color: c.danger, fontSize: 14 },
  assistantTextBlock: { marginTop: 7 },
  assistantTextBlockCompactAbove: { marginTop: 6 },
  /** 闭合思考块下方紧贴 markdown 正文：对齐 FlopsWeb 把首段 margin-top 砍到 0 的处理 */
  assistantTextBlockTightAfterThinking: { marginTop: 0 },
  /** 与 Web .assistant-empty-reply-block .markdown-content 一致，仅弱化提示正文 */
  assistantEmptyReplyMarkdownContent: { opacity: 0.62 },
  /** 对齐 FlopsWeb .tool-package-nav-line：icon + 灰字一行，字号对齐思考块（13）。
      上下不再额外负向拽（旧 marginTop:-4 会让 thinking-toolNav-thinking 这种连排上下不等距）。
      marginLeft:1 跟思考行整体右挪同一档，icon 水平中线左右对齐。 */
  toolPackageNavLine: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
    marginLeft: 1,
  },
  toolPackageNavLineText: {
    fontSize: 13,
    color: c.textMuted,
    lineHeight: 19,
    marginLeft: 6,
    flexShrink: 1,
  },
  toolCard: {
    marginTop: 4,
    marginBottom: 4,
    marginLeft: 0,
    marginRight: 0,
    padding: 14,
    backgroundColor: c.toolCardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderMuted,
  },
  toolCardCollapsed: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    /* 单行折叠卡：高度+圆角统一到「穿插后台信号」卡（task_event：paddingVertical 7 / horizontal 12 / radius 8）。
       覆盖 toolCard 的 padding:14 与 radius:12（展开态才需要那么大）；去掉 minHeight 36 让高度由 padding+单行文字决定。 */
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: c.surfaceMuted,
    minWidth: 0,
  },
  toolCardCollapsedPressed: { backgroundColor: c.borderMuted },
  /** 单行折叠：占满徽章左侧剩余宽度，避免标题过长把「成功」顶出卡片 */
  toolCardCollapsedMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 6,
  },
  toolCardCollapsedName: {
    fontSize: 12,
    fontWeight: '600',
    color: c.textDark,
    marginRight: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  toolCardCollapsedTail: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    color: c.textMutedSlate,
    marginRight: 0,
  },
  toolCardBadgeWrap: { marginLeft: 4, flexShrink: 0 },
  toolCardBadge: {
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.borderD4,
    color: c.textLabel,
    backgroundColor: c.borderMuted,
  },
  toolCardBadgeOk: {
    color: c.textSecondary,
    backgroundColor: c.borderMuted,
    borderColor: c.borderD4,
  },
  toolCardBadgeSuccess: {
    color: c.textSecondary,
    backgroundColor: c.borderMuted,
    borderColor: c.borderD4,
  },
  toolCardContentPressed: { opacity: 0.95 },
  toolCardExpandRow: {
    marginTop: 8,
    marginHorizontal: -10,
    marginBottom: -10,
    paddingVertical: 2,
    paddingHorizontal: 10,
    paddingBottom: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolCardExpandRowPressed: { backgroundColor: c.borderMuted },
  toolCardHeader: { fontSize: 13, fontWeight: '600', color: c.textDark, marginBottom: 8, minWidth: 0 },
  toolCardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  toolCardHeaderMain: { flex: 1, minWidth: 0 },
  toolCardHeaderFilename: { fontSize: 13, fontWeight: '600', color: c.textStrong },
  toolCardHeaderFilenamePlaceholder: { fontSize: 13, fontWeight: '600', color: c.textTertiary },
  toolCardHeaderEditSummary: { fontSize: 11, fontWeight: '500', color: c.textLabel, marginTop: 2 },
  toolCardBodyMuted: { fontSize: 12, color: c.textTertiary, fontStyle: 'italic', marginTop: 6 },
  /** search_engine：与 FlopsDesktop search-engine-card.css 对齐 */
  searchEngineHeaderMain: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textDark,
    lineHeight: 20,
  },
  searchEngineWrap: {
    flexDirection: 'column',
    gap: 10,
  },
  searchEngineQueriesSection: {},
  searchEngineQueriesLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 6,
    rowGap: 6,
  },
  searchEngineQueriesPrefix: {
    fontSize: 12,
    color: c.textDisabled,
    marginRight: 4,
  },
  searchEngineQueryChip: {
    fontSize: 12,
    color: c.textTertiary,
    textDecorationLine: 'underline',
  },
  searchEngineQueryChipOpen: {
    color: c.gray404040,
  },
  searchEngineQueryExpanded: {
    marginTop: 8,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: c.borderSubtle,
  },
  searchEnginePerQueryList: {
    marginTop: 6,
    paddingTop: 6,
    paddingLeft: 12,
    paddingRight: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: c.borderSubtle,
  },
  searchEnginePerQueryItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingVertical: 4,
  },
  searchEnginePerQueryIndex: {
    fontSize: 11,
    color: c.textDisabled,
    lineHeight: 18,
    minWidth: 18,
  },
  searchEnginePerQueryMain: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  searchEnginePerQueryLink: {
    fontSize: 12,
    fontWeight: '400',
    color: c.textStrong2,
    flexWrap: 'wrap',
  },
  searchEnginePerQueryTitle: {
    fontSize: 12,
    fontWeight: '400',
    color: c.textStrong2,
  },
  searchEnginePerQueryDesc: {
    fontSize: 12,
    color: c.textTertiary,
    lineHeight: 17,
    marginTop: 2,
  },
  searchEngineHero: {
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: c.borderSubtle,
  },
  searchEngineHeroHead: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    minWidth: 0,
    overflow: 'hidden',
  },
  searchEngineGoalInline: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 17,
    color: c.textTertiary,
  },
  searchEngineHeroSep: {
    flexShrink: 0,
    fontSize: 12,
    color: c.borderD4,
  },
  searchEngineHeroLabelInline: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '600',
    color: c.textLabel,
    letterSpacing: 0.3,
  },
  searchEngineHeroGrid: {
    gap: 10,
  },
  searchEngineHeroItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: c.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.borderCard,
    minWidth: 0,
    gap: 2,
  },
  searchEngineHeroLink: {
    fontSize: 14,
    fontWeight: '500',
    color: c.textStrong2,
    lineHeight: 19,
  },
  searchEngineHeroTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: c.textStrong2,
    lineHeight: 19,
  },
  searchEngineHeroDesc: {
    fontSize: 12,
    color: c.textTertiary,
    lineHeight: 17,
    marginTop: 2,
  },
  searchEngineMuted: {
    fontSize: 13,
    color: c.textTertiary,
    margin: 0,
  },
  searchEngineError: {
    fontSize: 13,
    color: c.dangerDark,
    margin: 0,
  },
  /** 与 Web `.tool-card-write-preview` 半折叠区域一致 */
  fileToolPreviewFullWrap: { marginTop: 8 },
  fileToolPreviewClip: {
    maxHeight: 120,
    marginTop: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  fileToolPreviewScroll: { maxHeight: 120, marginTop: 8 },
  fileToolPreviewScrollContent: { paddingBottom: 4 },
  /** local_exec_command 半折叠：与 Web .tool-card-exec-scroll-preview 类似 */
  execToolPreviewScroll: { maxHeight: 140, marginTop: 6 },
  execToolPreviewScrollContent: { paddingBottom: 6 },
  toolCardExecBody: { marginTop: 4 },
  toolCardExecPrompt: {
    fontSize: 12,
    color: c.textStrong,
    lineHeight: 18,
    marginBottom: 6,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  toolCardExecPromptPrefix: { color: c.textMutedSlate, fontWeight: '600' as const },
  toolCardExecCwd: { color: c.textTertiary },
  toolCardExecEnvBadge: {
    marginTop: 6,
    alignSelf: 'flex-start',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600' as const,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    color: c.link,
    backgroundColor: c.toolInnerSurface6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 4,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.toolBadgeBorder,
  },
  /** 时间在滚动区外，避免输出更新时底栏随 scrollToEnd 抖动 */
  toolCardExecExit: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.borderMuted,
    fontSize: 11,
    color: c.textMutedSlate,
  },
  fileToolPreviewFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 36,
  },
  fileToolPreviewEllipsis: {
    position: 'absolute',
    bottom: 2,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 12,
    color: c.textTertiary,
  },
  toolCardWritePreview: {},
  toolCardWritePreviewText: { marginTop: 0 },
  toolCardDiff: { flexDirection: 'row', gap: 12, marginTop: 8 },
  toolCardDiffPreview: { marginTop: 0 },
  toolCardDiffSide: { flex: 1, minWidth: 0 },
  toolCardDiffOld: { borderRightWidth: 1, borderRightColor: c.borderMuted, paddingRight: 12 },
  toolCardDiffLabel: { fontSize: 11, fontWeight: '600', color: c.textTertiary, marginBottom: 2 },
  toolCardDiffPre: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 12,
    lineHeight: 18,
    color: c.textStrong,
    margin: 0,
  },
  toolCardBody: { fontSize: 13, color: c.textBody, marginTop: 6, lineHeight: 20 },
  toolCardCodeText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 12,
    color: c.textHeader,
    lineHeight: 18,
    marginTop: 6,
  },
  toolCardSafetyMeta: { fontSize: 11, color: c.textMutedSlate, marginTop: 6 },
  toolCardSafetyReason: { fontSize: 12, color: c.textSlate, marginTop: 6 },
  readPagesEntryBox: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: c.borderMuted,
  },
  readPagesEntryTitle: { fontSize: 12, fontWeight: '600', color: c.textPrimary },
  readPagesTextBlock: { fontSize: 13, color: c.textBody, lineHeight: 20, marginTop: 6 },
  readPagesErrorText: { fontSize: 12, color: c.dangerTextDark, marginTop: 6 },
  readPagesLinksText: { fontSize: 12, color: c.textSlate, marginTop: 6 },
  readPagesUrlListWrap: { marginTop: 8, gap: 6 },
  readPagesUrlItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  readPagesUrlLink: { flex: 1, fontSize: 12, color: c.link },
  readPagesCardsScrollView: { marginTop: 8 },
  readPagesCardsScroll: { paddingVertical: 4, gap: 4 },
  readPagesSmallCard: {
    width: 160,
    backgroundColor: c.toolCardBg,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.borderD8,
    overflow: 'hidden',
    marginRight: 6,
  },
  readPagesSmallCardHeader: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: c.toolInnerSurface2,
    borderBottomWidth: 1,
    borderBottomColor: c.borderD5,
  },
  readPagesSmallCardHeaderStreaming: {
    borderBottomWidth: 0,
    paddingBottom: 9,
  },
  readPagesHeaderLoadBarTrack: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 0,
    height: 2,
    backgroundColor: c.readPagesTrackBg,
    borderRadius: 2,
    overflow: 'hidden',
  },
  readPagesHeaderLoadBarBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 56,
    height: 2,
    backgroundColor: c.accentPurple,
    borderRadius: 2,
  },
  readPagesSmallCardTitle: { flex: 1, fontSize: 11, fontWeight: '600', color: c.textStrong, minWidth: 0 },
  readPagesSmallCardBodyWrap: {
    width: '100%',
    aspectRatio: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  readPagesCardSquare: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.toolInnerSurface3,
  },
  readPagesCardSquareBody: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.toolCardBg,
  },
  readPagesCardSquareCenter: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  readPagesCardBodyScroll: {
    padding: 8,
    paddingBottom: 12,
  },
  readPagesCardThumb: { width: '100%', aspectRatio: 1, backgroundColor: c.toolInnerSurface4 },
  readPagesCardSpinner: { marginVertical: 20 },
  toolCardSafetyAdvice: {
    fontSize: 12,
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.borderMuted,
    backgroundColor: c.toolInnerSurface6,
  },
  toolCardSafetyAdviceDanger: {
    color: c.dangerTextDark,
    backgroundColor: c.roseBg,
    borderColor: c.roseBorder,
  },
  safetyActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  safetyBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: c.border },
  safetyBtnPrimary: { backgroundColor: c.primary },
  safetyBtnText: { color: c.textSecondary, fontSize: 14 },
  safetyBtnPrimaryText: { color: c.onPrimary, fontSize: 14 },

  /* ask_user_question 选项卡：顶部 tab 逐题 + 带框选项，黑白灰 */
  auqCard: {
    marginTop: 4,
    marginBottom: 4,
    padding: 12,
    backgroundColor: c.toolCardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderMuted,
    gap: 10,
  },
  auqHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  auqHeadTitle: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
  auqHeadDone: { fontSize: 11, color: c.textMuted },
  auqTabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.borderMuted,
    paddingBottom: 6,
  },
  auqTab: { paddingBottom: 5, marginBottom: -7, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  auqTabActive: { borderBottomColor: c.textPrimary },
  auqTabText: { fontSize: 13, color: c.textMuted, maxWidth: 160 },
  auqTabTextDone: { color: c.textSecondary },
  auqTabTextActive: { color: c.textPrimary, fontWeight: '600' },
  auqQText: { fontSize: 14, lineHeight: 21, color: c.textPrimary, marginBottom: 4 },
  auqMultiTag: { fontSize: 11, color: c.textMuted },
  auqOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    marginTop: 6,
  },
  auqOptionSelected: { borderColor: c.textPrimary, backgroundColor: c.toolCardBgPressed },
  auqOptLabel: { fontSize: 13.5, fontWeight: '600', color: c.textSecondary, flexShrink: 0 },
  auqOptLabelSelected: { color: c.textPrimary },
  auqOptDesc: { flex: 1, fontSize: 12.5, color: c.textMuted },
  auqOptCheck: { fontSize: 13, fontWeight: '700', color: c.textPrimary },
  auqOther: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    fontSize: 13,
    color: c.textPrimary,
  },
  auqActions: { flexDirection: 'row', justifyContent: 'flex-end' },
  auqSubmit: {
    minWidth: 76,
    paddingVertical: 7,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: c.primary,
    alignItems: 'center',
  },
  auqSubmitDisabled: { backgroundColor: c.border },
  auqSubmitText: { color: c.onPrimary, fontSize: 13, fontWeight: '500' },
  auqSubmitTextDisabled: { color: c.textMuted },
  auqNote: { fontSize: 12.5, color: c.textMuted },

  /* 统一子 agent 卡（与 Web 对齐）：一张卡内 头部 + 灰底提问内嵌 + 无框回答 */
  subCard: {
    marginTop: 4,
    marginBottom: 4,
    padding: 12,
    backgroundColor: c.chatScreenBackground,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderMuted,
    gap: 10,
  },
  subPromptZone: { paddingHorizontal: 12, paddingTop: 6 },
  subPrompt: { backgroundColor: c.surface, borderRadius: 8, padding: 10, position: 'relative' },
  subPromptLabel: { fontSize: 11, fontWeight: '600', color: c.textMuted, marginBottom: 4 },
  subPromptText: { fontSize: 13, lineHeight: 20, color: c.textPrimary },
  subPromptMeta: { fontSize: 12, color: c.textMuted, marginTop: 8 },
  subReply: {},
  subReplyLabel: { fontSize: 11, fontWeight: '600', color: c.textMuted, marginBottom: 4 },
  subHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subIcon: { width: 16, alignItems: 'center', justifyContent: 'center' },
  /* 步骤数·耗时行（像折叠态工具卡） */
  subSteps: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: c.toolCardBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.borderMuted,
  },
  subStepsIcon: { marginRight: 6, flexShrink: 0 },
  subStepsName: { fontSize: 11, fontWeight: '600', color: c.textDark, flexShrink: 0 },
  subStepsTail: { flex: 1, fontSize: 11, color: c.textMutedSlate, marginLeft: 8, minWidth: 0 },
  subStepsAction: { fontSize: 11, fontWeight: '600', color: c.textMuted, marginLeft: 8, flexShrink: 0 },
  /* 半展开预览（markdown 限高 + 底部渐变） */
  subPreviewZone: { paddingHorizontal: 12, paddingBottom: 2 },
  subPreview: { position: 'relative', overflow: 'hidden' },
  subFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 44 },
  /* 底部展开/收起 bar */
  subBar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: c.borderMuted,
    marginTop: 4,
  },
  subBarChevron: { fontSize: 12, color: c.textMuted },
  subAgentLabel: { fontSize: 13, fontWeight: '700', color: c.textPrimary, flexShrink: 0 },
  subSessionBadge: {
    fontSize: 11,
    color: c.textMuted,
    backgroundColor: c.surfaceMuted,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 6,
    flexShrink: 1,
  },
  subModelBadge: {
    fontSize: 11,
    color: c.textMuted,
    backgroundColor: c.surfaceMuted,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 6,
    flexShrink: 1,
  },
  subExecutor: { fontSize: 11, color: c.textMuted, flexShrink: 1 },
  subStatus: { fontSize: 11, color: c.textMuted, fontWeight: '600' },
  subStatusErr: { color: c.danger },
  subBlocks: { marginTop: 4, gap: 6 },
  subThinking: { fontSize: 12.5, color: c.textMuted, fontStyle: 'italic' },
  subTextBlock: { marginVertical: 2 },
  subInnerMono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    color: c.textSecondary,
    marginTop: 4,
  },
  subInnerOut: { color: c.textMuted, marginTop: 6 },
  subInnerDel: { color: c.textMuted },
  subInnerAdd: { color: c.textPrimary },
  subInnerPath: { fontSize: 12.5, color: c.textSecondary, marginTop: 2 },
  subInnerHint: { fontSize: 11.5, color: c.textMuted, marginTop: 4 },

  /* find/get 会话摘要卡 */
  subMetaCard: {
    marginTop: 4,
    marginBottom: 4,
    padding: 12,
    backgroundColor: c.toolCardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderMuted,
    gap: 4,
  },
  subMetaHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subMetaTitle: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
  subMetaAgent: { fontSize: 11, color: c.textMuted },
  subMetaSummary: { fontSize: 11.5, color: c.textMuted },
  subMetaDetail: { fontSize: 12, color: c.textMuted },
  cursorAgentWrap: { marginTop: 8, gap: 14 },
  cursorAgentPromptCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.backgroundSecondary,
  },
  cursorAgentPromptLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textMuted,
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  cursorAgentPromptText: { fontSize: 14, lineHeight: 22, color: c.textPrimary },
  cursorAgentPromptMeta: { fontSize: 12, color: c.textMuted, marginTop: 10 },
  cursorAgentReply: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.borderMuted,
    backgroundColor: c.surface,
  },
  cursorAgentReplyLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textLabel,
    marginBottom: 10,
    letterSpacing: 0.4,
  },
  cursorAgentReplyBody: { marginTop: 4 },
  cursorAgentReplyLoading: { fontSize: 13, color: c.textMuted, fontStyle: 'italic' },
  cursorAgentReplyEmpty: { fontSize: 13, color: c.textMuted, fontStyle: 'italic' },
  cursorAgentReplyError: {
    fontSize: 13,
    color: c.dangerDark,
    backgroundColor: c.errorBg,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.roseBorderStrong,
  },
  composerInput: {
    flex: 1,
    backgroundColor: c.inputBg,
    borderRadius: COMPOSER_CARD_RADIUS,
    minHeight: COMPOSER_PILL_SIZE,
    paddingHorizontal: 20,
    paddingVertical: 14,
    fontSize: 16,
    color: c.textPrimary,
    /** iOS：无描边 + 与顶栏圆钮差异化的 offset0 阴影；Android：与顶栏圆钮同 androidCircleFabOutline */
    ...shadowMenu,
  },
  /** 实心圆钮：`chatComposerSendBackground`（浅色柔灰深、深色仅略亮于 userBubble） */
  sendBtn: {
    width: CHAT_COMPOSER_SEND_BTN_SIZE,
    height: CHAT_COMPOSER_SEND_BTN_SIZE,
    borderRadius: CHAT_COMPOSER_SEND_BTN_SIZE / 2,
    backgroundColor: c.chatComposerSendBackground,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    overflow: 'hidden',
  },
  sendBtnStop: { backgroundColor: c.danger },
  /* ============================================================
   * composer 重设计：发送靠键盘 Return（无 send 按钮）；+ 内嵌
   *   - short：胶囊单行 [+ icon] [input]，仍走 inputRowInOverlay 的 padding
   *   - tall：圆角卡片两行，[input full-width] / [+ icon 单独一行]，模型 chips 仍在底部 absolute meta row
   * ============================================================ */
  /* card 不再叠 padding 给文本视觉留白；那些 paddingH / paddingT/B 全移到 FlowDocSlateAdapter
   * 的 textContainerInset 里（COMPOSER_TEXT_INSET_SHORT/TALL），让 native UITextView / EditText
   * 自己撑满 card，自身 tap recognizer 覆盖整片可点区域 —— 卡片其它区域 tap 等效 input 自身 tap。
   * card 仍保留 marginH/T/B 跟外屏边界拉开，alignItems:stretch（短）/ stretch 默认（长）让
   * adapter 沿轴向撑满。+ 按钮仍是 absolute child 占左下角。 */
  composerCardShort: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: c.inputBg,
    borderRadius: COMPOSER_PILL_SIZE / 2,
    minHeight: COMPOSER_PILL_SIZE,
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    marginBottom: 18,
    /** 跟今日页 searchInputBox 阴影规格对齐 —— 同款 shadowMenu（iOS opacity 0.1 radius 12 /
     * Android elevation 12），两个屏视觉等阶 */
    ...shadowMenu,
  },
  composerCardTall: {
    position: 'relative',
    flexDirection: 'column',
    backgroundColor: c.inputBg,
    /** 与 short 胶囊两端的半圆同半径，视觉一致 */
    borderRadius: COMPOSER_PILL_SIZE / 2,
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    marginBottom: 18,
    ...shadowMenu,
  },
  /** Input-area：所有模式下都包住 inputWrapper（FlowDocSlateAdapter 的父级），保证
   *  adapter 跨 short/tall 切换时 React 节点位置一致 — 不卸载、firstResponder 不丢。
   *  Short：单行 flex row，左侧 paddingLeft 给绝对 + 让位（+ 是 card 的 absolute child）。
   *  Tall：column，输入填满宽度；底部 paddingBottom 给绝对 + 让位。 */
  /** iOS 26 Liquid Glass 路径下的 short / tall card 样式：去掉 backgroundColor + shadow + border
   *  —— 玻璃材质 + 系统折光由 BouncyGlassCard 内部 UIVisualEffectView 提供，cornerRadius 通过 prop
   *  传给 native。布局相关的 padding / margin / minHeight / flex direction 全部保留。 */
  composerCardShortGlass: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: COMPOSER_PILL_SIZE,
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    marginBottom: 18,
  },
  composerCardTallGlass: {
    position: 'relative',
    flexDirection: 'column',
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    marginBottom: 18,
  },
  /** Android（及需要时旧 iOS）现代兜底：对齐 iOS 26 玻璃版的圆角 / 布局，但 RN Android 无 backdrop-filter，
   *  故用半透明底色 c.composerModernBg + 细描边 c.hairlineBorder 近似玻璃层次；**不上** shadowMenu 重阴影。
   *  圆角用 COMPOSER_CARD_RADIUS（= 玻璃版 cornerRadius），保证三路视觉一致。 */
  composerCardShortModern: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: c.composerModernBg,
    borderRadius: COMPOSER_CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hairlineBorder,
    minHeight: COMPOSER_PILL_SIZE,
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    marginBottom: 18,
  },
  composerCardTallModern: {
    position: 'relative',
    flexDirection: 'column',
    backgroundColor: c.composerModernBg,
    borderRadius: COMPOSER_CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hairlineBorder,
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    marginBottom: 18,
  },
  /** Adapter 撑满 card：alignSelf stretch（沿 flex 横轴 / 纵轴自动 stretch），flex 1 让它
   *  在轴向也吃满。配合 FlowDocInput 内部 autoHeight 用 minHeight（不是 height）的改造,
   *  adapter UIView 一方面跟着 native 测出的 content 高度走 minHeight，一方面允许 flex 父
   *  容器把它拉得更大——所以 short 模式下 card minHeight:40 + flex stretch → adapter UIView
   *  是 40pt，tall 模式 card 高度跟着 adapter content + 上下 inset 自然增长。 */
  composerAdapterFill: {
    flex: 1,
    alignSelf: 'stretch',
  },
  composerInputAreaShort: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    /** 派生自 + 内嵌位 + 间距 + 卡片 padding（推导见顶部 COMPOSER_INPUT_PAD_LEFT_SHORT）。
     *  COMPOSER_PILL_SIZE 变小时自动跟着小，cursor 始终落在 + 右沿 + GAP。 */
    paddingLeft: COMPOSER_INPUT_PAD_LEFT_SHORT,
  },
  composerInputAreaTall: {
    /** 默认 flexDirection column；不限制 minHeight，单行起步。
     *  paddingBottom 让 input 底跟 + 顶留 GAP 间距，公式见顶部 COMPOSER_INPUT_PAD_BOTTOM_TALL。 */
    paddingBottom: COMPOSER_INPUT_PAD_BOTTOM_TALL,
  },
  composerInputShort: {
    flex: 1,
    paddingHorizontal: COMPOSER_CARD_PADDING_H,
    /* FlowDocInput 高度 = native 测出的内容高度（约 1 行字号 × 1.6 ≈ 26dp），
     *  比 minHeight (40dp) 短，靠 justifyContent center 把它落到容器中。
     *  Android: paddingTop < paddingBottom (2/6) 是有意为之 —— 字体视觉重心高于几何
     *    中心（descender < ascender 视觉权重），Android 那侧 native 文本绘制按 baseline
     *    对齐让单行视觉偏下，2dp 不对称把它推回几何中心。
     *  iOS: 走对称 4/4。iOS 文本 baseline 处理跟 lineBox 几何中心已经一致，再叠不对称
     *    padding 反而让文本看着偏下（用户实测）。 */
    ...Platform.select({
      ios: { paddingTop: 8, paddingBottom: 2 },
      android: { paddingTop: 2, paddingBottom: 6 },
      default: { paddingTop: 2, paddingBottom: 6 },
    }),
    minHeight: COMPOSER_PILL_SIZE - 12,
    justifyContent: 'center',
  },
  composerInputTall: {
    /* tall 模式下输入区填满卡片宽度；高度完全由 native autoHeight 决定，
     *  刚切到 tall 模式时单行内容 ≈ 1 行高度，不要强制 minHeight 撑成两行 */
    paddingHorizontal: 12,
  },
  /** Card-absolute 的 + 圆钮：外层是 TOUCH_SIZE 的真实可点区（native / JS 命中一致，见
   *  COMPOSER_PLUS_BTN_TOUCH_SIZE 注释），跟旧 32 + hitSlop 6 的 JS 命中区完全等大；
   *  short / tall 两模式 screen 位置一致，+ center 到 card 顶/底/左三边距离仍是
   *  COMPOSER_PILL_SIZE / 2（同心，圆心不动）。 */
  composerPlusBtnAbsolute: {
    position: 'absolute',
    bottom: COMPOSER_PLUS_BTN_TOUCH_INSET,
    left: COMPOSER_PLUS_BTN_TOUCH_INSET,
    width: COMPOSER_PLUS_BTN_TOUCH_SIZE,
    height: COMPOSER_PLUS_BTN_TOUCH_SIZE,
    borderRadius: COMPOSER_PLUS_BTN_TOUCH_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  /** MenuView / TouchableOpacity 内层：32 视觉位（iOS 承载图标淡出动画）。Android popover
   *  锚点已改为 composer 卡片本体（composerCardRef，菜单左下对齐卡片），不再 measure 这里。 */
  composerPlusBtnInner: {
    width: COMPOSER_PLUS_BTN_SIZE,
    height: COMPOSER_PLUS_BTN_SIZE,
    borderRadius: COMPOSER_PLUS_BTN_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 「发送文件」待发附件 chips 行：贴在 composer 上方，可换行。 */
  composerAttachRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  /** 附件卡片：缩略图 + 文件名/大小 + × 移除。圆角 + 淡底 + 细边，对齐 Desktop attachment-chip-image。 */
  composerAttachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: 240,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.borderMuted,
    backgroundColor: c.surfaceMuted,
  },
  composerAttachChipError: {
    borderColor: c.danger,
  },
  /** 48 方形缩略图 / 文件类型图标容器：圆角、裁切、居中。 */
  composerAttachThumb: {
    width: 44,
    height: 44,
    borderRadius: 9,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surface,
  },
  composerAttachThumbImg: {
    width: '100%',
    height: '100%',
  },
  /** 上传中 / 失败：盖在缩略图上的半透明蒙层 + 转圈 / 图标。 */
  composerAttachThumbOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  composerAttachThumbOverlayErr: {
    backgroundColor: 'rgba(185,28,28,0.82)',
  },
  /** 文件名 + 大小 文本列。 */
  composerAttachMeta: {
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 1,
  },
  composerAttachName: {
    fontSize: 13,
    fontWeight: '500',
    color: c.textBody,
  },
  composerAttachSize: {
    fontSize: 11,
    color: c.textSecondary,
  },
  composerAttachErrText: {
    fontSize: 11,
    color: c.danger,
  },
  /** × 移除键：小圆按钮，靠右。 */
  composerAttachRemove: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Android「+」附件菜单 popover 卡片：几何跟 convMenuCard / TodayScreen fabMenuCard 完全同款
   *  （minWidth 240 / 圆角 26 / shadowMenu），统一「按钮变菜单」设计语言；
   *  位置（left/top）由 open 时 measure 后经 SharedValue 注入（见 ChatScreen 声明注释）。 */
  composerAttachMenuCard: {
    position: 'absolute',
    minWidth: 240,
    backgroundColor: c.surface,
    borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    overflow: 'hidden',
    paddingVertical: 6,
    paddingHorizontal: 18,
    zIndex: 9999,
    elevation: 9999,
    ...shadowMenu,
  },
  /** 发送/停止键（iOS）：跟 + 镜像，靠右、跟右半圆同心。 */
  composerSendBtnAbsolute: {
    position: 'absolute',
    bottom: COMPOSER_SEND_BTN_INSET,
    right: COMPOSER_SEND_BTN_INSET,
    width: COMPOSER_SEND_BTN_SIZE,
    height: COMPOSER_SEND_BTN_SIZE,
    borderRadius: COMPOSER_SEND_BTN_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  /** 麦克风键：card-absolute 圆钮，在发送键左边（iOS / Android 同）；尺寸同发送键。脉冲 transform 挂在内部涟漪层。 */
  composerMicBtnAbsolute: {
    position: 'absolute',
    /* 尺寸与发送键相同 → 用发送键 inset 让两者垂直中心对齐（跟 + / 发送键同一排居中）。 */
    bottom: COMPOSER_SEND_BTN_INSET,
    right: COMPOSER_MIC_BTN_RIGHT,
    width: COMPOSER_MIC_BTN_SIZE,
    height: COMPOSER_MIC_BTN_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 6,
  },
  composerMicBtnInner: {
    width: COMPOSER_MIC_BTN_SIZE,
    height: COMPOSER_MIC_BTN_SIZE,
    borderRadius: COMPOSER_MIC_BTN_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 录音态图标后面的稳定红色背景圆（低透明度），提供持续的"正在录音"底色。
   *  铺满整个按钮 → 跟右边的发送圆钮同样大小（视觉成比例）。 */
  composerMicActiveDisc: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: COMPOSER_MIC_BTN_SIZE / 2,
    backgroundColor: c.danger,
    opacity: 0.16,
  },
  /** 录音态涟漪：跟背景圆同位同色，由 micPulseStyle 驱动 scale 往外扩散 + opacity 淡出。
   *  opacity 由动画提供（这里不设），overflow 默认 visible 让它能溢出按钮边界扩散。 */
  composerMicPulseRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: COMPOSER_MIC_BTN_SIZE / 2,
    backgroundColor: c.danger,
  },
  /** 语音听写错误气泡：贴在 composer 上方的临时提示（4s 自动消失）。 */
  composerDictationError: {
    alignSelf: 'center',
    maxWidth: '90%',
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.danger,
  },
  composerDictationErrorText: {
    fontSize: 13,
    lineHeight: 18,
    color: c.danger,
  },
  });
}
