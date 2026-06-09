import React from 'react';
import { Text, View } from 'react-native';

type AnyBlock = {
  type: string;
  tool_name?: string;
  status?: string;
  arguments?: string;
  result?: unknown;
};

type Props = {
  block: AnyBlock;
  cardKey: string;
  agentLabel: string;
  styles: Record<string, any>;
};

function parseArgs(raw?: string): Record<string, unknown> {
  if (raw == null || raw === '') return {};
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** subagent_find_sessions / subagent_get_session 的简洁摘要卡：标题 + 参数 + 结果计数。 */
export function SubagentMetaCard({ block, cardKey, agentLabel, styles }: Props) {
  const args = parseArgs(block.arguments);
  const res = block.result && typeof block.result === 'object' ? (block.result as Record<string, unknown>) : null;
  const isFind = block.tool_name === 'subagent_find_sessions';
  const title = isFind ? '查找会话' : '查看会话';

  const parts: string[] = [];
  const kw = String((args.keyword ?? '') as string).trim();
  const sid = String((args.session_id ?? '') as string).trim();
  const mode = String((args.mode ?? '') as string).trim();
  if (sid) parts.push(`会话 ${sid.slice(0, 8)}`);
  if (mode) parts.push(`mode=${mode}`);
  if (kw) parts.push(`grep "${kw}"`);
  const cwd = String((args.cwd ?? '') as string).trim();
  if (cwd) parts.push(`cwd=${cwd}`);

  const resultParts: string[] = [];
  if (res) {
    const sessions = Array.isArray((res as any).sessions) ? (res as any).sessions.length : null;
    if (sessions != null) resultParts.push(`${sessions} 个会话`);
    const cnt = (res as any).count;
    if (typeof cnt === 'number' && sessions == null) resultParts.push(`${cnt} 个`);
    const matched = (res as any).matched;
    if (typeof matched === 'number') resultParts.push(`命中 ${matched}`);
    const returned = (res as any).returned;
    if (typeof returned === 'number') resultParts.push(`返回 ${returned}`);
    const total = (res as any).total_blocks;
    if (typeof total === 'number') resultParts.push(`共 ${total} 块`);
    if (typeof (res as any).error === 'string' && (res as any).error) resultParts.push('失败');
  }

  const detail = parts.join(' · ');
  const summary = resultParts.join(' · ');

  return (
    <View key={cardKey} style={styles.subMetaCard}>
      <View style={styles.subMetaHead}>
        <Text style={styles.subMetaTitle}>{title}</Text>
        <Text style={styles.subMetaAgent}>{agentLabel}</Text>
        <View style={{ flex: 1 }} />
        {summary ? <Text style={styles.subMetaSummary}>{summary}</Text> : null}
      </View>
      {detail ? (
        <Text style={styles.subMetaDetail} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}
