import React, { useRef } from 'react';
import { Text, View, ScrollView } from 'react-native';
import { getLocalExecEnvDisplay, parseExecCommandArgs } from '../../utils/toolCardParsers';
import { normalizeTerminalOutput } from '../../utils/terminalOutputNormalize';
import { ToolCardFrame } from './ToolCardFrame';
import { toolCardPropsEqual } from './toolCardMemo';

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  result?: unknown;
  streaming_content?: string;
  review_id?: string;
};

type Props = {
  block: ToolBlock;
  cardKey: string;
  viewMode: 'collapsed' | 'preview' | 'full';
  styles: Record<string, object>;
  getToolStatusLabel: (status: string) => string;
  setToolCardMode: (key: string, mode: 'collapsed' | 'preview' | 'full') => void;
  renderToolCardSafetyActions: (reviewId: string, isSubmitting: boolean) => React.ReactNode;
  renderAnsiText: (text: string, maxLen: number) => React.ReactNode;
  formatSec: (sec: number) => string;
  elapsedSec: number;
  completedSec?: number;
  isSubmitting: boolean;
  /** 半折叠预览区内 ScrollView，供 ChatScreen 在输出增长时 scrollToEnd（与 Web flops-chat-ui 一致） */
  onExecPreviewScrollRef?: (el: ScrollView | null) => void;
};

function ExecCommandCardImpl({
  block,
  cardKey,
  viewMode,
  styles,
  getToolStatusLabel,
  setToolCardMode,
  renderToolCardSafetyActions,
  renderAnsiText,
  formatSec,
  elapsedSec,
  completedSec,
  isSubmitting,
  onExecPreviewScrollRef,
}: Props) {
  const previewScrollRef = useRef<ScrollView | null>(null);
  const execArgs = parseExecCommandArgs(block);
  const envDisplay = getLocalExecEnvDisplay(block);
  const resultObj = block.result && typeof block.result === 'object' ? (block.result as Record<string, unknown>) : null;
  const rto = resultObj?.executor_timeout_seconds;
  const hasExecutorTimeout = typeof rto === 'number' && Number.isFinite(rto) && rto > 0;
  const timeoutPart = hasExecutorTimeout ? formatSec(Math.floor(rto)) : '--';
  const rel = resultObj?.executor_elapsed_seconds;
  const executorElapsedSec =
    typeof rel === 'number' && Number.isFinite(rel) && rel >= 0 ? Math.floor(rel) : null;
  const stdoutRaw = resultObj && typeof resultObj.stdout === 'string' ? resultObj.stdout : '';
  const stderrRaw = resultObj && typeof resultObj.stderr === 'string' ? resultObj.stderr : '';
  const exitCode = resultObj && typeof resultObj.exit_code === 'number' ? resultObj.exit_code : null;
  const isRunning = block.status === 'running' || block.status === 'pending';

  const elapsedSecForDisplay =
    block.status === 'completed'
      ? executorElapsedSec != null
        ? executorElapsedSec
        : completedSec
      : isRunning
        ? executorElapsedSec != null
          ? executorElapsedSec
          : elapsedSec
        : null;

  const streamingFallback = typeof block.streaming_content === 'string' ? block.streaming_content : '';
  const stdoutNorm = normalizeTerminalOutput(stdoutRaw || streamingFallback, { keepSgr: true });
  const stderrNorm = normalizeTerminalOutput(stderrRaw, { keepSgr: true });

  const headerLabel = execArgs.description || '终端命令';
  const programTail = execArgs.programName ? ` (${execArgs.programName})` : '';

  const execTimeRatioStr =
    (isRunning || block.status === 'completed') && elapsedSecForDisplay != null
      ? `${formatSec(elapsedSecForDisplay)}/${timeoutPart}`
      : null;

  /** 与 FlopsWeb ExecCommandCard.jsx 折叠尾行一致：去 SGR、取最后一行、约 200 字 + 耗时 */
  const collapsedTail = (() => {
    const timeSuffix = execTimeRatioStr != null ? ` (${execTimeRatioStr})` : '';
    const stripped = stdoutNorm.replace(/\x1b\[[0-9;]*[a-zA-Z]?/g, '');
    const lines = stripped.split(/\r\n|\n|\r/);
    let lastLine = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t) {
        lastLine = t;
        break;
      }
    }
    const maxLen = 200;
    const minVisible = 6;
    if (!lastLine) {
      if (timeSuffix) return timeSuffix;
      return null;
    }
    const content = lastLine.length > maxLen - 1 ? lastLine.slice(-(maxLen - 1)) : lastLine;
    const visible = '\u2026' + content + timeSuffix;
    return visible.length >= minVisible ? visible : null;
  })();

  const isFull = viewMode === 'full';
  const isPreview = viewMode === 'preview';
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  // 安全审核退回重想（withdraw_and_rethink）：展示具体建议(reason + next_actions)而非 error 套话。
  // 数据在 result，老/新记录结构一致，同覆盖历史记录。
  const isWithdrawRethink = Boolean(
    resultObj && (resultObj as Record<string, unknown>).withdraw_and_rethink === true,
  );
  const withdrawRethinkMsg = (() => {
    if (!isWithdrawRethink || !resultObj) return null;
    const sr = (resultObj as Record<string, unknown>).safety_review;
    const srObj = sr && typeof sr === 'object' && !Array.isArray(sr) ? (sr as Record<string, unknown>) : null;
    const reason = srObj ? String(srObj.reason ?? '').trim() : '';
    const suggestion =
      String((resultObj as Record<string, unknown>).next_actions ?? '').trim() ||
      (srObj ? String(srObj.rethink_suggestion ?? '').trim() : '');
    const txt = [reason, suggestion].filter(Boolean).join(' ');
    return txt
      ? `安全审核退回本次操作，建议改用更稳妥的做法：${txt}`
      : '安全审核退回了本次操作，建议调整后再继续。';
  })();
  const errorMsg = isWithdrawRethink
    ? null
    : resultObj && typeof resultObj.error === 'string'
      ? resultObj.error
      : null;

  const maxOutLen = isFull ? 12000 : 3500;
  const hasAnyStreamOut = Boolean(stdoutNorm || stderrNorm || errorMsg);

  const streamOutputInner = (opts: { showGeneratingInPreview: boolean; showNoOutputWhenDone: boolean }) => (
    <>
      {withdrawRethinkMsg ? (
        <Text style={styles.toolCardSafetyMeta as object} numberOfLines={isFull ? 14 : 10}>
          {withdrawRethinkMsg}
        </Text>
      ) : null}
      {errorMsg ? (
        <Text style={styles.readPagesErrorText as object} numberOfLines={isFull ? 12 : 8}>
          {errorMsg}
        </Text>
      ) : null}
      {opts.showGeneratingInPreview && !hasAnyStreamOut && block.status !== 'completed' ? (
        <Text style={styles.toolCardSafetyMeta as object}>输出生成中...</Text>
      ) : null}
      {!opts.showGeneratingInPreview && isRunning && !hasAnyStreamOut ? (
        <Text style={styles.toolCardSafetyMeta as object}>输出生成中...</Text>
      ) : null}
      {stdoutNorm ? renderAnsiText(stdoutNorm, maxOutLen) : null}
      {opts.showNoOutputWhenDone &&
      !stdoutNorm &&
      !stderrNorm &&
      !errorMsg &&
      block.status === 'completed' ? (
        <Text style={styles.toolCardSafetyMeta as object}>无输出</Text>
      ) : null}
      {stderrNorm ? (
        <View style={{ marginTop: 8 }}>{renderAnsiText(stderrNorm, Math.floor(maxOutLen / 2))}</View>
      ) : null}
    </>
  );

  const bindPreviewScroll = (el: ScrollView | null) => {
    previewScrollRef.current = el;
    onExecPreviewScrollRef?.(el);
  };

  const scrollPreviewToEnd = () => {
    previewScrollRef.current?.scrollToEnd({ animated: false });
  };

  const exitFooterText =
    isRunning
      ? `执行中（${formatSec(elapsedSecForDisplay ?? elapsedSec)}/${timeoutPart}）`
      : block.status === 'completed'
        ? elapsedSecForDisplay != null
          ? `执行完成（${formatSec(elapsedSecForDisplay)}/${timeoutPart}）`
          : '执行完成'
        : null;

  const promptRow = (
    <Text
      style={styles.toolCardExecPrompt as object}
      numberOfLines={isFull ? undefined : 4}
      selectable={isFull}
    >
      <Text style={styles.toolCardExecPromptPrefix as object}>$ </Text>
      {execArgs.command || '(无命令)'}
      {execArgs.cwd ? (
        <Text style={styles.toolCardExecCwd as object}>{`  (cwd: ${execArgs.cwd})`}</Text>
      ) : null}
    </Text>
  );

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles}
      status={block.status}
      collapsedName={
        envDisplay.badge
          ? `${headerLabel}${programTail} · ${envDisplay.badge}`
          : `${headerLabel}${programTail}`
      }
      collapsedTail={collapsedTail}
      collapsedSuccessStyle={exitCode === 0 ? 'success' : 'none'}
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
      <View style={{ marginBottom: 8 }}>
        <Text style={styles.toolCardHeader as object}>
          {headerLabel}
          {programTail}
          {' · '}
          {getToolStatusLabel(block.status)}
        </Text>
        {envDisplay.badge ? (
          <Text
            style={styles.toolCardExecEnvBadge as object}
            numberOfLines={2}
            accessibilityHint={envDisplay.detail}
          >
            {envDisplay.badge}
          </Text>
        ) : null}
      </View>

      {isFull ? (
        <>
          {promptRow}
          {streamOutputInner({ showGeneratingInPreview: false, showNoOutputWhenDone: true })}
          {block.status === 'completed' && exitCode != null ? (
            <Text style={styles.toolCardSafetyMeta as object} numberOfLines={1}>
              exit_code: {exitCode}
            </Text>
          ) : null}
          {exitFooterText ? (
            <Text style={styles.toolCardExecExit as object} numberOfLines={2}>
              {exitFooterText}
            </Text>
          ) : null}
        </>
      ) : isPreview ? (
        <View style={styles.toolCardExecBody as object}>
          <ScrollView
            style={styles.execToolPreviewScroll as object}
            contentContainerStyle={styles.execToolPreviewScrollContent as object}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled"
            ref={bindPreviewScroll}
            onContentSizeChange={scrollPreviewToEnd}
            onLayout={scrollPreviewToEnd}
          >
            {promptRow}
            {streamOutputInner({ showGeneratingInPreview: true, showNoOutputWhenDone: false })}
          </ScrollView>
          {exitFooterText ? (
            <Text style={styles.toolCardExecExit as object} numberOfLines={2}>
              {exitFooterText}
            </Text>
          ) : null}
        </View>
      ) : null}

      {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const ExecCommandCard = React.memo(
  ExecCommandCardImpl,
  toolCardPropsEqual<Props>(['block', 'cardKey', 'viewMode', 'styles', 'isSubmitting', 'elapsedSec', 'completedSec'])
);
