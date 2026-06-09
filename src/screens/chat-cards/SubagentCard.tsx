import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { MarkdownContent } from '../../components/MarkdownContent';
import { ToolCardFrame } from './ToolCardFrame';

/** 子 agent 标识图标（与 Web 一致：lucide Boxes 叠箱图标）。 */
function SubagentIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
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

type AnyBlock = {
  type: string;
  tool_name?: string;
  status?: string;
  arguments?: string;
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
  iconColor: string;
  getToolStatusLabel: (status: string) => string;
  renderToolCardSafetyActions: (reviewId: string, isSubmitting: boolean) => React.ReactNode;
  isSubmitting: boolean;
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
    tail = (blk.arguments || '').slice(0, 80);
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

function AgentToolBlocks({
  blocks,
  cardKey,
  styles,
  getToolStatusLabel,
}: {
  blocks: AnyBlock[];
  cardKey: string;
  styles: Record<string, any>;
  getToolStatusLabel: (status: string) => string;
}) {
  return (
    <View style={styles.subBlocks}>
      {blocks.map((blk, i) => {
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

export function SubagentCard({
  block,
  cardKey,
  agentLabel,
  styles,
  iconColor,
  getToolStatusLabel,
  renderToolCardSafetyActions,
  isSubmitting,
}: Props) {
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);
  const args = parseArgs(block.arguments);
  const prompt = String((args.prompt ?? '') as string).trim();
  const cwd = String((args.cwd ?? '') as string).trim();
  const resumeSid = String((args.resume_session_id ?? args.session_id ?? '') as string).trim();
  const isResumed = Boolean(resumeSid) || block.tool_name === 'subagent_continue';

  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const res = asObj(block.result);

  if (isAwaiting) {
    const review = block.review as { reason?: string; advice?: string; decision?: string } | undefined;
    return (
      <View key={cardKey} style={styles.toolCard}>
        <Text style={styles.toolCardHeader}>{agentLabel} · 待确认</Text>
        {cwd ? <Text style={styles.toolCardSafetyMeta}>cwd: {cwd}</Text> : null}
        {review?.reason ? <Text style={styles.toolCardSafetyReason}>{review.reason}</Text> : null}
        {review?.advice ? (
          <Text
            style={[
              styles.toolCardSafetyAdvice,
              review.decision === 'need_confirm_after_warning' && styles.toolCardSafetyAdviceDanger,
            ]}
          >
            {review.advice}
          </Text>
        ) : null}
        {renderToolCardSafetyActions(block.review_id!, isSubmitting)}
      </View>
    );
  }

  const sid = isResumed ? resumeSid : String((res?.session_id as string) || '').trim();
  const sidShort = sid ? sid.slice(0, 8) : '';
  const verb = isResumed ? '继续会话' : '新建会话';
  const deviceName = String((res?.device_name as string) || (res?.device_id as string) || '').trim();

  const agentBlocks =
    res && Array.isArray((res as any).agent_blocks) && (res as any).agent_blocks.length
      ? ((res as any).agent_blocks as AnyBlock[])
      : null;
  const replyText =
    block.streaming_content ?? (res && typeof res.stdout === 'string' ? res.stdout : '') ?? '';
  const errorMsg = res && typeof res.error === 'string' ? res.error : null;
  const hasError = Boolean(errorMsg || (res && res.success === false));
  const isRunning = block.status === 'running';

  const statusLabel =
    block.status === 'completed'
      ? hasError
        ? '失败'
        : '成功'
      : block.status === 'running'
        ? '执行中'
        : block.status === 'waiting'
          ? '等待执行'
          : block.status === 'pending'
            ? '参数生成中'
            : String(block.status || '');

  // 工作时展开、结束后自动折叠；点 header 可手动覆盖（覆盖后固定，不再随状态自动变）
  const isWorking = ['running', 'pending', 'waiting'].includes(String(block.status || ''));
  const expanded = collapseOverride !== null ? collapseOverride : isWorking;

  return (
    <View key={cardKey} style={styles.subCard}>
      <TouchableOpacity
        style={styles.subHeader}
        onPress={() => setCollapseOverride(!expanded)}
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
        <View style={{ flex: 1 }} />
        {deviceName ? (
          <Text style={styles.subExecutor} numberOfLines={1}>
            {deviceName}
          </Text>
        ) : null}
        <Text style={[styles.subStatus, hasError && styles.subStatusErr]}>{statusLabel}</Text>
      </TouchableOpacity>

      {expanded ? (
        <>
          <View style={styles.subPrompt}>
            <Text style={styles.subPromptLabel}>提问</Text>
            <Text style={styles.subPromptText}>{prompt || '(无 prompt)'}</Text>
            {cwd ? <Text style={styles.subPromptMeta}>cwd: {cwd}</Text> : null}
          </View>

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
        </>
      ) : null}
    </View>
  );
}
