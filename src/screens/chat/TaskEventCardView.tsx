/**
 * 执行端异步事件卡片（RN）：后台命令完成 / 浏览器下载 …
 *
 * **标题、失败判定、展开字段三者都按 ev.kind 走**，不再假定"事件 = 后台命令退出"。
 * 与 Web / Desktop 的 TaskEventCard.jsx 是同一份逻辑的 RN 实现，改一处要三处同步。
 * - variant='trigger'（agent 空闲被唤醒、自成一轮）：对齐用户消息——右对齐、深色气泡（userBubble）、
 *   顶部时间、底部小操作（复制 / 重新处理）。
 * - variant='injection'（工作期间穿插）：灰色全宽 inline 条。
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Clipboard from '@react-native-clipboard/clipboard';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { TaskEventPayload } from '../../utils/chatLocalMessages';

/** subagent_kind → 人读标签（与 Web/Desktop TaskEventCard 同款）。 */
const SUBAGENT_KIND_LABEL: Record<string, string> = {
  flops: 'Flops 对话',
  claude: 'Claude Code',
  cursor: 'Cursor',
};

function formatRuntime(sec?: number): string | null {
  const n = typeof sec === 'number' ? sec : Number(sec);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 60) return `${Math.round(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return s ? `${m}m${s}s` : `${m}m`;
}

/** 字节数 → 紧凑文案（与 Web/Desktop 版 formatTaskBytes 同款换算）。 */
function formatBytes(n?: number): string | null {
  const b = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(b) || b <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
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
  onOpenSubagentView,
  onOpenConversation,
}: {
  taskEvent: TaskEventPayload | null;
  content?: string;
  onReprocess?: () => void;
  reprocessDisabled?: boolean;
  variant?: 'trigger' | 'injection';
  /** 子 agent 完成通知的「查看对话」入口：打开子会话内容弹窗（同 spawn 卡机制）。 */
  onOpenSubagentView?: (args: {
    sessionId: string;
    title?: string;
    agentType?: 'flops' | 'claude' | 'cursor';
    deviceId?: string;
    cwd?: string;
  }) => void;
  /** 「打开原对话」（仅 flops）：导航到该子对话作为独立会话。 */
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { colors } = useAppTheme();
  const styles = createStyles(colors);
  const [open, setOpen] = useState(false);

  const ev: TaskEventPayload = taskEvent || {};
  const status = String(ev.status || 'exited').trim();
  const exitCode = ev.exit_code;
  /** 事件种类。空 = 后台命令（历史唯一种类，旧执行端也不带这个字段）。 */
  const kind = String(ev.kind || '').trim();
  const isDownload = kind === 'browser_download';
  /** 子 agent 一轮跑完（异步档 track=notify）。三种执行体共用一张卡，靠 subagent_kind 分标签。 */
  const isSubagentDone = kind === 'subagent_done';
  const phase = String(ev.phase || '').trim();
  // 子 agent 完成字段（flops=云端对话，claude/cursor=执行端 CLI）
  const saKind = String(ev.subagent_kind || '').trim().toLowerCase();
  const saLabel = SUBAGENT_KIND_LABEL[saKind] || '子 agent';
  const saSession = String(ev.session_id || ev.child_conversation_id || '').trim();

  /** **只有明确的失败信号才算失败**，其余（含进行中、未知）一律中性。
   *
   *  从前是「不是 completed / exited 就算失败」——那是照"进程已退出"写的判据。浏览器下载的
   *  started 阶段 status=running，于是整条被染成 danger 红，用户看到"一个失败一个成功"。
   *  反过来写之后，将来再加事件种类也不会被误伤。 */
  const failed =
    ['interrupted', 'cancelled', 'canceled', 'failed', 'error'].includes(status.toLowerCase()) ||
    (typeof exitCode === 'number' && exitCode !== 0) ||
    // CLI 型子 agent 完成事件带 agent_ok（false = 没跑成，含被超时/打断掐掉）
    (isSubagentDone && ev.agent_ok === false);

  const dlFilename = typeof ev.download_filename === 'string' ? ev.download_filename.trim() : '';
  const dlSavePath = typeof ev.download_save_path === 'string' ? ev.download_save_path.trim() : '';
  const dlUrl = typeof ev.download_url === 'string' ? ev.download_url.trim() : '';
  const dlTotal = formatBytes(ev.download_total_bytes);
  const dlReceived = formatBytes(ev.download_received_bytes);

  // 标题不再写死。下载事件分三态，其余保持原文案。
  const title = isDownload
    ? phase === 'started'
      ? '浏览器下载已开始'
      : failed
        ? '浏览器下载未完成'
        : '浏览器下载完成'
    : isSubagentDone
      ? `子 agent ${failed ? '未完成' : '完成'} · ${saLabel}`
      : '后台任务完成';

  // 中间那行「desc」槽位：后台命令显示 description，下载显示文件名——那是这类事件里
  // 最该一眼看到的东西。
  const desc = isDownload
    ? dlFilename
    : isSubagentDone
      ? String(ev.title || ev.prompt_preview || ev.description || '').trim()
      : typeof ev.description === 'string'
        ? ev.description.trim()
        : '';
  const runtime = formatRuntime(ev.runtime_seconds);
  const tail = typeof ev.log_tail === 'string' ? ev.log_tail.trim() : '';
  // 右侧摘要：下载看字节数（exit_code / runtime 对它没有意义），其余保持原样。
  const summary = isDownload
    ? phase === 'started'
      ? dlTotal || '正在下载'
      : dlReceived && dlTotal
        ? `${dlReceived} / ${dlTotal}`
        : dlReceived || dlTotal || status
    : isSubagentDone
      ? [saSession ? `会话 ${saSession.slice(0, 8)}` : '', runtime].filter(Boolean).join(' · ')
      : [exitCode != null ? `${status} (exit_code=${exitCode})` : status, runtime]
          .filter(Boolean)
          .join(' · ');
  const logVal = ev.log_path
    ? `${ev.log_path}${typeof ev.log_size_bytes === 'number' ? ` (${ev.log_size_bytes} bytes)` : ''}`
    : '';
  const trigger = variant === 'trigger';
  const fg = trigger ? colors.onUserBubble : colors.textBody;
  const fgMuted = trigger ? colors.onUserBubble : colors.textMuted;

  // showCaret=false：有按钮时箭头移出 head、放到按钮右边（保证箭头永远最右）。
  const renderHead = (showCaret = true) => (
    <TouchableOpacity onPress={() => setOpen((v) => !v)} activeOpacity={0.6} style={styles.head}>
      <View style={[styles.dot, { backgroundColor: failed ? colors.danger : colors.success }]} />
      <Text style={[styles.title, { color: fg }]}>{title}</Text>
      {desc ? (
        <Text style={[styles.desc, { color: fgMuted }]} numberOfLines={1}>
          {desc}
        </Text>
      ) : (
        <View style={styles.descSpacer} />
      )}
      <Text style={[styles.status, { color: failed ? colors.danger : fgMuted }]}>{summary}</Text>
      {showCaret ? (
        <Text style={[styles.caret, { color: fgMuted }]}>{open ? '▲' : '▼'}</Text>
      ) : null}
    </TouchableOpacity>
  );

  const renderBody = () =>
    open ? (
      <View style={[styles.body, trigger && styles.bodyOnBubble]}>
        {/* 展开区按事件种类换字段组：exec 的 command/cwd/log 对下载毫无意义，而下载真正要给人看的
            是「文件叫什么、多大、存到哪、从哪来」——尤其**保存路径**，那是点开这张卡的首要目的。 */}
        {(isDownload
          ? ([
              ['文件', dlFilename],
              [
                phase === 'started' ? '大小' : '已接收',
                phase === 'started'
                  ? dlTotal
                  : dlReceived && dlTotal
                    ? `${dlReceived} / ${dlTotal}`
                    : dlReceived || dlTotal,
              ],
              [phase === 'started' ? '将保存到' : '保存在', dlSavePath],
              ['来源', dlUrl],
              ['device_id', ev.device_id],
              ['ended_at', ev.ended_at],
            ] as Array<[string, unknown]>)
          : ([
              ['task_id', ev.task_id],
              ['command', ev.command],
              ['cwd', ev.cwd],
              ['log', logVal],
              ['device_id', ev.device_id],
              ['ended_at', ev.ended_at],
            ] as Array<[string, unknown]>)
        ).map(([k, v]) =>
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
          {isDownload
            ? failed
              ? '下载没有正常结束。可以重新触发一次，或改用命令行下载。'
              : '文件已经在执行端本机，可直接用 local_read_file 处理它。'
            : '完整输出用 local_read_file 读 log 路径（支持 offset/limit 分页）。'}
        </Text>
      </View>
    ) : null;

  // 子 agent 完成通知也能「查看对话」：完成事件带 session_id + agent_type，够打开同一个弹窗
  // （flops 加密 child 的结论不随事件明文带出，点开弹窗由父对话解密补足查看体验）。
  const canOpenView =
    isSubagentDone && !!saSession && !!SUBAGENT_KIND_LABEL[saKind] && typeof onOpenSubagentView === 'function';
  const viewBtn = canOpenView ? (
    <TouchableOpacity
      onPress={() =>
        onOpenSubagentView!({
          sessionId: saSession,
          title: saLabel,
          // canOpenView 已保证 saKind ∈ SUBAGENT_KIND_LABEL（flops/claude/cursor）
          agentType: saKind as 'flops' | 'claude' | 'cursor',
          deviceId: String(ev.device_id || ''),
          cwd: String(ev.agent_cwd || ev.cwd || ''),
        })
      }
      activeOpacity={0.6}
      accessibilityLabel="查看对话"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={{ paddingHorizontal: 10, justifyContent: 'center' }}
    >
      <Ionicons name="expand-outline" size={16} color={fgMuted} />
    </TouchableOpacity>
  ) : null;
  // 「打开原对话」：仅 flops（claude/cursor 会话不是 Flops 对话，无处可跳）+ 有 session_id。
  const canOpenConv =
    isSubagentDone && !!saSession && saKind === 'flops' && typeof onOpenConversation === 'function';
  const openBtn = canOpenConv ? (
    <TouchableOpacity
      onPress={() => onOpenConversation!(saSession)}
      activeOpacity={0.6}
      accessibilityLabel="打开原对话"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={{ paddingHorizontal: 8, justifyContent: 'center' }}
    >
      <Ionicons name="open-outline" size={16} color={fgMuted} />
    </TouchableOpacity>
  ) : null;
  // 有入口按钮时：head(标题…摘要,占满余宽) + 打开原对话 + 查看对话 + 箭头（箭头永远最右）；否则头部原样。
  const headWithView =
    viewBtn || openBtn ? (
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, minWidth: 0 }}>{renderHead(false)}</View>
        {openBtn}
        {viewBtn}
        <TouchableOpacity
          onPress={() => setOpen((v) => !v)}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          style={{ paddingHorizontal: 2 }}
        >
          <Text style={[styles.caret, { color: fgMuted }]}>{open ? '▲' : '▼'}</Text>
        </TouchableOpacity>
      </View>
    ) : (
      renderHead()
    );

  if (trigger) {
    const timeStr = formatClock(ev.ended_at);
    const copyText =
      typeof content === 'string' && content.trim()
        ? content
        : `${title} ${desc} ${summary}`.trim();
    return (
      <View style={styles.triggerWrap}>
        {timeStr ? <Text style={styles.triggerTime}>{timeStr}</Text> : null}
        <View style={[styles.triggerBubble, { backgroundColor: colors.userBubble }]}>
          {headWithView}
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
      <View style={[styles.headWrap, failed && styles.headFailed]}>{headWithView}</View>
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
        /* 高度统一到「穿插后台信号」卡（task_event head：paddingVertical 7 / horizontal 12） */
        paddingVertical: 7,
        paddingHorizontal: 12,
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
