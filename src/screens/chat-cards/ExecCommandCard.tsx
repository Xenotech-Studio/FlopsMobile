import React, { useRef } from 'react';
import { Text, View, ScrollView } from 'react-native';
import { parseExecCommandArgs } from '../../utils/toolCardParsers';
import { normalizeTerminalOutput } from '../../utils/terminalOutputNormalize';
import { ToolCardFrame } from './ToolCardFrame';

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

export function ExecCommandCard({
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
  const errorMsg = resultObj && typeof resultObj.error === 'string' ? resultObj.error : null;

  const maxOutLen = isFull ? 12000 : 3500;
  const hasAnyStreamOut = Boolean(stdoutNorm || stderrNorm || errorMsg);

  const streamOutputInner = (opts: { showGeneratingInPreview: boolean; showNoOutputWhenDone: boolean }) => (
    <>
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
      collapsedName={`${headerLabel}${programTail}`}
      collapsedTail={collapsedTail}
      collapsedSuccessStyle={exitCode === 0 ? 'success' : 'none'}
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
      <Text style={styles.toolCardHeader as object}>
        {headerLabel}
        {programTail}
        {' · '}
        {getToolStatusLabel(block.status)}
      </Text>

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
