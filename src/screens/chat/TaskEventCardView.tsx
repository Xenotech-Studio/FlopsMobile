/**
 * 执行端异步事件卡片（RN）：后台命令完成 / 浏览器下载 …
 *
 * **标题、失败判定、展开字段三者都按 ev.kind 走**，不再假定"事件 = 后台命令退出"。
 * 与 Web / Desktop 的 TaskEventCard.jsx 是同一份逻辑的 RN 实现，改一处要三处同步。
 * - variant='trigger'（agent 空闲被唤醒、自成一轮）：对齐用户消息——右对齐、深色气泡（userBubble）、
 *   顶部时间、底部小操作（复制 / 重新处理）。
 * - variant='injection'（工作期间穿插）：灰色全宽 inline 条。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Clipboard from '@react-native-clipboard/clipboard';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { parseWechatSender, type TaskEventPayload } from '../../utils/chatLocalMessages';

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
  // 箭头展开/收起 180° 旋转过渡（有按钮的卡才用外置箭头按钮，见 headWithView）。
  const caretSpin = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(caretSpin, {
      toValue: open ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [open, caretSpin]);
  const caretRotate = caretSpin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  const ev: TaskEventPayload = taskEvent || {};
  const status = String(ev.status || 'exited').trim();
  const exitCode = ev.exit_code;
  /** 事件种类。空 = 后台命令（历史唯一种类，旧执行端也不带这个字段）。 */
  const kind = String(ev.kind || '').trim();
  const isDownload = kind === 'browser_download';
  /** 子 agent 一轮跑完（异步档 track=notify）。三种执行体共用一张卡，靠 subagent_kind 分标签。 */
  const isSubagentDone = kind === 'subagent_done';
  const phase = String(ev.phase || '').trim();
  /** 资源节点微信监听：来了新消息触发唤醒。不是"任务完成"，直接把消息内容显示出来。 */
  const isWechat = kind === 'wechat_message';
  const wxSession = String(ev.session_name || '').trim();
  // sender 原始串混了 [N] 序号前缀 + [You were mentioned] 标记 → 清洗成纯名字（被@徽章已下线，仅取名字）。
  const { name: wxSender } = parseWechatSender(ev.sender);
  const wxText = String(ev.text || '').trim();
  const wxPreview = String(ev.preview || '').trim();
  const wxBodyState = String(ev.body_state || '').trim();
  const wxObservedAt = String(ev.observed_at || '').trim();
  const wxBody =
    wxBodyState === 'ready' && wxText
      ? wxText
      : wxPreview || (wxBodyState === 'deferred' ? '(正文暂缺，节点没抢到微信窗口)' : '');
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
    !isWechat &&
    (['interrupted', 'cancelled', 'canceled', 'failed', 'error'].includes(status.toLowerCase()) ||
      (typeof exitCode === 'number' && exitCode !== 0) ||
      // CLI 型子 agent 完成事件带 agent_ok（false = 没跑成，含被超时/打断掐掉）
      (isSubagentDone && ev.agent_ok === false));

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
    : isWechat
      ? wxSender || wxSession || '微信消息'
      : isSubagentDone
        ? `子 agent ${failed ? '未完成' : '完成'} · ${saLabel}`
        : '后台任务完成';

  // 中间那行「desc」槽位：后台命令显示 description，下载显示文件名——那是这类事件里
  // 最该一眼看到的东西。
  const desc = isDownload
    ? dlFilename
    : isWechat
      ? wxBody.replace(/\s+/g, ' ')
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
    : isWechat
      ? '' // 折叠头不显示群名/会话名（只在展开详情的字段组里给），保留发信人名+正文
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
    <TouchableOpacity
      onPress={() => setOpen((v) => !v)}
      activeOpacity={0.6}
      style={[styles.head, trigger && styles.headOnBubble]}
    >
      {isWechat ? (
        <Ionicons name="logo-wechat" size={15} color="#07C160" style={{ marginRight: 2 }} />
      ) : (
        <View style={[styles.dot, { backgroundColor: failed ? colors.danger : colors.success }]} />
      )}
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
          : isWechat
            ? ([
                ['会话', wxSession],
                ['发信人', wxSender],
                ['时间', wxObservedAt],
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
        {isWechat && (wxText || wxPreview) ? (
          <View style={styles.tailWrap}>
            <Text style={[styles.fieldKey, { color: fgMuted }]}>
              {wxBodyState === 'ready' && wxText ? '正文' : '会话摘要'}
            </Text>
            <Text style={[styles.tailText, { color: fg }]} selectable>
              {wxText || wxPreview}
            </Text>
          </View>
        ) : null}
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
            : isWechat
              ? '这条来自你挂的微信监听器。回复用 resource_node_wechat_send。'
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
      style={{ width: 24, height: 28, alignItems: 'center', justifyContent: 'center' }}
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
      style={{ width: 24, height: 28, alignItems: 'center', justifyContent: 'center' }}
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
        {/* 箭头独立按钮（与查看/打开同尺寸命中区）：chevron-down 展开旋转 180°，黑底气泡里走 fgMuted 白色。 */}
        <TouchableOpacity
          onPress={() => setOpen((v) => !v)}
          activeOpacity={0.6}
          accessibilityLabel={open ? '收起' : '展开'}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ width: 24, height: 28, alignItems: 'center', justifyContent: 'center' }}
        >
          <Animated.View style={{ transform: [{ rotate: caretRotate }] }}>
            <Ionicons name="chevron-down" size={16} color={fgMuted} />
          </Animated.View>
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
    /* 触发气泡里内边距由 triggerBubble 一家出，head 自己清零——对应 Desktop/Web 的
       `.task-event-head--trigger { padding: 0 }`。之前漏了这条，两层 padding 叠出
       上下 8+7=15、左右 12+12=24，左边看着明显比上下宽。
       minHeight 18：把行高钉死，别让它随字体自然行高（13pt 约 16）浮动——triggerBubble
       的 padding 是按 18 倒推出来的，见那边注释。只钉触发态，穿插灰条仍按文字自然高。 */
    headOnBubble: { paddingVertical: 0, paddingHorizontal: 0, minHeight: 18 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    /* title/status 不收缩、desc 吃余宽——与 Desktop .task-event-title / .task-event-desc 同模型。
       desc 必须写成 flexBasis:'auto'，**不能用 flex:1**（那是 basis:0）：触发卡的 triggerBubble
       只有 maxWidth 82%、没有定宽，宽度由内容撑出来，而 basis:0 的子项对内容宽度贡献 0 →
       整行余宽算成 0 → 正文被压成零宽，卡上就只剩发信人。穿插卡的 row 是 width:'100%' 有定宽，
       余宽分得到 desc，所以同一份代码在穿插位看着一切正常。 */
    title: { flexShrink: 0, fontSize: 13, fontWeight: '600' },
    desc: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', fontSize: 13 },
    descSpacer: { flex: 1 },
    status: { flexShrink: 0, fontSize: 13 },
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
    /* 四边同值，且**与用户消息气泡单行等高**——两种气泡在同一列右对齐并排出现，不等高很显眼。
       用户气泡（ChatScreen.styles.ts `bubble` + `userText`）：12 + 22(lineHeight) + 12 = 46。
       这里：14 + 18(headOnBubble.minHeight) + 14 = 46。左右 14 也正好等于用户气泡的
       paddingHorizontal，两边视觉宽度一致。改这两个数之一时另一个要跟着算。
       注：Desktop/Web 仍是 10px——那边气泡度量另算，不跟这个值。 */
    triggerBubble: { maxWidth: '82%', borderRadius: 10, padding: 14 },
    triggerToolbar: { flexDirection: 'row', gap: 14, marginTop: 4, paddingRight: 2 },
    toolbarBtn: { paddingVertical: 2 },
    toolbarBtnDisabled: { opacity: 0.5 },
    toolbarBtnText: { fontSize: 12, color: c.textMuted },
  });
}
