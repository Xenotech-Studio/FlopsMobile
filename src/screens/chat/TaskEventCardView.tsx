/**
 * 后台任务完成事件卡片（RN）。
 * - variant='trigger'（agent 空闲被唤醒、自成一轮）：对齐用户消息——右对齐、深色气泡（userBubble）、
 *   顶部时间、底部小操作（复制 / 重新处理）。
 * - variant='injection'（工作期间穿插）：灰色全宽 inline 条。
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { TaskEventPayload } from '../../utils/chatLocalMessages';

function formatRuntime(sec?: number): string | null {
  const n = typeof sec === 'number' ? sec : Number(sec);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 60) return `${Math.round(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return s ? `${m}m${s}s` : `${m}m`;
}

function formatClock(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function TaskEventCardViewImpl({
  taskEvent,
  content,
  onReprocess,
  reprocessDisabled,
  variant = 'injection',
}: {
  taskEvent: TaskEventPayload | null;
  content?: string;
  onReprocess?: () => void;
  reprocessDisabled?: boolean;
  variant?: 'trigger' | 'injection';
}) {
  const { colors } = useAppTheme();
  const styles = createStyles(colors);
  const [open, setOpen] = useState(false);

  const ev = taskEvent || {};
  const status = String(ev.status || 'exited').trim();
  const exitCode = ev.exit_code;
  const failed =
    (status !== 'completed' && status !== 'exited') ||
    (typeof exitCode === 'number' && exitCode !== 0);
  const desc = typeof ev.description === 'string' ? ev.description.trim() : '';
  const runtime = formatRuntime(ev.runtime_seconds);
  const tail = typeof ev.log_tail === 'string' ? ev.log_tail.trim() : '';
  const summary = [exitCode != null ? `${status} (exit_code=${exitCode})` : status, runtime]
    .filter(Boolean)
    .join(' · ');
  const logVal = ev.log_path
    ? `${ev.log_path}${typeof ev.log_size_bytes === 'number' ? ` (${ev.log_size_bytes} bytes)` : ''}`
    : '';
  const trigger = variant === 'trigger';
  const fg = trigger ? colors.onUserBubble : colors.textBody;
  const fgMuted = trigger ? colors.onUserBubble : colors.textMuted;

  const renderHead = () => (
    <TouchableOpacity onPress={() => setOpen((v) => !v)} activeOpacity={0.6} style={styles.head}>
      <View style={[styles.dot, { backgroundColor: failed ? colors.danger : colors.success }]} />
      <Text style={[styles.title, { color: fg }]}>后台任务完成</Text>
      {desc ? (
        <Text style={[styles.desc, { color: fgMuted }]} numberOfLines={1}>
          {desc}
        </Text>
      ) : (
        <View style={styles.descSpacer} />
      )}
      <Text style={[styles.status, { color: failed ? colors.danger : fgMuted }]}>{summary}</Text>
      <Text style={[styles.caret, { color: fgMuted }]}>{open ? '▲' : '▼'}</Text>
    </TouchableOpacity>
  );

  const renderBody = () =>
    open ? (
      <View style={[styles.body, trigger && styles.bodyOnBubble]}>
        {[
          ['task_id', ev.task_id],
          ['command', ev.command],
          ['cwd', ev.cwd],
          ['log', logVal],
          ['device_id', ev.device_id],
          ['ended_at', ev.ended_at],
        ].map(([k, v]) =>
          v == null || v === '' ? null : (
            <View style={styles.field} key={String(k)}>
              <Text style={[styles.fieldKey, { color: fgMuted }]}>{k}</Text>
              <Text style={[styles.fieldVal, { color: fg }]} selectable>
                {String(v)}
              </Text>
            </View>
          ),
        )}
        {tail ? (
          <View style={styles.tailWrap}>
            <Text style={[styles.fieldKey, { color: fgMuted }]}>
              输出片段（log 尾部）{ev.log_tail_truncated ? ' · 已截断' : ''}
            </Text>
            <ScrollView style={[styles.tail, trigger && styles.tailOnBubble]} nestedScrollEnabled>
              <Text style={[styles.tailText, { color: fg }]} selectable>
                {tail}
              </Text>
            </ScrollView>
          </View>
        ) : null}
        <Text style={[styles.hint, { color: fgMuted }]}>
          完整输出用 local_read_file 读 log 路径（支持 offset/limit 分页）。
        </Text>
      </View>
    ) : null;

  if (trigger) {
    const timeStr = formatClock(ev.ended_at);
    const copyText =
      typeof content === 'string' && content.trim()
        ? content
        : `后台任务完成 ${desc} ${summary}`.trim();
    return (
      <View style={styles.triggerWrap}>
        {timeStr ? <Text style={styles.triggerTime}>{timeStr}</Text> : null}
        <View style={[styles.triggerBubble, { backgroundColor: colors.userBubble }]}>
          {renderHead()}
          {renderBody()}
        </View>
        <View style={styles.triggerToolbar}>
          <TouchableOpacity onPress={() => Clipboard.setString(copyText)} style={styles.toolbarBtn}>
            <Text style={styles.toolbarBtnText}>复制</Text>
          </TouchableOpacity>
          {onReprocess ? (
            <TouchableOpacity
              onPress={onReprocess}
              disabled={!!reprocessDisabled}
              style={[styles.toolbarBtn, reprocessDisabled && styles.toolbarBtnDisabled]}
            >
              <Text style={styles.toolbarBtnText}>重新处理</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  // 穿插：灰色全宽 inline
  return (
    <View style={styles.row}>
      <View style={[styles.headWrap, failed && styles.headFailed]}>{renderHead()}</View>
      {renderBody()}
    </View>
  );
}

export const TaskEventCardView = React.memo(TaskEventCardViewImpl);

/** P2 用户「立刻穿插」：assistant 工作块内的内联用户消息条（区别于独立 user 气泡） */
function UserInjectionInlineImpl({ content }: { content?: string }) {
  const { colors } = useAppTheme();
  const text = typeof content === 'string' ? content : '';
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 8,
        alignItems: 'center',
        marginVertical: 2,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.borderMuted,
        backgroundColor: colors.surfaceMuted,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: '600',
          color: colors.onUserBubble,
          backgroundColor: colors.userBubble,
          borderRadius: 4,
          paddingHorizontal: 6,
          paddingVertical: 1,
          overflow: 'hidden',
        }}
      >
        穿插
      </Text>
      <Text style={{ flex: 1, fontSize: 13, color: colors.textBody }} selectable>
        {text}
      </Text>
    </View>
  );
}
export const UserInjectionInline = React.memo(UserInjectionInlineImpl);

function createStyles(c: AppColors) {
  return StyleSheet.create({
    row: { width: '100%', marginVertical: 2 },
    // 穿插 head 外框（灰条）
    headWrap: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.borderMuted,
      backgroundColor: c.surfaceMuted,
    },
    headFailed: {},
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 7,
      paddingHorizontal: 12,
    },
    dot: { width: 6, height: 6, borderRadius: 3 },
    title: { fontSize: 13, fontWeight: '600' },
    desc: { flex: 1, fontSize: 13 },
    descSpacer: { flex: 1 },
    status: { fontSize: 13 },
    caret: { fontSize: 9, marginLeft: 2 },
    body: {
      width: '100%',
      marginTop: 4,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.borderMuted,
      backgroundColor: c.surface,
      gap: 5,
    },
    bodyOnBubble: {
      marginTop: 8,
      borderWidth: 0,
      backgroundColor: 'rgba(255,255,255,0.08)',
    },
    field: { flexDirection: 'row', gap: 8 },
    fieldKey: { minWidth: 76, fontSize: 12 },
    fieldVal: { flex: 1, fontSize: 12 },
    tailWrap: { gap: 4 },
    tail: { maxHeight: 200, padding: 8, borderRadius: 6, backgroundColor: c.surfaceMuted },
    tailOnBubble: { backgroundColor: 'rgba(0,0,0,0.35)' },
    tailText: { fontSize: 12, fontFamily: 'Menlo' },
    hint: { fontSize: 12, marginTop: 2 },
    // 触发：右对齐用户消息式
    triggerWrap: { width: '100%', alignItems: 'flex-end', marginVertical: 2 },
    triggerTime: { fontSize: 11, color: c.textMuted, marginBottom: 3 },
    triggerBubble: { maxWidth: '82%', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
    triggerToolbar: { flexDirection: 'row', gap: 14, marginTop: 4, paddingRight: 2 },
    toolbarBtn: { paddingVertical: 2 },
    toolbarBtnDisabled: { opacity: 0.5 },
    toolbarBtnText: { fontSize: 12, color: c.textMuted },
  });
}
