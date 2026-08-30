/**
 * ChatMessageArea —— 聊天消息区（受控展示组件 + 滚动自治）。
 *
 * 从 ChatScreen.tsx 里原样抽出来的那块 ScrollView：消息列表 / 流式气泡 / 加载遮罩，
 * 外加**全套滚动机制**（钉底状态机、贴底判定、顶部分页触发防抖、prepend 锚定）。
 *
 * 边界：
 * - 数据源不归它管。messages / currentAssistantBlocks 等一律由 ChatScreen 下发；
 *   renderMessage / renderToolBlock 也留在 ChatScreen（它们闭包了十几个局部状态），
 *   这里只负责摆放。
 * - 滚动归它管。scrollRef / atBottomRef / 三个尺寸 ref 都在这里，外部要滚动/钉底一律走
 *   ref 上的命令（见 ChatMessageAreaHandle）。例外是钉底状态机本身（bottomPin）：它得
 *   熬过协同模式换容器的重挂，所以归 ChatScreen 持有、当 prop 传进来。
 * - 顶部「加载更旧」的**触发与防抖**在这里，**网络调用**在 ChatScreen（onReachTop 桥接）。
 */
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import type { Session, ConversationAttachment, ConversationMessage } from '../../api';
import type { ChatMessage, StreamBlock } from '../../utils/chatLocalMessages';
import type { ContextCompressDividerPlacement } from '../../utils/contextCompress';
import type { AppColors } from '../../theme/appColors';
import type { createChatStyles } from './ChatScreen.styles';
import { READING_MAX_WIDTH } from '../../hooks/useResponsive';
import { ConversationAttachmentsContext } from '../../chat/ConversationAttachmentsContext';
import { FlowDocItemMetaProvider } from '../../context/FlowDocItemMetaContext';
import { MarkdownContent } from '../../components/MarkdownContent';
import { ContextCompressDividerRow } from '../../components/ContextCompressDividerRow';
import { ThinkingBlockView } from './ThinkingBlockView';
import { TaskEventCardView, UserInjectionInline } from './TaskEventCardView';
import { HistoryLoadingOverlay } from './HistoryLoadingOverlay';
import { isClosedThinkingBlock, isToolPackageNavBlock } from '../../utils/chatStreamBlockKinds';
import {
  armForOpen,
  armOnce,
  consumeScrollIntent,
  isInOpenWindow,
  release as releaseBottomPin,
  type BottomPinState,
} from '../../utils/chatBottomPin';

type ChatStyles = ReturnType<typeof createChatStyles>;

/** 外部（ChatScreen）能对消息区下的命令。全部只读/写内部 ref，不触发本组件渲染。 */
export type ChatMessageAreaHandle = {
  /** 立刻滚到底（点底部渐变区那种直接动作）。 */
  scrollToBottom: (animated?: boolean) => void;
  /** 一次性钉底：发消息 / 回复结束等时机，下一次内容变高时滚到底。 */
  armOnce: () => void;
  /** 打开对话式钉底：武装一个时间窗口，窗口内每次内容变高都重新贴底。 */
  armForOpen: () => void;
  /** 视口此刻是否贴在列表底部（回前台补消息时决定要不要跟到底）。 */
  isAtBottom: () => boolean;
  /** 滚到指定内容偏移（摘要分界定位用）。 */
  scrollToPosition: (y: number, animated?: boolean) => void;
  /** ScrollView 内容容器原生节点，供外部 measureLayout 取相对偏移；无则 null。 */
  getInnerViewNode: () => number | null;
  /** 可视区域高度（onLayout 记录）；未量到时为 0。 */
  getViewportHeight: () => number;
};

export type ChatMessageAreaProps = {
  /* ---- 渲染数据（数据源留在 ChatScreen） ---- */
  session: Session;
  conversationId: string;
  messages: ChatMessage[];
  serverRawMessages: ConversationMessage[];
  currentAssistantBlocks: StreamBlock[];
  streamingText: string;
  liveInjections: Array<{ id: string; text: string }>;
  conversationAttachmentsMap: Map<string, ConversationAttachment> | null;
  contextCompressPlacement: ContextCompressDividerPlacement | null;
  /** 摘要分界行原生节点 ref：ChatScreen 持有（renderMessage 里也要挂），这里只是转交给分界行。 */
  contextCompressAnchorRef: React.RefObject<View | null>;
  /** 钉底状态机（utils/chatBottomPin）。**由 ChatScreen 持有**，好让它熬过协同模式换容器
   *  带来的重挂；本组件只读写它，不负责创建。理由详见组件内声明区那段注释。 */
  bottomPin: BottomPinState;

  /* ---- 状态门控 ---- */
  showEmpty: boolean;
  loading: boolean;
  bgPauseRecovering: boolean;
  conversationHistoryLoading: boolean;
  reloadPending: boolean;
  loadingOlder: boolean;
  /** 窗口上方还有更旧的消息（= messageWindowMeta.hasOlder），顶部到边才值得触发分页。 */
  hasOlder: boolean;

  /* ---- 文案 ---- */
  composerAgentLabel: string;
  streamStatusBracketLabel: string;
  streamBubblePlaceholderText: string;
  /** 续起续接已有 assistant 气泡时为 true：隐藏流式气泡的「Agent 名 (状态)」角色条（对齐 Desktop） */
  streamIsResumeContinuation?: boolean;

  /* ---- 渲染委托（闭包留在 ChatScreen，别搬） ---- */
  /** 已经渲染好的历史消息行。ChatScreen 侧用 useMemo 按引用缓存整棵子树（见那处注释）：
   *  流式期间 messages 不变 → 这里拿到的是同一批 element → React 整块跳过。
   *  所以这里收的是**成品**而不是 renderMessage 回调 —— 换成回调就等于每帧重建一遍。 */
  renderedMessages: React.ReactNode;
  /** 消息流尾部内嵌节点（档 B 对话访问授权 / 批量标题解密授权卡等），跟随滚动、非全屏遮罩 */
  footerNode?: React.ReactNode;
  renderToolBlock: (block: Extract<StreamBlock, { type: 'tool' }>, key: string) => React.ReactNode;
  /** 子 agent 完成通知的「查看对话」入口（透传给流式内联 TaskEventCardView）。 */
  onOpenSubagentView?: (args: {
    sessionId: string;
    title?: string;
    agentType?: 'flops' | 'claude' | 'cursor';
    deviceId?: string;
    cwd?: string;
  }) => void;
  /** 「打开原对话」（透传给流式内联 TaskEventCardView）。 */
  onOpenConversation?: (conversationId: string) => void;
  onRegenerate: (afterUserIndex: number) => void;

  /* ---- 回调 ---- */
  /** 滚到顶部到边（已防抖）：父去 getMessagesBefore。 */
  onReachTop: () => void;
  /** 碰列表 = 离开输入态（收键盘 / 关菜单）。 */
  onDismissComposer: () => void;

  /* ---- 布局 / 主题 ---- */
  styles: ChatStyles;
  colors: AppColors;
  headerHeight: number;
  scrollBottomPadding: number;
  wideChat: boolean;
  /** 历史 loading 遮罩往下延伸的像素数（盖住溢出到 safe-area 的 composer chips）。 */
  historyOverlayBottomOverflow: number;
};

export const ChatMessageArea = forwardRef<ChatMessageAreaHandle, ChatMessageAreaProps>(
  function ChatMessageArea(
    {
      session,
      conversationId,
      messages,
      serverRawMessages,
      currentAssistantBlocks,
      streamingText,
      liveInjections,
      conversationAttachmentsMap,
      contextCompressPlacement,
      contextCompressAnchorRef,
      bottomPin,
      showEmpty,
      loading,
      bgPauseRecovering,
      conversationHistoryLoading,
      reloadPending,
      loadingOlder,
      hasOlder,
      composerAgentLabel,
      streamStatusBracketLabel,
      streamBubblePlaceholderText,
      streamIsResumeContinuation,
      renderedMessages,
      footerNode,
      renderToolBlock,
      onOpenSubagentView,
      onOpenConversation,
      onRegenerate,
      onReachTop,
      onDismissComposer,
      styles,
      colors,
      headerHeight,
      scrollBottomPadding,
      wideChat,
      historyOverlayBottomOverflow,
    },
    ref
  ) {
    const scrollRef = useRef<ScrollView>(null);
    /** ScrollView 可视区域高度，用于把摘要分界滚到竖直方向居中 */
    const scrollViewportHeightRef = useRef(0);
    const scrollOffsetYRef = useRef(0);
    const scrollContentHeightRef = useRef(0);
    /** 视口是否贴在列表底部（onScroll 里维护）。用途：回前台补消息时决定要不要贴底 ——
     *  「走的时候在看最新」才跟到底，用户手动上翻过就不拽回。用 ref 不用 state：
     *  滚动中每帧都在更新，进 state 会把整棵消息区推着重渲染。
     *  初值 false：内容还没铺开时谈不上"在底部"，真到底了 onScroll/onContentSizeChange 会纠正。 */
    const atBottomRef = useRef(false);
    /** 防抖:顶部触发过一次加载后置 true，直到用户滚离顶部(y>300)才重新武装，避免一次滚动连环触发多批。 */
    const nearTopTriggeredRef = useRef(false);
    /* 「钉底」状态机（见 utils/chatBottomPin）：
     *  - 一次性触发：有新消息 / 回复完成时滚一下，避免展开折叠工具卡片时误滚；
     *  - 打开对话额外武装一个时间窗口：首个 onContentSizeChange 往往发生在图片（fit-image
     *    异步量高）、flowdoc 附件、resume 流式气泡都还没量出高度时，只滚那一次会停在半路。
     *
     *  它**不在这里 useRef**，而是由 ChatScreen 持有后当 prop 传进来（见 bottomPin）：
     *  协同模式的布局分叉会把消息区换到 BottomSheet 下 —— 跨父节点 = 整个实例重挂，内部
     *  useRef 全部重建。而「打开对话」那次 armForOpen 武装在 setMessages **之前**，正好
     *  赶在这次重挂之前：状态若归本组件所有，窗口就跟着旧实例一起没了，新实例带着全量内容
     *  挂出来、内容高度不再变化，窗口永远等不到触发源 → 列表停在 offset 0（远古历史）。
     *  挂到父级后窗口能穿过重挂活下来，新实例挂载时必然 fire 的 onLayout /
     *  onContentSizeChange 直接就能消费它，不必再赌 effect 与原生布局事件的先后。 */

    /* 命令全部只碰 ref / 父级状态，句柄本身恒定 —— ChatScreen 那些长寿闭包（onEvent /
       AppState 回调）捕获到的 messageAreaRef 永远指向当前实例，不会拿到陈旧命令。 */
    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom: (animated = true) => {
          scrollRef.current?.scrollToEnd({ animated });
        },
        armOnce: () => {
          armOnce(bottomPin);
        },
        armForOpen: () => {
          armForOpen(bottomPin, Date.now());
          /* 光武装窗口不够 —— 窗口的唯一触发源是 onContentSizeChange（内容**变高**）。
             平铺路径下成立：ScrollView 先空着挂出来，armForOpen 又排在 setMessages 之前，
             内容 0 → N 必然 fire 一次，窗口顺势被消费。
             协同模式不成立：布局分叉是在「灌 messages 的同一次提交」里把消息区换了父节点，
             新实例第一帧内容高度就是终值 —— 那唯一一次 onContentSizeChange 跟这里的武装是
             竞态，且此后高度再不变化，窗口就永远等不到触发源，列表停在 offset 0（远古历史）。
             所以主动补几发：立即 + rAF + 200ms，跟 Web snapChatThreadToEnd 同款三连，
             熬过「刚 mount 还没量完 / sheet 高度还在动画」这段。 */
          atBottomRef.current = true;
          const snap = () => scrollRef.current?.scrollToEnd({ animated: false });
          snap();
          requestAnimationFrame(snap);
          setTimeout(snap, 200);
        },
        isAtBottom: () => atBottomRef.current,
        scrollToPosition: (y: number, animated = true) => {
          scrollRef.current?.scrollTo({ y, animated });
        },
        getInnerViewNode: () => scrollRef.current?.getInnerViewNode?.() ?? null,
        getViewportHeight: () => scrollViewportHeightRef.current,
      }),
      /* bottomPin 是 ChatScreen 那边 useRef 里的对象，整个会话期间恒定，句柄实际不会重建；
         列进依赖只为满足 exhaustive-deps，顺带保证万一父级换了对象也不会拿到旧的。 */
      [bottomPin]
    );

    return (
      <>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            const prev = scrollViewportHeightRef.current;
            scrollViewportHeightRef.current = h;
            /* 视口高度变化同样是钉底窗口的触发源。协同模式下 sheet 的高度是动画量（进场、
               换档、键盘），而内容高度一动不动 —— 只听 onContentSizeChange 的话，开窗后这
               一整段收不到任何信号。挂在这里就不必去猜动画什么时候停。
               只认窗口、不消费 once：一次性 latch 说的是「下次内容**变高**时滚」，让一次纯
               视口变化（发完消息键盘收起之类）提前吃掉，真正的新消息反而会落在屏幕外。 */
            if (isInOpenWindow(bottomPin, Date.now())) {
              atBottomRef.current = true;
              scrollRef.current?.scrollToEnd({ animated: false });
              return;
            }
            /* 视口变矮（协同模式收 sheet 档位、键盘弹起）时 maxOffset 跟着变大，原本贴底的
               视图会被留在半空 —— 「刚还在底部，收个档就掉进历史中间」。贴底态下补一次。
               收档动画期间这里每帧都会 fire，等于全程钉着底收下去，不会跳。 */
            if (prev > 0 && h < prev && atBottomRef.current) {
              scrollRef.current?.scrollToEnd({ animated: false });
            }
          }}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: headerHeight + 20, paddingBottom: scrollBottomPadding },
            /* 宽屏：消息列限宽放大到桌面级（仍居中、两侧留白），覆盖 styles.scrollContent 的窄列 380。 */
            wideChat && { maxWidth: READING_MAX_WIDTH },
          ]}
          /* 点击触发：touchStart capture，绕过消息子组件（TouchableOpacity / RNGH）
           * 抢 responder 导致 ScrollView 自身 onTouchStart 不 fire 的情形。
           * 滚动触发：iOS 用 keyboardDismissMode='on-drag'（native interactive），
           * Android 用 JS onScrollBeginDrag。
           *
           * [已知边缘 bug] iOS 上滚动 dismiss 时消息区会抖（持续到键盘动画结束）；
           * 点击 dismiss 不抖。怀疑根因是 lib KAV behavior='padding' 在 dismiss 期间
           * 缩 ScrollView frame，触底状态下 contentOffset 被强制修正引发跳动。
           * 排除过：
           *   - JS 侧重复调 Keyboard.dismiss()（去掉只留 native blur — 不改善）
           *   - on-drag 跟 onScrollBeginDrag 显式 blur 并发（iOS 改 onScrollEndDrag — 不改善）
           *   - UIScrollView 自动 keyboard contentInset（关 automaticallyAdjustKeyboardInsets
           *     + contentInsetAdjustmentBehavior='never' — 不改善）
           * 未来方向：把 KAV 的 padding 模式换成 ScrollView contentInset.bottom 动态跟键盘，
           * 或者 bottomOverlay 改用 transform translateY 直接跟 kbAnimHeight 走、彻底不让
           * KAV 缩 ScrollView frame。当前评估边缘 bug、性价比不高，先搁置。 */
          /* 用户一碰列表就放弃钉底：正往上翻的时候，图片量完高度不能把人拽回底部。 */
          onTouchStartCapture={() => {
            releaseBottomPin(bottomPin);
            onDismissComposer();
          }}
          onScrollBeginDrag={() => {
            releaseBottomPin(bottomPin);
            if (Platform.OS === 'android') onDismissComposer();
          }}
          keyboardDismissMode="on-drag"
          onContentSizeChange={(_w, h) => {
            scrollContentHeightRef.current = h;
            /* 加载更旧的锚定已交给 maintainVisibleContentPosition（原生帧级维持），这里只管触底滚动。 */
            const intent = consumeScrollIntent(bottomPin, Date.now());
            if (intent) {
              /* 主动贴底了就直接把 atBottom 记上，不等 onScroll 回声：内容没撑满视口时
                 根本不会有滚动事件，光靠 onScroll 维护的话这种会话永远是 false，
                 后台跑出新消息回前台就不会跟到底了。 */
              atBottomRef.current = true;
              scrollRef.current?.scrollToEnd({ animated: intent.animated });
              /* Android：onContentSizeChange 经常在内容真正布局完前先 fire 一次（中间高度），
                 单次 scrollToEnd 只滚到那个中间位置。再补两次延迟滚动盖住后续布局抖动。
                 （iOS 那侧靠打开对话时武装的钉底窗口兜——图片/附件量完高度会再来一次
                 onContentSizeChange，窗口内照样贴底。） */
              if (Platform.OS === 'android') {
                requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
                setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 200);
              }
            }
          }}
          /* 滚到顶附近(<160)且还有更旧 → 触发分页加载。同时记录 offset 供 prepend 锚定。 */
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            scrollOffsetYRef.current = y;
            /* 记「此刻贴没贴底」：回前台补消息时靠它决定要不要跟到底。用事件自带的
               contentSize/layoutMeasurement 而不是那两个 ref —— 同一帧里它们才是配套的，
               混用可能拿到上一帧的内容高度算出假的 near-bottom。阈值 80 与 Web 的 100px 同量级。 */
            const ne = e.nativeEvent;
            const contentH = ne.contentSize?.height ?? scrollContentHeightRef.current;
            const viewportH = ne.layoutMeasurement?.height ?? scrollViewportHeightRef.current;
            atBottomRef.current = contentH - y - viewportH < 80;
            // 离开顶部 → 重新武装（下次滚到顶才再触发，避免一次滚动在顶部附近连环触发多批）
            if (y > 300) nearTopTriggeredRef.current = false;
            /* hasOlder / loadingOlder 是 props：两者的来源（messageWindowMeta、loadingOlder）
               都是 ChatScreen 的 state，state 一变父子一起重渲染，这里的闭包与原来读 ref
               取到的是同一时刻的值。父那边 loadOlderMessages 入口另有 ref 级重入保护。 */
            /* 「打开对话」窗口还开着 = 初始定位还没落定（协同模式尤其明显：sheet 进场动画
               期间视口高度一路在变），此刻的 y 不代表用户真的在看顶部。不挡的话，挂载瞬间
               offset=0 的那一下就会自动拉一批更旧的回来 —— 顶部转菊花、prepend 再经
               maintainVisibleContentPosition 一锚，视图就钉死在那批旧内容里了。
               用户真去翻历史时 onTouchStartCapture 会先 release 掉窗口，不受影响。 */
            if (
              y <= 160 &&
              !nearTopTriggeredRef.current &&
              hasOlder &&
              !loadingOlder &&
              !loading &&
              !isInOpenWindow(bottomPin, Date.now())
            ) {
              nearTopTriggeredRef.current = true;
              onReachTop();
            }
          }}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          /* 加载更旧消息时，原生维持当前可见消息的位置（帧级、绘制前调好 offset）→ 顶部插入更早内容
           * 时可见内容稳在原位、不抖不跳。要求消息是本 ScrollView 内容的直接子节点（已去掉 chatContentWrap）。
           * minIndexForVisible:1 以首个可见消息的下一条为锚，避开最顶一条在边缘时的抖动。 */
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        >
          <ConversationAttachmentsContext.Provider value={conversationAttachmentsMap}>
            <FlowDocItemMetaProvider
              conversationId={conversationId}
              serverBaseUrl={session.server_base_url}
              accessToken={session.access_token}
            >
              {showEmpty ? (
                <View style={styles.emptyStage}>
                  <Text style={styles.welcomeTitle}>Hi, {session.user_id}</Text>
                  <Text style={styles.welcomeSubtitle}>输入第一句话开始对话。</Text>
                </View>
              ) : (
                <>
                  {renderedMessages}
                  {contextCompressPlacement?.kind === 'afterLastVisible' && messages.length > 0 ? (
                    <ContextCompressDividerRow
                      activeSummary={contextCompressPlacement.activeSummary}
                      rawMessages={serverRawMessages}
                      anchorRef={contextCompressAnchorRef}
                    />
                  ) : null}
                  {/* 与 Web Chat.jsx no-assistant-reply-hint：最后一条是 user 且无流式中时，提示未回复并允许重新生成 */}
                  {!conversationHistoryLoading &&
                  messages.length > 0 &&
                  !loading &&
                  !bgPauseRecovering &&
                  (() => {
                    const lastMsg = messages[messages.length - 1];
                    if (lastMsg.role !== 'user') return null;
                    const noReplyAfterUserIndex =
                      messages.filter((m) => m.role === 'user').length - 1;
                    if (noReplyAfterUserIndex < 0) return null;
                    const regenDisabled =
                      !conversationId || loading || conversationHistoryLoading;
                    return (
                      <View
                        key="no-assistant-reply-hint"
                        style={[styles.bubbleWrap, styles.assistantBubbleWrap]}
                      >
                        <View style={[styles.bubble, styles.assistantBubble]}>
                          <Text style={styles.bubbleRole}>{composerAgentLabel}</Text>
                          <View style={styles.assistantTextBlock}>
                            <MarkdownContent
                              text="Flops未回复任何内容"
                              showRegenerateButton
                              contentWrapperStyle={styles.assistantEmptyReplyMarkdownContent}
                              onRegenerate={() => onRegenerate(noReplyAfterUserIndex)}
                              regenerateDisabled={regenDisabled}
                            />
                          </View>
                        </View>
                      </View>
                    );
                  })()}
                </>
              )}
              {/* bgPauseRecovering 也要显示：切后台把流 abort 掉之后，loading 已经落回 false，
                  而回前台要先后跑 getConversationMeta + getConversation 两个来回才轮到
                  resumeV2Stream 把 loading 重新置 true。这中间几百毫秒如果只看 loading，
                  这条还留着内容的流式气泡会整个消失 —— 界面看起来「这轮已经结束了」（露出
                  上一条助手消息的复制按钮行 / 未回复提示），紧接着又冒出来继续长，
                  中间还因为内容忽短忽长跳一次滚动位置。三个现象是同一个原因。
                  bgPauseRecovering 由 AppState 那个 handler 的 .finally 兜底清除，不会漏。 */}
              {(loading || bgPauseRecovering) && !conversationHistoryLoading ? (
                <View style={[styles.bubbleWrap, styles.assistantBubbleWrap]}>
                  <View style={[styles.bubble, styles.assistantBubble]}>
                    {!streamIsResumeContinuation ? (
                      <Text style={styles.bubbleRole}>
                        {composerAgentLabel} ({streamStatusBracketLabel})
                      </Text>
                    ) : null}
                    {currentAssistantBlocks.length > 0 ? (
                      currentAssistantBlocks.map((block, bi) => {
                        const prevBlock = currentAssistantBlocks[bi - 1];
                        const nextBlock = currentAssistantBlocks[bi + 1];
                        const compactAbove = prevBlock != null && isToolPackageNavBlock(prevBlock);
                        const tightAfterThinking = prevBlock != null && isClosedThinkingBlock(prevBlock);
                        if (block.type === 'thinking') {
                          return (
                            <ThinkingBlockView
                              block={block}
                              key={`stream-think-${bi}`}
                              prevIsToolPackage={prevBlock != null && isToolPackageNavBlock(prevBlock)}
                              nextIsToolPackage={nextBlock != null && isToolPackageNavBlock(nextBlock)}
                            />
                          );
                        }
                        if (block.type === 'task_event') {
                          return (
                            <TaskEventCardView
                              key={`stream-taskevent-${bi}`}
                              taskEvent={block.task_event}
                              content={block.content}
                              variant="injection"
                              onOpenSubagentView={onOpenSubagentView}
                              onOpenConversation={onOpenConversation}
                            />
                          );
                        }
                        if (block.type === 'user_injection') {
                          return <UserInjectionInline key={`stream-userinj-${bi}`} content={block.content} />;
                        }
                        return block.type === 'text' ? (
                          <View
                            key={bi}
                            style={[
                              styles.assistantTextBlock,
                              compactAbove && styles.assistantTextBlockCompactAbove,
                              tightAfterThinking && styles.assistantTextBlockTightAfterThinking,
                            ]}
                          >
                            <MarkdownContent text={block.content} />
                          </View>
                        ) : (
                          <React.Fragment key={`stream-tool-${bi}`}>
                            {renderToolBlock(block, `stream-tool-${bi}`)}
                          </React.Fragment>
                        );
                      })
                    ) : null}
                    {currentAssistantBlocks.length === 0 ? (
                      <View style={styles.assistantTextBlock}>
                        <MarkdownContent text={streamingText || streamBubblePlaceholderText} />
                      </View>
                    ) : null}
                    {liveInjections.length > 0
                      ? liveInjections.map((inj) => (
                          <UserInjectionInline key={`live-inj-${inj.id}`} content={inj.text} />
                        ))
                      : null}
                  </View>
                </View>
              ) : null}
            </FlowDocItemMetaProvider>
          </ConversationAttachmentsContext.Provider>
          {reloadPending ? (
            <View style={styles.reloadPendingBanner}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.reloadPendingText}>服务器热更新中，稍后将继续…</Text>
            </View>
          ) : null}
          {footerNode}
        </ScrollView>
        <HistoryLoadingOverlay
          visible={conversationHistoryLoading}
          bottomOverflow={historyOverlayBottomOverflow}
          topOffset={headerHeight}
          overlayStyle={styles.historyLoadingOverlay}
          spinnerColor={colors.textSecondary}
        />
        {/* 加载更旧消息的顶部转圈：绝对定位 overlay（不占内容高度，不影响 prepend 锚定）。 */}
        {loadingOlder ? (
          <View
            style={{
              position: 'absolute',
              top: headerHeight + 8,
              left: 0,
              right: 0,
              alignItems: 'center',
              zIndex: 20,
            }}
            pointerEvents="none"
          >
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : null}
      </>
    );
  }
);
