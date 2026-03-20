import React from 'react';
import { Text, View } from 'react-native';
import { MarkdownContent } from '../../components/MarkdownContent';

type ToolResult = { stdout?: string; error?: string; success?: boolean };

type ToolBlock = {
  type: 'tool';
  status: string;
  arguments?: string;
  streaming_content?: string;
  result?: ToolResult | unknown;
  review_id?: string;
  review?: Record<string, unknown>;
  cwd?: string;
};

type Props = {
  block: ToolBlock;
  cardKey: string;
  styles: Record<string, object>;
  renderToolCardSafetyActions: (reviewId: string, isSubmitting: boolean) => React.ReactNode;
  isSubmitting: boolean;
};

function parseCursorAgentArgs(block: ToolBlock): { prompt: string; cwd: string } {
  const raw = block.arguments;
  if (raw == null || raw === '') return { prompt: '', cwd: '' };
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      prompt: String((obj as Record<string, unknown>).prompt ?? '').trim(),
      cwd: String((obj as Record<string, unknown>).cwd ?? '').trim(),
    };
  } catch {
    return { prompt: String(raw).slice(0, 500), cwd: '' };
  }
}

export function CursorAgentCard({
  block,
  cardKey,
  styles,
  renderToolCardSafetyActions,
  isSubmitting,
}: Props) {
  const { prompt, cwd } = parseCursorAgentArgs(block);
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);

  if (isAwaiting) {
    const review = block.review as { reason?: string; advice?: string; decision?: string } | undefined;
    return (
      <View key={cardKey} style={styles.toolCard}>
        <Text style={styles.toolCardHeader}>Cursor Agent · {block.status}</Text>
        {block.cwd ? <Text style={styles.toolCardSafetyMeta}>cwd: {block.cwd}</Text> : null}
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

  const result = block.result as ToolResult | undefined;
  const replyText =
    block.streaming_content ??
    (result && typeof result.stdout === 'string' ? result.stdout : '') ??
    '';
  const errorMsg = result && typeof result.error === 'string' ? result.error : null;
  const hasError = Boolean(errorMsg || (result && result.success === false));
  const isRunning = block.status === 'running';

  return (
    <View key={cardKey} style={styles.cursorAgentWrap}>
      <View style={styles.cursorAgentPromptCard}>
        <Text style={styles.cursorAgentPromptLabel}>提问</Text>
        <Text style={styles.cursorAgentPromptText}>{prompt || '(无 prompt)'}</Text>
        {cwd ? <Text style={styles.cursorAgentPromptMeta}>cwd: {cwd}</Text> : null}
      </View>
      <View style={styles.cursorAgentReply}>
        <Text style={styles.cursorAgentReplyLabel}>回答</Text>
        {hasError && errorMsg ? (
          <Text style={styles.cursorAgentReplyError}>{errorMsg}</Text>
        ) : replyText ? (
          <View style={styles.cursorAgentReplyBody}>
            <MarkdownContent text={replyText} showCopyButton />
          </View>
        ) : isRunning ? (
          <Text style={styles.cursorAgentReplyLoading}>Cursor 正在分析并输出…</Text>
        ) : (
          <Text style={styles.cursorAgentReplyEmpty}>暂无输出</Text>
        )}
      </View>
    </View>
  );
}

