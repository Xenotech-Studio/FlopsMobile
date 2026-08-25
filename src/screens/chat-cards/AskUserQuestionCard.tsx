import React, { useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { toolCardPropsEqual } from './toolCardMemo';

type ToolBlock = {
  type: 'tool';
  status: string;
  arguments?: string;
  result?: unknown;
};

type AnswerItem = { header?: string; question?: string; answer: string };

type Props = {
  block: ToolBlock;
  cardKey: string;
  styles: Record<string, object>;
  placeholderColor: string;
  /** 提交用户选择；失败会抛出，卡片据此回滚 submitted */
  onSubmit: (answers: AnswerItem[]) => Promise<void>;
};

function parseQuestions(block: ToolBlock): any[] {
  let qs: any = null;
  try {
    const raw = block.arguments;
    const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
    if (Array.isArray(obj.questions)) qs = obj.questions;
  } catch {
    qs = null;
  }
  const res = block.result as { questions?: unknown } | null;
  if (!qs && res && Array.isArray(res.questions)) qs = res.questions;
  return Array.isArray(qs) ? qs : [];
}

function normOptions(q: any): { label: string; description: string }[] {
  const out: { label: string; description: string }[] = [];
  for (const o of q.options || []) {
    if (o && typeof o === 'object' && String(o.label || '').trim()) {
      out.push({ label: String(o.label).trim(), description: String(o.description || '').trim() });
    } else if (typeof o === 'string' && o.trim()) {
      out.push({ label: o.trim(), description: '' });
    }
  }
  return out;
}

function AskUserQuestionCardImpl({ block, cardKey, styles, placeholderColor, onSubmit }: Props) {
  const questions = parseQuestions(block);
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [current, setCurrent] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  const result = block.result as { status?: string; success?: boolean; answers?: AnswerItem[] } | null;
  const resolvedAnswers =
    result && result.status === 'answered' && Array.isArray(result.answers) ? result.answers : null;
  const resolvedFailed =
    result && result.success === false && ['timeout', 'cancelled', 'expired'].includes(String(result.status))
      ? String(result.status)
      : null;
  const isDone = submitted || !!resolvedAnswers || !!resolvedFailed;

  if (!questions.length) return null;
  const multiQ = questions.length > 1;

  const answerOf = (qi: number) => {
    const labels = [...(sel[qi] || [])];
    const oth = String(other[qi] || '').trim();
    if (oth) labels.push(oth);
    return labels.join('、');
  };
  const answeredTextResolved = (qi: number) =>
    resolvedAnswers && resolvedAnswers[qi] && typeof resolvedAnswers[qi].answer === 'string'
      ? resolvedAnswers[qi].answer
      : null;
  const isAnswered = (qi: number) => (resolvedAnswers ? true : answerOf(qi).trim().length > 0);
  const allAnswered = questions.every((_, qi) => isAnswered(qi));

  const buildAnswers = (overrideQi?: number, overrideLabel?: string): AnswerItem[] =>
    questions
      .map((q, qi) => ({
        header: q.header || '',
        question: q.question || '',
        answer: qi === overrideQi ? overrideLabel || '' : answerOf(qi),
      }))
      .filter((a) => a.answer && a.answer.trim());

  const doSubmit = (answers?: AnswerItem[]) => {
    const list = (answers || buildAnswers()).filter((a) => a.answer && a.answer.trim());
    if (!list.length) return;
    setSubmitted(true);
    Promise.resolve(onSubmit(list)).catch(() => setSubmitted(false));
  };

  const nextUnanswered = (from: number) => {
    for (let k = 1; k <= questions.length; k++) {
      const qi = (from + k) % questions.length;
      if (!isAnswered(qi)) return qi;
    }
    return -1;
  };

  const onOption = (qi: number, label: string, multi: boolean) => {
    if (isDone) return;
    if (multi) {
      setSel((prev) => {
        const cur = prev[qi] || [];
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      });
      return;
    }
    setSel((prev) => ({ ...prev, [qi]: [label] }));
    if (!multiQ) {
      doSubmit([{ header: questions[0].header || '', question: questions[0].question || '', answer: label }]);
      return;
    }
    const willAllAnswered = questions.every((_, j) => (j === qi ? true : isAnswered(j)));
    if (willAllAnswered) doSubmit(buildAnswers(qi, label));
    else {
      const nxt = nextUnanswered(qi);
      if (nxt >= 0) setCurrent(nxt);
    }
  };

  const headDone = resolvedFailed
    ? resolvedFailed === 'timeout'
      ? '已超时'
      : '已取消'
    : resolvedAnswers || submitted
      ? '已回应'
      : null;

  const cq = questions[current] || questions[0];
  const cqi = questions[current] ? current : 0;
  const opts = normOptions(cq);
  const multi = !!cq.multiSelect;
  const answeredText = answeredTextResolved(cqi);

  return (
    <View key={cardKey} style={styles.auqCard}>
      <View style={styles.auqHead}>
        <Text style={styles.auqHeadTitle}>请选择</Text>
        {headDone ? <Text style={styles.auqHeadDone}>{headDone}</Text> : null}
      </View>

      {multiQ ? (
        <View style={styles.auqTabs}>
          {questions.map((qq, i) => {
            const active = i === current;
            const done = isAnswered(i);
            return (
              <TouchableOpacity
                key={i}
                style={[styles.auqTab, active && styles.auqTabActive]}
                onPress={() => setCurrent(i)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.auqTabText,
                    done && styles.auqTabTextDone,
                    active && styles.auqTabTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {done ? '✓ ' : ''}
                  {qq.header || `问题 ${i + 1}`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      <View>
        <Text style={styles.auqQText}>
          {cq.question}
          {multi ? <Text style={styles.auqMultiTag}>　多选</Text> : null}
        </Text>
        <View>
          {opts.map((o, oi) => {
            const selected =
              answeredText != null ? answeredText.includes(o.label) : (sel[cqi] || []).includes(o.label);
            return (
              <TouchableOpacity
                key={oi}
                style={[styles.auqOption, selected && styles.auqOptionSelected]}
                onPress={() => onOption(cqi, o.label, multi)}
                disabled={isDone}
                activeOpacity={0.7}
              >
                <Text style={[styles.auqOptLabel, selected && styles.auqOptLabelSelected]}>{o.label}</Text>
                {o.description ? (
                  <Text style={styles.auqOptDesc} numberOfLines={1}>
                    {o.description}
                  </Text>
                ) : null}
                {selected ? <Text style={styles.auqOptCheck}>✓</Text> : null}
              </TouchableOpacity>
            );
          })}
        </View>
        {!isDone ? (
          <TextInput
            style={styles.auqOther}
            placeholder="其他（可自定义）…"
            placeholderTextColor={placeholderColor}
            value={other[cqi] || ''}
            onChangeText={(t) => setOther((prev) => ({ ...prev, [cqi]: t }))}
          />
        ) : null}
      </View>

      {resolvedFailed ? (
        <Text style={styles.auqNote}>
          {resolvedFailed === 'timeout' ? '未在规定时间内选择，已超时。' : '提问已取消或失效。'}
        </Text>
      ) : null}

      {!isDone && (multiQ || multi) ? (
        <View style={styles.auqActions}>
          <TouchableOpacity
            style={[styles.auqSubmit, !(allAnswered || isAnswered(cqi)) && styles.auqSubmitDisabled]}
            disabled={allAnswered ? false : !isAnswered(cqi)}
            onPress={() => {
              if (allAnswered) doSubmit();
              else {
                const nxt = nextUnanswered(cqi);
                if (nxt >= 0) setCurrent(nxt);
              }
            }}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.auqSubmitText,
                !(allAnswered || isAnswered(cqi)) && styles.auqSubmitTextDisabled,
              ]}
            >
              {allAnswered ? '提交' : '下一题'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

/* memo：只比值 prop，忽略 ChatScreen 每次 render 新建的函数 prop 标识（见 toolCardMemo.ts）。
   流式期间没变的卡直接短路，不再跟着整棵消息区全量 reconcile。 */
export const AskUserQuestionCard = React.memo(
  AskUserQuestionCardImpl,
  toolCardPropsEqual<Props>(['block', 'cardKey', 'styles', 'placeholderColor'])
);
