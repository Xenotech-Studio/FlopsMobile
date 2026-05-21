import { Platform, StyleSheet } from 'react-native';
import { SHADOW_COLOR, androidCircleFabOutline, shadowCircleButtonThemed } from '../../theme/shadows';
import { HEADER_CIRCLE_BTN_SIZE, CHAT_COMPOSER_SEND_BTN_SIZE } from '../../theme/layout';
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
/** 主胶囊高度 = 顶栏圆钮直径，全局视觉锚点。改这个值会带动 + 内嵌、padding 等。 */
const COMPOSER_PILL_SIZE = HEADER_CIRCLE_BTN_SIZE + 0;
/** 内嵌 + / ⏹ 圆钮尺寸 */
const COMPOSER_PLUS_BTN_SIZE = 32;
/** + center 到 card 上 / 下 / 左 三边的距离 = COMPOSER_PILL_SIZE / 2；
 *  对应 + 边沿到 card 边沿的 inset。绝对定位的 `bottom` / `left` 都用这个。 */
const COMPOSER_PLUS_BTN_INSET =
  (COMPOSER_PILL_SIZE - COMPOSER_PLUS_BTN_SIZE) / 2;
/** + 右沿到输入区 cursor 左边缘的视觉间距 */
const COMPOSER_PLUS_TO_INPUT_GAP = 6;
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

export function createChatStyles(c: AppColors) {
  return StyleSheet.create({

  container: { flex: 1, backgroundColor: c.chatScreenBackground },
  containerInner: { flex: 1 },
  keyboardView: { flex: 1 },
  scrollAndGradientWrap: { flex: 1, position: 'relative' },
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
  /** Android ⋯ 菜单 popover：iOS 走 MenuView native，本组只给 Android 用。
   *  backdrop = 整屏透明遮罩（点空白关）；卡片 absolute 锚定在右上角圆按钮下方。 */
  convMenuBackdrop: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  convMenuCard: {
    position: 'absolute',
    minWidth: 200,
    backgroundColor: c.surface,
    borderRadius: 14,
    paddingVertical: 4,
    /* 立体感全交给阴影：iOS shadow* + Android elevation 12 + 共用 SHADOW_COLOR alpha。
       描边去掉了，靠 surface 色 + 投影边缘渗光就够形状辨识。 */
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 12,
  },
  convMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  convMenuItemText: { fontSize: 15, color: c.textPrimary, fontWeight: '500' },
  convMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.borderMuted,
    marginHorizontal: 8,
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
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: CHAT_SCROLL_PADDING_H,
    paddingVertical: 20,
    paddingBottom: 32,
    alignItems: 'center',
  },
  chatContentWrap: {
    width: '100%',
    maxWidth: 380,
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
    minHeight: 36,
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
    borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    minHeight: HEADER_CIRCLE_BTN_SIZE,
    paddingHorizontal: 20,
    paddingVertical: 14,
    fontSize: 16,
    color: c.textPrimary,
    /** iOS：无描边 + 与顶栏圆钮差异化的 offset0 阴影；Android：与顶栏圆钮同 androidCircleFabOutline */
    ...(Platform.OS === 'ios'
      ? {
          shadowColor: SHADOW_COLOR,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.07,
          shadowRadius: 14,
        }
      : Platform.OS === 'android'
        ? androidCircleFabOutline(c, 2)
        : {}),
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
  composerCardShort: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.inputBg,
    borderRadius: COMPOSER_PILL_SIZE / 2,
    minHeight: COMPOSER_PILL_SIZE,
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    marginBottom: 18,
    paddingHorizontal: COMPOSER_CARD_PADDING_H,
    /** iOS 微阴影 + Android 描边，跟原 composerInput 视觉对齐 */
    ...(Platform.OS === 'ios'
      ? {
          shadowColor: SHADOW_COLOR,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.07,
          shadowRadius: 14,
        }
      : Platform.OS === 'android'
        ? androidCircleFabOutline(c, 2)
        : {}),
  },
  composerCardTall: {
    position: 'relative',
    flexDirection: 'column',
    backgroundColor: c.inputBg,
    /** 与 short 胶囊两端的半圆同半径，视觉一致 */
    borderRadius: COMPOSER_PILL_SIZE / 2,
    marginHorizontal: COMPOSER_ROW_PADDING_H,
    marginTop: 12,
    /** 跟 short 同 marginBottom：保证 short ↔ tall 切换时卡片底边线 y 完全不变。
     *  绝对定位的 + 按钮 / chips meta row 都跟卡片底对齐，所以也跟着不动。 */
    marginBottom: 18,
    paddingTop: COMPOSER_TALL_PAD_TOP,
    paddingBottom: COMPOSER_TALL_PAD_BOTTOM,
    /** 左右 padding 跟 short 一样小，让 + 不会比单行模式更靠右 */
    paddingHorizontal: COMPOSER_CARD_PADDING_H,
    ...(Platform.OS === 'ios'
      ? {
          shadowColor: SHADOW_COLOR,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.07,
          shadowRadius: 14,
        }
      : Platform.OS === 'android'
        ? androidCircleFabOutline(c, 2)
        : {}),
  },
  /** Input-area：所有模式下都包住 inputWrapper（FlowDocSlateAdapter 的父级），保证
   *  adapter 跨 short/tall 切换时 React 节点位置一致 — 不卸载、firstResponder 不丢。
   *  Short：单行 flex row，左侧 paddingLeft 给绝对 + 让位（+ 是 card 的 absolute child）。
   *  Tall：column，输入填满宽度；底部 paddingBottom 给绝对 + 让位。 */
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
     *  paddingTop < paddingBottom 是有意为之：字体视觉重心高于几何中心
     *  （descender < ascender 视觉权重），纯几何居中会显得偏下，
     *  上下不对称 2dp 把视觉中心推回胶囊几何中心。 */
    paddingTop: 2,
    paddingBottom: 6,
    minHeight: COMPOSER_PILL_SIZE - 12,
    justifyContent: 'center',
  },
  composerInputTall: {
    /* tall 模式下输入区填满卡片宽度；高度完全由 native autoHeight 决定，
     *  刚切到 tall 模式时单行内容 ≈ 1 行高度，不要强制 minHeight 撑成两行 */
    paddingHorizontal: 12,
  },
  /** Card-absolute 的 + / ⏹ 圆钮：bottom = left = COMPOSER_PLUS_BTN_INSET，short / tall 两模式
   *  screen 位置完全一致；+ center 到 card 顶/底/左三边距离都是 COMPOSER_PILL_SIZE / 2。
   *  COMPOSER_PILL_SIZE 变小时 inset 自动跟着变小，+ 仍正确居中。 */
  composerPlusBtnAbsolute: {
    position: 'absolute',
    bottom: COMPOSER_PLUS_BTN_INSET,
    left: COMPOSER_PLUS_BTN_INSET,
    width: COMPOSER_PLUS_BTN_SIZE,
    height: COMPOSER_PLUS_BTN_SIZE,
    borderRadius: COMPOSER_PLUS_BTN_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  });
}
