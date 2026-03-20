import React from 'react';
import { Text, View } from 'react-native';
import { parseExecCommandArgs } from '../../utils/toolCardParsers';
import { stripAnsi } from '../../utils/ansiToSegments';
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
}: Props) {
  const execArgs = parseExecCommandArgs(block);
  const resultObj = block.result && typeof block.result === 'object' ? (block.result as Record<string, unknown>) : null;
  const stdout = resultObj && typeof resultObj.stdout === 'string' ? resultObj.stdout : '';
  const exitCode = resultObj && typeof resultObj.exit_code === 'number' ? resultObj.exit_code : null;
  const isRunning = block.status === 'running' || block.status === 'pending';

  const headerLabel = execArgs.description || '终端命令';
  const programTail = execArgs.programName ? ` (${execArgs.programName})` : '';
  const lastLine = stripAnsi(stdout).trim().split(/\n/).filter(Boolean).pop() ?? '';
  const tailText = lastLine.length > 60 ? '…' + lastLine.slice(-60) : lastLine;
  const timeStr = completedSec != null ? ` (执行完成 ${formatSec(completedSec)})` : isRunning ? ` (${formatSec(elapsedSec)})` : '';
  const collapsedTail = (tailText ? tailText + timeStr : timeStr) || ' ';

  const isFull = viewMode === 'full';
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const stderr = resultObj && typeof resultObj.stderr === 'string' ? resultObj.stderr : '';
  const errorMsg = resultObj && typeof resultObj.error === 'string' ? resultObj.error : null;

  const streamingFallback = typeof block.streaming_content === 'string' ? block.streaming_content : '';
  const stdoutForDisplay = stdout || streamingFallback;
  const stderrForDisplay = stderr;
  const maxOutLen = isFull ? 12000 : 3500;
  const plainTail = stripAnsi(stdoutForDisplay).trim();
  const previewTail = plainTail.length ? (plainTail.length > 220 ? plainTail.slice(plainTail.length - 220) : plainTail) : '';

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
        <Text style={styles.toolCardHeader}>
          {headerLabel}
          {programTail}
          {' · '}
          {getToolStatusLabel(block.status)}
        </Text>

        {execArgs.command || execArgs.cwd ? (
          <Text style={styles.toolCardSafetyMeta} numberOfLines={2}>
            $ {execArgs.command || '(无命令)'}
            {execArgs.cwd ? `  (cwd: ${execArgs.cwd})` : ''}
          </Text>
        ) : null}

        {errorMsg ? (
          <Text style={styles.readPagesErrorText} numberOfLines={6}>
            {errorMsg}
          </Text>
        ) : null}

        {viewMode !== 'full' && !stdoutForDisplay && block.status !== 'completed' ? (
          <Text style={styles.toolCardSafetyMeta}>输出生成中...</Text>
        ) : null}

        {stdoutForDisplay ? (
          isFull ? (
            renderAnsiText(stdoutForDisplay, maxOutLen)
          ) : (
            previewTail ? (
              <Text style={[styles.toolCardBody, styles.toolCardCodeText]} numberOfLines={6} selectable>
                {previewTail}
              </Text>
            ) : (
              <Text style={styles.toolCardSafetyMeta}>无输出</Text>
            )
          )
        ) : null}

        {stderrForDisplay ? (
          isFull ? (
            <View style={{ marginTop: 8 }}>
              {renderAnsiText(stderrForDisplay, Math.floor(maxOutLen / 2))}
            </View>
          ) : null
        ) : null}

        {isFull && block.status === 'completed' && exitCode != null ? (
          <Text style={styles.toolCardSafetyMeta} numberOfLines={1}>
            exit_code: {exitCode}
          </Text>
        ) : null}

        {(isRunning && elapsedSec >= 0) || completedSec != null ? (
          <Text style={styles.toolCardSafetyMeta} numberOfLines={1}>
            {block.status === 'completed' ? `执行完成（${formatSec(completedSec ?? 0)}）` : `执行中（${formatSec(elapsedSec)}）`}
          </Text>
        ) : null}

        {block.streaming_content && viewMode !== 'full' && !stdout ? (
          <Text style={[styles.toolCardBody, styles.toolCardCodeText]} numberOfLines={5} selectable>
            {block.streaming_content.length > 1000 ? block.streaming_content.slice(0, 1000) + '\n...' : block.streaming_content}
          </Text>
        ) : null}

        {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}

