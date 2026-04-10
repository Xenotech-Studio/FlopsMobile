import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { parseGetDocTreeRootIdFromArgs } from '../../utils/toolCardParsers';
import { ToolCardFrame } from './ToolCardFrame';

type ToolBlock = {
  type: 'tool';
  tool_name: string;
  status: string;
  arguments?: string;
  result?: unknown;
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
  wrapFileToolPreviewBody: (
    isFull: boolean,
    isStreaming: boolean,
    cardKey: string,
    children: React.ReactNode
  ) => React.ReactNode;
  isSubmitting: boolean;
};

export function FlowDocGetTreeCard({
  block,
  cardKey,
  viewMode,
  styles,
  getToolStatusLabel,
  setToolCardMode,
  renderToolCardSafetyActions,
  wrapFileToolPreviewBody,
  isSubmitting,
}: Props) {
  const rootIdArg = parseGetDocTreeRootIdFromArgs(block);
  const scopeLabel = rootIdArg
    ? `子树 ${rootIdArg.length > 28 ? `${rootIdArg.slice(0, 28)}…` : rootIdArg}`
    : '完整树';
  const collapsedTail = scopeLabel.length > 40 ? `${scopeLabel.slice(0, 40)}…` : scopeLabel;
  const headerTitle = rootIdArg ? `子树 · ${rootIdArg}` : '完整文档树';

  const r = block.result && typeof block.result === 'object' ? (block.result as Record<string, unknown>) : null;
  const treeText = typeof r?.tree === 'string' ? r.tree : '';
  const meta = r?.meta && typeof r.meta === 'object' ? (r.meta as Record<string, unknown>) : null;
  const metaLine = meta
    ? `节点 ${meta.node_count ?? '—'} · 根 ${meta.root_count ?? '—'} · 完整 id`
    : '';
  const msg = typeof r?.message === 'string' && r.message.trim() ? r.message.trim() : '';
  const headerSummary = [msg, metaLine].filter(Boolean).join(' · ');

  const isFull = viewMode === 'full';
  const isAwaiting = block.status === 'awaiting_confirmation' && Boolean(block.review_id);
  const isStreaming = block.status === 'pending' || block.status === 'running';

  const [copied, setCopied] = useState(false);
  const handleCopyTree = useCallback(() => {
    if (!treeText) return;
    Clipboard.setString(treeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [treeText]);

  const capPreview = (s: string) => (s.length > 50000 ? `${s.slice(0, 50000)}\n…` : s);
  const treeShow = isFull ? (treeText.length > 8000 ? `${treeText.slice(0, 8000)}\n…` : treeText) : capPreview(treeText);

  const err = r?.success === false || r?.error;

  return (
    <ToolCardFrame
      cardKey={cardKey}
      viewMode={viewMode}
      styles={styles}
      status={block.status}
      collapsedName="文档树"
      collapsedTail={collapsedTail}
      collapsedSuccessStyle="success"
      getToolStatusLabel={getToolStatusLabel}
      setToolCardMode={setToolCardMode}
    >
      <View style={styles.toolCardHeaderRow}>
        <View style={styles.toolCardHeaderMain}>
          <Text style={styles.toolCardHeaderFilename} numberOfLines={2} ellipsizeMode="tail">
            文档树：{headerTitle}
            {headerSummary ? `\n${headerSummary}` : ''}
          </Text>
        </View>
        <View style={styles.toolCardBadgeWrap}>
          <Text style={[styles.toolCardBadge, block.status === 'completed' ? styles.toolCardBadgeSuccess : undefined]}>
            {getToolStatusLabel(block.status)}
          </Text>
        </View>
      </View>

      {err ? (
        <Text style={styles.toolCardBodyMuted}>{String(r?.error ?? '失败')}</Text>
      ) : isStreaming ? (
        <Text style={styles.toolCardBodyMuted}>执行中…</Text>
      ) : typeof r?.tree === 'string' ? (
        wrapFileToolPreviewBody(
          isFull,
          false,
          cardKey,
          <View>
            <TouchableOpacity
              onPress={handleCopyTree}
              accessibilityLabel={copied ? '已复制' : '复制文档树'}
              style={{ alignSelf: 'flex-end', padding: 4, marginBottom: 4 }}
            >
              <Ionicons name={copied ? 'checkmark-circle-outline' : 'copy-outline'} size={18} color="#64748b" />
            </TouchableOpacity>
            <Text style={styles.toolCardDiffPre} selectable>
              {treeShow}
            </Text>
          </View>
        )
      ) : null}

      {isAwaiting && block.review_id ? renderToolCardSafetyActions(block.review_id, isSubmitting) : null}
    </ToolCardFrame>
  );
}
