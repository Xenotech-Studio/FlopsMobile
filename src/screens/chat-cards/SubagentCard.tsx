import React, { useState } from 'react';
import { Dimensions, LayoutAnimation, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import LinearGradient from 'react-native-linear-gradient';
import { MarkdownContent } from '../../components/MarkdownContent';
import { ToolCardFrame } from './ToolCardFrame';
import { toolCardPropsEqual } from './toolCardMemo';

/** 子 agent 标识图标（与 Web 一致：lucide Boxes 叠箱图标）。 */
function SubagentIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z" />
      <Path d="m7 16.5-4.74-2.85" />
      <Path d="m7 16.5 5-3" />
      <Path d="M7 16.5v5.17" />
      <Path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z" />
      <Path d="m17 16.5-5-3" />
      <Path d="m17 16.5 4.74-2.85" />
      <Path d="M17 16.5v5.17" />
      <Path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z" />
      <Path d="M12 8 7.26 5.15" />
      <Path d="m12 8 4.74-2.85" />
      <Path d="M12 13.5V8" />
    </Svg>
  );
}

/** 工作量行图标：lucide Hammer 锤子。 */
function HammerIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" />
      <Path d="m18 15 4-4" />
      <Path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
    </Svg>
  );
}

function withAlpha(hex: string, a: number): string {
  const h = String(hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  if ([r, g, b].some((x) => Number.isNaN(x))) return `rgba(255,255,255,${a})`;
  return `rgba(${r},${g},${b},${a})`;
}

type AuthRequest = {
  kind?: string;
  action?: string;
  request_id?: string;
  requester_conversation_id?: string;
  count?: number;
  target_ids?: string[];
  target_conversation_id?: string;
  reason?: string;
};

type AnyBlock = {
  type: string;
  tool_name?: string;
  status?: string;
  arguments?: string;
  auth_request?: AuthRequest;
  authorization_error?: string;
  streaming_content?: string;
  content?: string;
  result?: unknown;
  review_id?: string;
  review?: Record<string, unknown>;
  cwd?: string;
  index?: number;
};

type Props = {
  block: AnyBlock;
  cardKey: string;
  agentLabel: string;
  styles: Record<string, any>;
  colors: Record<string, any>;
  iconColor: string;
  getToolStatusLabel: (status: string) => string;
  renderToolCardSafetyActions: (reviewId: string, isSubmitting: boolean) => React.ReactNode;
  isSubmitting: boolean;
  renderToolCardAuthorizationActions?: (authReq: AuthRequest, isSubmitting: boolean, error?: string) => React.ReactNode;
  authSubmitting?: boolean;
  /** flops 型子agent：点「查看对话」时用子对话 id 打开 SubagentViewOverlay（由 ChatScreen 注入）。 */
  onOpenSubagentView?: (args: { sessionId: string; title?: string }) => void;
  /** 查看弹窗里以完全展开态复用本卡（宿主把子对话读取结果适配成 subagent block 传入）。 */
  defaultExpanded?: boolean;
};

function parseArgs(raw?: string): Record<string, unknown> {
  if (raw == null || raw === '') return {};
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    return {};
  }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 未注册专卡的工具（claude 原生 Read/Grep/Glob/LS…）折叠行的一句话摘要：按工具名取关键字段。
 *  收**已解析好**的 args —— 调用方（InnerToolStep）上面已经 parseArgs 过一次，别再 parse 一遍。 */
function summarizeToolArgs(toolName: string, o: Record<string, unknown>): string {
  if (!o || typeof o !== 'object') return '';
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  switch (toolName) {
    case 'Read':
      return s(o.file_path) || s(o.path);
    case 'Grep': {
      const pat = s(o.pattern);
      const where = s(o.path) || s(o.glob) || s(o.include);
      return where ? `${pat ? `"${pat}" ` : ''}于 ${where}` : pat ? `"${pat}"` : '';
    }
    case 'Glob':
      return s(o.pattern) + (s(o.path) ? ` 于 ${s(o.path)}` : '');
    case 'LS':
      return s(o.path);
    case 'WebFetch':
      return s(o.url);
    case 'WebSearch':
      return s(o.query);
    case 'Task':
      return s(o.description) || s(o.subagent_type);
    case 'NotebookEdit':
      return s(o.notebook_path);
    case 'TodoWrite':
      return Array.isArray(o.todos) ? `${o.todos.length} 项` : '';
    default: {
      const guess = s(o.file_path) || s(o.path) || s(o.pattern) || s(o.query) || s(o.url) || s(o.command) || s(o.description);
      if (guess) return guess;
      for (const k of Object.keys(o)) {
        const v = s(o[k]);
        if (v) return v;
      }
      return '';
    }
  }
}

/** 子 agent 内部一步工具的折叠卡（默认折叠成单行，点开看命令/输出/diff）。 */
function InnerToolStep({
  blk,
  k,
  styles,
  getToolStatusLabel,
}: {
  blk: AnyBlock;
  k: string;
  styles: Record<string, any>;
  getToolStatusLabel: (status: string) => string;
}) {
  const [mode, setMode] = useState<'collapsed' | 'preview' | 'full'>('collapsed');
  const name = String(blk.tool_name || 'tool');
  const args = parseArgs(blk.arguments);
  const res = asObj(blk.result);
  const stdout = res && typeof res.stdout === 'string' ? res.stdout : '';
  const status = blk.status || 'completed';

  let title = name;
  let tail = '';
  let body: React.ReactNode = null;
  const filePath = String((args.file_path ?? args.path ?? '') as string).trim();

  if (name === 'Bash' || name === 'shell' || name === 'local_exec_command') {
    const cmd = String((args.command ?? '') as string).trim();
    title = '终端';
    tail = cmd;
    body = (
      <View>
        {cmd ? <Text style={styles.subInnerMono}>{cmd}</Text> : null}
        {stdout ? <Text style={[styles.subInnerMono, styles.subInnerOut]}>{stdout.slice(-4000)}</Text> : null}
      </View>
    );
  } else if (name === 'Edit' || name === 'MultiEdit' || name === 'edit' || name === 'local_edit_file') {
    title = '编辑';
    tail = filePath;
    const oldS = String((args.old_string ?? '') as string);
    const newS = String((args.new_string ?? '') as string);
    body = (
      <View>
        {filePath ? <Text style={styles.subInnerPath}>{filePath}</Text> : null}
        {oldS ? <Text style={[styles.subInnerMono, styles.subInnerDel]}>- {oldS.slice(0, 2000)}</Text> : null}
        {newS ? <Text style={[styles.subInnerMono, styles.subInnerAdd]}>+ {newS.slice(0, 2000)}</Text> : null}
      </View>
    );
  } else if (name === 'Write' || name === 'write' || name === 'local_write_file') {
    title = '写入';
    tail = filePath;
    const content = String((args.content ?? '') as string);
    body = (
      <View>
        {filePath ? <Text style={styles.subInnerPath}>{filePath}</Text> : null}
        {content ? <Text style={styles.subInnerMono}>{content.slice(0, 3000)}</Text> : null}
      </View>
    );
  } else if (name === 'Read' || name === 'local_read_file') {
    title = '读取';
    tail = filePath;
    body = filePath ? <Text style={styles.subInnerPath}>{filePath}</Text> : null;
  } else if (name === 'AskUserQuestion') {
    const qs = Array.isArray(args.questions) ? (args.questions as any[]) : [];
    title = '提问';
    tail = qs.length ? String(qs[0]?.question || '') : '已转交主对话';
    body = (
      <View>
        {qs.map((q, i) => (
          <Text key={i} style={styles.subInnerPath}>
            {String(q?.question || '')}
          </Text>
        ))}
        <Text style={styles.subInnerHint}>已转交主对话，请在下方选项卡片中选择。</Text>
      </View>
    );
  } else {
    // 未注册专卡：动作名用原工具名首字母大写，细节(读哪个文件 / grep 什么…)进 tail
    title = name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
    tail = summarizeToolArgs(name, args);
    const resultText = blk.result != null ? (typeof blk.result === 'string' ? blk.result : JSON.stringify(blk.result, null, 2)) : '';
    body = resultText ? <Text style={styles.subInnerMono}>{resultText.slice(0, 3000)}</Text> : null;
  }

  return (
    <ToolCardFrame
      cardKey={k}
      viewMode={mode}
      styles={styles}
      status={status}
      collapsedName={title}
      collapsedTail={tail}
      collapsedSuccessStyle="ok"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={(_kk, m) => setMode(m)}
    >
      {body}
    </ToolCardFrame>
  );
}

/**
 * 跑动中最多渲染的**尾部**步数。子 agent 一跑起来这张卡就是 full 态（见下面的 isWorking），
 * 而执行端每 250ms 重发一次全量累积 agent_blocks —— 长任务攒到几百步时，每次刷新都要把
 * 全部 InnerToolStep 重建一遍，是 live 段卡顿的大头。跑动中只渲最后这些步、前面折成一行；
 * 跑完（completed）不设限，结果要能完整回看。
 */
const RUNNING_STEP_WINDOW = 20;

function AgentToolBlocks({
  blocks,
  cardKey,
  styles,
  getToolStatusLabel,
  collapseRunningTail,
}: {
  blocks: AnyBlock[];
  cardKey: string;
  styles: Record<string, any>;
  getToolStatusLabel: (status: string) => string;
  /** 是否启用「只渲尾部若干步」（= 子 agent 还在跑）。 */
  collapseRunningTail: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const hiddenCount =
    collapseRunningTail && !showAll ? Math.max(0, blocks.length - RUNNING_STEP_WINDOW) : 0;
  const shown = hiddenCount > 0 ? blocks.slice(hiddenCount) : blocks;
  return (
    <View style={styles.subBlocks}>
      {hiddenCount > 0 ? (
        <TouchableOpacity onPress={() => setShowAll(true)} activeOpacity={0.7}>
          <Text style={styles.subInnerHint}>已折叠前 {hiddenCount} 步 · 查看全部</Text>
        </TouchableOpacity>
      ) : null}
      {shown.map((blk, si) => {
        /* key 用**原始下标**（不是 shown 里的位置）：窗口随新步骤滑动、点开「查看全部」时，
           同一步的 key 不变 → InnerToolStep 的展开态不会被重挂丢掉。 */
        const i = hiddenCount + si;
        const k = `${cardKey}-ab-${i}`;
        if (blk && blk.type === 'tool') {
          return <InnerToolStep key={k} blk={blk} k={k} styles={styles} getToolStatusLabel={getToolStatusLabel} />;
        }
        if (blk && blk.type === 'thinking') {
          const t = typeof blk.content === 'string' ? blk.content : '';
          if (!t.trim()) return null;
          return (
            <Text key={k} style={styles.subThinking}>
              {t}
            </Text>
          );
        }
        const t = blk && typeof blk.content === 'string' ? blk.content : '';
        if (!t.trim()) return null;
        return (
          <View key={k} style={styles.subTextBlock}>
            <MarkdownContent text={t} showCopyButton={false} />
          </View>
        );
      })}
    </View>
  );
}

function fmtDur(s: number): string {
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

function SubagentCardImpl({
  block,
  cardKey,
  agentLabel,
  styles,
  colors,
  iconColor,
  getToolStatusLabel,
  renderToolCardSafetyActions,
  isSubmitting,
  renderToolCardAuthorizationActions,
  authSubmitting,
  onOpenSubagentView,
  defaultExpanded,
}: Props) {
  const [viewOverride, setViewOverride] = useState<'collapsed' | 'preview' | 'full' | null>(
    defaultExpanded ? 'full' : null,
  );
  const [promptH, setPromptH] = useState(0);
  const [previewH, setPreviewH] = useState(0);

  const args = parseArgs(block.arguments);
  const prompt = String((args.prompt ?? '') as string).trim();
  const cwd = String((args.cwd ?? '') as string).trim();
  const resumeSid = String((args.resume_session_id ?? args.session_id ?? '') as string).trim();
  const isResumed = Boolean(resumeSid) || block.tool_name === 'subagent_continue';

  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  // 工具授权（flops 型 subagent_continue 向无钥加密对话发消息 / subagent_get_session 读无钥对话）：
  // 挂起等用户放行，按钮内嵌本卡（复用 ChatScreen.renderToolCardAuthorizationActions）。
  const isAwaitingAuth =
    block.status === 'awaiting_authorization' && Boolean(block.auth_request && block.auth_request.request_id);
  const res = asObj(block.result);

  if (isAwaitingAuth && block.auth_request && renderToolCardAuthorizationActions) {
    return (
      <View key={cardKey} style={styles.toolCard}>
        <Text style={styles.toolCardHeader}>{agentLabel} · 待授权</Text>
        {renderToolCardAuthorizationActions(block.auth_request, Boolean(authSubmitting), block.authorization_error)}
      </View>
    );
  }

  if (isAwaiting) {
    const review = block.review as { reason?: string; advice?: string; decision?: string } | undefined;
    return (
      <View key={cardKey} style={styles.toolCard}>
        <Text style={styles.toolCardHeader}>{agentLabel} · 待确认</Text>
        {cwd ? <Text style={styles.toolCardSafetyMeta}>cwd: {cwd}</Text> : null}
        {review?.reason ? <Text style={styles.toolCardSafetyReason}>{review.reason}</Text> : null}
        {review?.advice ? (
          <Text style={[styles.toolCardSafetyAdvice, review.decision === 'need_confirm_after_warning' && styles.toolCardSafetyAdviceDanger]}>
            {review.advice}
          </Text>
        ) : null}
        {renderToolCardSafetyActions(block.review_id!, isSubmitting)}
      </View>
    );
  }

  const sid = isResumed ? resumeSid : String((res?.session_id as string) || '').trim();
  const sidShort = sid ? sid.slice(0, 8) : '';

  // flops 型子agent（agent_type 缺省即 flops；claude/cursor 有专属 tool_name / agent_type）→ 可查看其子对话。
  const agentType = String((args.agent_type ?? '') as string).trim().toLowerCase();
  const isFlopsAgent =
    block.tool_name !== 'local_claude_agent' &&
    block.tool_name !== 'local_cursor_agent' &&
    agentType !== 'claude' &&
    agentType !== 'cursor';
  const childSessionId = String(
    (res?.session_id as string) || (res?.child_conversation_id as string) || sid || ''
  ).trim();
  const canViewChild = Boolean(isFlopsAgent && childSessionId && onOpenSubagentView);
  const verb = isResumed ? '继续会话' : '新建会话';
  const deviceName = String((res?.device_name as string) || (res?.device_id as string) || '').trim();

  const agentBlocks =
    res && Array.isArray((res as any).agent_blocks) && (res as any).agent_blocks.length
      ? ((res as any).agent_blocks as AnyBlock[])
      : null;
  const replyText = block.streaming_content ?? (res && typeof res.stdout === 'string' ? res.stdout : '') ?? '';
  const errorMsg = res && typeof res.error === 'string' ? res.error : null;
  const hasError = Boolean(errorMsg || (res && res.success === false));
  const isRunning = block.status === 'running';

  // 半展开预览：最后一条纯文本（无工具）消息
  let lastText = '';
  if (agentBlocks) {
    for (const b of agentBlocks) {
      if (b && b.type === 'text' && typeof b.content === 'string' && b.content.trim()) lastText = b.content;
    }
  }
  if (!lastText && replyText) lastText = replyText;
  const previewText = String((hasError && errorMsg ? errorMsg : lastText) || '').trim();

  const stepCount = agentBlocks ? agentBlocks.filter((b) => b && b.type === 'tool').length : 0;
  const durationSec = res && typeof (res as any).duration_seconds === 'number' ? ((res as any).duration_seconds as number) : null;
  const showSteps = block.status === 'completed' && (stepCount > 0 || durationSec != null);

  const statusLabel =
    block.status === 'completed'
      ? hasError ? '失败' : '成功'
      : block.status === 'running' ? '执行中'
        : block.status === 'waiting' ? '等待执行'
          : block.status === 'pending' ? '参数生成中'
            : String(block.status || '');

  // 三态：工作时 full、结束后自动 preview；点 header 折成单行（collapsed）
  const isWorking = ['running', 'pending', 'waiting'].includes(String(block.status || ''));
  const view = viewOverride !== null ? viewOverride : isWorking ? 'full' : 'preview';
  const setView = (v: 'collapsed' | 'preview' | 'full') => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    setViewOverride(v);
  };

  const winH = Dimensions.get('window').height;
  const promptMax = Math.round(winH * 0.1);
  const previewMax = Math.round(winH * 0.2);
  const promptClamped = view !== 'full';
  const promptClipped = promptClamped && promptH > promptMax + 2;
  const previewClipped = previewH > previewMax + 2;

  return (
    <View key={cardKey} style={styles.subCard}>
      <TouchableOpacity
        style={styles.subHeader}
        onPress={() => setView(view === 'collapsed' ? 'preview' : 'collapsed')}
        activeOpacity={0.6}
      >
        <View style={styles.subIcon}>
          <SubagentIcon size={14} color={iconColor} />
        </View>
        <Text style={styles.subAgentLabel} numberOfLines={1}>
          {agentLabel}
        </Text>
        <Text style={styles.subSessionBadge} numberOfLines={1}>
          {sidShort ? `${verb}:${sidShort}` : verb}
        </Text>
        {(() => {
          const m = String(((res as any)?.model as string) || '').trim();
          if (!m) return null;
          const short = m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
          return (
            <Text style={styles.subModelBadge} numberOfLines={1}>
              {short}
            </Text>
          );
        })()}
        <View style={{ flex: 1 }} />
        {deviceName ? (
          <Text style={styles.subExecutor} numberOfLines={1}>
            {deviceName}
          </Text>
        ) : null}
        <Text style={[styles.subStatus, hasError && styles.subStatusErr]}>{statusLabel}</Text>
      </TouchableOpacity>

      {view !== 'collapsed' ? (
        <>
          {/* 提问：非完全展开时限高 + 底部渐变 */}
          <View style={styles.subPromptZone}>
            <View style={[styles.subPrompt, promptClamped ? { maxHeight: promptMax, overflow: 'hidden' } : null]}>
              <View onLayout={(e) => setPromptH(e.nativeEvent.layout.height)}>
                <Text style={styles.subPromptLabel}>提问</Text>
                <Text style={styles.subPromptText}>{prompt || '(无 prompt)'}</Text>
                {cwd ? <Text style={styles.subPromptMeta}>cwd: {cwd}</Text> : null}
              </View>
              {promptClipped ? (
                <LinearGradient
                  colors={[withAlpha(colors.surface, 0), colors.surface]}
                  style={styles.subFade}
                  pointerEvents="none"
                />
              ) : null}
            </View>
          </View>

          {/* 步骤数·耗时行（锤子图标 + 右侧展开完整） */}
          {showSteps ? (
            <TouchableOpacity
              style={styles.subSteps}
              onPress={() => setView(view === 'full' ? 'preview' : 'full')}
              activeOpacity={0.7}
            >
              <View style={styles.subStepsIcon}>
                <HammerIcon size={13} color={colors.textMuted} />
              </View>
              <Text style={styles.subStepsName}>{agentLabel} 工作</Text>
              <Text style={styles.subStepsTail} numberOfLines={1}>
                {stepCount > 0 ? `${stepCount} 步` : ''}
                {stepCount > 0 && durationSec != null ? ' · ' : ''}
                {durationSec != null ? `耗时 ${fmtDur(durationSec)}` : ''}
              </Text>
              <Text style={styles.subStepsAction}>{view === 'full' ? '收起 ›' : '展开完整 ›'}</Text>
            </TouchableOpacity>
          ) : null}

          {/* 回答：完全展开=完整；半展开=最后回复 markdown 限高+渐变 */}
          {view === 'full' ? (
            <View style={styles.subReply}>
              <Text style={styles.subReplyLabel}>回答</Text>
              {hasError && errorMsg ? (
                <Text style={styles.cursorAgentReplyError}>{errorMsg}</Text>
              ) : agentBlocks ? (
                <AgentToolBlocks
                  blocks={agentBlocks}
                  cardKey={cardKey}
                  styles={styles}
                  getToolStatusLabel={getToolStatusLabel}
                  collapseRunningTail={isWorking}
                />
              ) : replyText ? (
                <View style={styles.cursorAgentReplyBody}>
                  <MarkdownContent text={replyText} showCopyButton />
                </View>
              ) : isRunning ? (
                <Text style={styles.cursorAgentReplyLoading}>{agentLabel} 正在分析并输出…</Text>
              ) : (
                <Text style={styles.cursorAgentReplyEmpty}>暂无输出</Text>
              )}
            </View>
          ) : previewText ? (
            <View style={styles.subPreviewZone}>
              <View style={[styles.subPreview, { maxHeight: previewMax }]}>
                <View onLayout={(e) => setPreviewH(e.nativeEvent.layout.height)}>
                  <MarkdownContent text={previewText} showCopyButton={false} />
                </View>
                {previewClipped ? (
                  <LinearGradient
                    colors={[withAlpha(colors.chatScreenBackground, 0), colors.chatScreenBackground]}
                    style={styles.subFade}
                    pointerEvents="none"
                  />
                ) : null}
              </View>
            </View>
          ) : null}

          {/* flops 子agent：查看其子对话内容（打开 SubagentViewOverlay） */}
          {canViewChild ? (
            <TouchableOpacity
              style={styles.subSteps}
              onPress={() => onOpenSubagentView?.({ sessionId: childSessionId, title: agentLabel })}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }} />
              <Text style={styles.subStepsAction}>查看对话 ›</Text>
            </TouchableOpacity>
          ) : null}

          {/* 底部展开/收起 bar */}
          <TouchableOpacity
            style={styles.subBar}
            onPress={() => setView(view === 'full' ? 'preview' : 'full')}
            activeOpacity={0.7}
          >
            <Text style={styles.subBarChevron}>{view === 'full' ? '▴' : '▾'}</Text>
          </TouchableOpacity>
        </>
      ) : null}
    </View>
  );
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const SubagentCard = React.memo(
  SubagentCardImpl,
  toolCardPropsEqual<Props>(['block', 'cardKey', 'agentLabel', 'styles', 'colors', 'iconColor', 'isSubmitting', 'authSubmitting'])
);
