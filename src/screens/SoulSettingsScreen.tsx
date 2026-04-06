/**
 * 多 Agent 设置页：基本信息、SOUL / MEMORY / MEMORY_RECENT / 当日记忆。
 * 各标签内容为独立挂载的子组件，避免多行输入框在切换标签后高度错乱。
 * 保持路由名 SoulSettings，兼容现有入口。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
  PanResponder,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { useAppTheme } from '../context/ThemeContext';
import {
  getAgentIds,
  getAgentProfile,
  getAgentfFile,
  putAgentfFile,
  putAgentProfile,
  type AgentfFilePayload,
  type Session,
} from '../api';
import { resolveAgentDisplayLabel } from '../utils/agentDisplay';
import { shadowSheet } from '../theme/shadows';
import { TASK_FONT_SIZE_BODY } from '../theme/typography';
import { MonthCalendarScroll } from '../components/MonthCalendar';
import type { AppColors } from '../theme/appColors';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;
/** 与 FlopsWeb Settings.jsx AGENT_NAME_MAX 一致 */
const AGENT_NAME_MAX = 64;
/** 多行编辑区空内容时的最小高度；不限高，长文由外层 ScrollView 滚动 */
const FILE_EDITOR_MIN_HEIGHT = 220;

type FileTab = 'soul' | 'memory' | 'recent' | 'daily';
type SettingsTab = 'basic' | FileTab | 'memoryHistory';

function formatLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function createSoulSettingsStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.backgroundSecondary },
    flex1: { flex: 1 },
    mainFlex: { flex: 1, minHeight: 0 },
    memoryHistoryRoot: { flex: 1, minHeight: 0 },
    memoryHistoryDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
    },
    memoryHistoryBody: {
      flex: 1,
      minHeight: 0,
      paddingHorizontal: 14,
      paddingTop: 8,
      paddingBottom: 8,
    },
    memoryHistoryDateLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
      marginBottom: 8,
    },
    memoryHistoryLoader: { marginTop: 24 },
    memoryHistoryScroll: { flex: 1 },
    memoryHistoryScrollContent: { paddingBottom: 24 },
    memoryHistoryText: { fontSize: 15, color: c.textPrimary, lineHeight: 22 },
    rightEdgeGesture: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: EDGE_WIDTH,
      zIndex: 10,
    },
    topChrome: {
      backgroundColor: c.headerBarBackground,
      borderBottomWidth: c.headerBarBottomBorderWidth,
      borderBottomColor: c.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingHorizontal: 8,
      paddingBottom: 10,
      backgroundColor: c.headerBarBackground,
    },
    backBtn: { padding: 8, width: 44 },
    headerAgentTrigger: {
      minWidth: 0,
      maxWidth: '82%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingLeft: 2,
      paddingVertical: 10,
    },
    headerAgentText: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textHeader,
      maxWidth: '100%',
    },
    agentSheetBg: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
    },
    agentSheetShadow: { ...shadowSheet },
    agentSheetHandle: { backgroundColor: c.borderD4, width: 36 },
    agentSheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 12,
    },
    agentSheetHeaderBorder: {
      height: c.headerBarBottomBorderWidth,
      backgroundColor: c.border,
    },
    agentSheetTitle: { fontSize: TASK_FONT_SIZE_BODY, fontWeight: '600', color: c.textPrimary },
    agentSheetCloseBtn: { paddingVertical: 8, paddingHorizontal: 4 },
    agentSheetCloseText: { fontSize: TASK_FONT_SIZE_BODY, color: c.textPrimary },
    agentSheetScroll: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 40,
    },
    agentSheetRow: {
      minHeight: 52,
      paddingVertical: 13,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.surface,
    },
    agentSheetRowGap: { marginTop: 10 },
    agentSheetRowActive: {
      backgroundColor: c.surfaceMuted,
      borderColor: c.borderMuted,
    },
    agentSheetRowText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textSlate,
    },
    agentSheetRowTextActive: {
      color: c.textHeader,
      fontWeight: '700',
    },
    tabsWrap: {
      backgroundColor: c.headerBarBackground,
      paddingBottom: 10,
    },
    secondaryTabsContent: {
      marginHorizontal: 12,
      marginTop: 2,
      marginBottom: 2,
      paddingHorizontal: 2,
      gap: 8,
    },
    secondaryTabBtn: {
      borderRadius: 999,
      minHeight: 40,
      paddingVertical: 10,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surfaceMuted,
      borderWidth: 1,
      borderColor: c.borderSubtle,
    },
    secondaryTabBtnActive: {
      backgroundColor: c.surface,
      borderColor: c.border,
    },
    secondaryTabText: {
      fontSize: 12,
      color: c.textMuted,
      fontWeight: '600',
    },
    secondaryTabTextActive: {
      color: c.textHeader,
      fontWeight: '700',
    },
    scroll: { flex: 1 },
    scrollContent: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 28 },
    loader: { marginTop: 24 },
    fieldLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
      marginBottom: 6,
      marginTop: 4,
    },
    basicInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      fontSize: 16,
      color: c.textPrimary,
      backgroundColor: c.inputBg,
      marginBottom: 14,
    },
    basicInputReadonly: {
      backgroundColor: c.surfaceMuted,
      color: c.textSecondary,
    },
    basicHint: { fontSize: 13, color: c.placeholder, marginBottom: 8, lineHeight: 18 },
    input: {
      minHeight: FILE_EDITOR_MIN_HEIGHT,
      borderWidth: 0,
      borderBottomWidth: 1,
      borderColor: c.border,
      borderRadius: 0,
      paddingHorizontal: 0,
      paddingVertical: 8,
      fontSize: 15,
      color: c.textPrimary,
      backgroundColor: 'transparent',
    },
    inputReadonly: {
      backgroundColor: c.backgroundSecondary,
      color: c.textSecondary,
    },
    counter: { marginTop: 8, fontSize: 13, color: c.placeholder, textAlign: 'right' },
    counterOver: { color: c.danger, fontWeight: '600' },
    err: { marginTop: 10, fontSize: 14, color: c.danger },
    ok: { marginTop: 8, fontSize: 14, color: c.success },
    warn: { marginTop: 8, fontSize: 13, color: '#f59e0b', fontWeight: '500' },
    saveBtn: {
      marginTop: 20,
      backgroundColor: c.primary,
      minHeight: 48,
      paddingVertical: 13,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveBtnDisabled: { opacity: 0.5 },
    saveBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '600' },
    btnRow: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 20,
    },
    secondaryBtn: {
      flex: 1,
      minHeight: 48,
      paddingVertical: 13,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    secondaryBtnText: { fontSize: 16, fontWeight: '600', color: c.textSecondary },
    saveBtnFlex: {
      flex: 1,
      backgroundColor: c.primary,
      minHeight: 48,
      paddingVertical: 13,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}

type SoulMemoryHistoryPanelProps = {
  session: Session;
  agentId: string;
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  styles: ReturnType<typeof createSoulSettingsStyles>;
  colors: AppColors;
};

/** 过往记忆：任务页同款月历 + 当日记忆文件只读；整体不滚动，仅底部正文区域滚动 */
function SoulMemoryHistoryPanel({
  session,
  agentId,
  selectedDate,
  onSelectDate,
  styles,
  colors,
}: SoulMemoryHistoryPanelProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState('');

  const dateKey = useMemo(() => formatLocalDateKey(selectedDate), [selectedDate]);
  const filePath = useMemo(() => {
    const base = String(agentId || '').trim();
    if (!base) return '';
    return `${base}/memory/${dateKey}.md`;
  }, [agentId, dateKey]);

  useEffect(() => {
    if (!session || !filePath) return;
    let cancelled = false;
    setLoading(true);
    setFetchErr('');
    getAgentfFile(session, filePath)
      .then((data) => {
        if (cancelled) return;
        const payload = data as AgentfFilePayload;
        setContent(typeof payload.content === 'string' ? payload.content : '');
      })
      .catch((e) => {
        if (cancelled) return;
        setFetchErr(e instanceof Error ? e.message : String(e));
        setContent('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, filePath]);

  return (
    <View style={styles.memoryHistoryRoot}>
      <MonthCalendarScroll selectedDate={selectedDate} onSelectDate={onSelectDate} />
      <View style={styles.memoryHistoryDivider} />
      <View style={styles.memoryHistoryBody}>
        <Text style={styles.memoryHistoryDateLabel}>{dateKey} 的记忆</Text>
        {loading ? (
          <ActivityIndicator style={styles.memoryHistoryLoader} color={colors.textMuted} />
        ) : fetchErr ? (
          <ScrollView
            style={styles.memoryHistoryScroll}
            contentContainerStyle={styles.memoryHistoryScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.err}>{fetchErr}</Text>
          </ScrollView>
        ) : (
          <ScrollView
            style={styles.memoryHistoryScroll}
            contentContainerStyle={styles.memoryHistoryScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <Text style={styles.memoryHistoryText} selectable>
              {content.trim() === '' ? '（这一天没有记忆内容）' : content}
            </Text>
          </ScrollView>
        )}
      </View>
    </View>
  );
}

type SoulAgentBasicPanelProps = {
  session: Session;
  agentId: string;
  canEdit: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSavedDisplayName: (displayName: string) => void;
  styles: ReturnType<typeof createSoulSettingsStyles>;
  colors: AppColors;
};

function SoulAgentBasicPanel({
  session,
  agentId,
  canEdit,
  onDirtyChange,
  onSavedDisplayName,
  styles,
  colors,
}: SoulAgentBasicPanelProps) {
  const [displayName, setDisplayName] = useState('');
  const [callName, setCallName] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedHint, setSavedHint] = useState(false);
  const savedRef = useRef({ display: '', call: '' });

  const recomputeDirty = useCallback(
    (d: string, c: string) => {
      const dirty = d !== savedRef.current.display || c !== savedRef.current.call;
      onDirtyChange(dirty);
    },
    [onDirtyChange]
  );

  useEffect(() => {
    if (!session || !agentId) return;
    let cancelled = false;
    setLoading(true);
    setErr('');
    getAgentProfile(session, agentId)
      .then((p) => {
        if (cancelled) return;
        const d = typeof p.display_name === 'string' ? p.display_name : '';
        const c = typeof p.call_name === 'string' ? p.call_name : '';
        savedRef.current = { display: d, call: c };
        setDisplayName(d);
        setCallName(c);
        setEditing(false);
        onDirtyChange(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, agentId, onDirtyChange]);

  const handleSave = async () => {
    if (!session || saving || !canEdit) return;
    setSaving(true);
    setErr('');
    setSavedHint(false);
    try {
      const p = await putAgentProfile(session, agentId, {
        display_name: displayName.trim(),
        call_name: callName.trim(),
      });
      const d = typeof p.display_name === 'string' ? p.display_name : displayName;
      const c = typeof p.call_name === 'string' ? p.call_name : callName;
      savedRef.current = { display: d, call: c };
      setDisplayName(d);
      setCallName(c);
      setEditing(false);
      onDirtyChange(false);
      onSavedDisplayName(d.trim());
      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    const { display: d, call: c } = savedRef.current;
    setDisplayName(d);
    setCallName(c);
    setEditing(false);
    onDirtyChange(false);
    setErr('');
  };

  const dirty =
    displayName !== savedRef.current.display || callName !== savedRef.current.call;

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.textMuted} />;
  }

  const inputsEditable = canEdit && editing;

  return (
    <View>
      <Text style={styles.fieldLabel}>显示名</Text>
      <TextInput
        style={[styles.basicInput, !inputsEditable && styles.basicInputReadonly]}
        value={displayName}
        editable={inputsEditable}
        onChangeText={(v) => {
          const next = v.slice(0, AGENT_NAME_MAX);
          setDisplayName(next);
          recomputeDirty(next, callName);
        }}
        placeholder="列表与标题中展示的名称"
        placeholderTextColor={colors.placeholder}
        maxLength={AGENT_NAME_MAX}
      />
      <Text style={styles.fieldLabel}>称呼名</Text>
      <TextInput
        style={[styles.basicInput, !inputsEditable && styles.basicInputReadonly]}
        value={callName}
        editable={inputsEditable}
        onChangeText={(v) => {
          const next = v.slice(0, AGENT_NAME_MAX);
          setCallName(next);
          recomputeDirty(displayName, next);
        }}
        placeholder="对话中如何称呼你"
        placeholderTextColor={colors.placeholder}
        maxLength={AGENT_NAME_MAX}
      />
      <Text style={styles.basicHint}>各最多 {AGENT_NAME_MAX} 字；保存后对话气泡与注入会使用新名称。</Text>
      {err ? <Text style={styles.err}>{err}</Text> : null}
      {savedHint ? <Text style={styles.ok}>已保存</Text> : null}
      {editing && dirty ? <Text style={styles.warn}>有未保存修改</Text> : null}
      {!editing ? (
        <TouchableOpacity
          style={[styles.saveBtn, !canEdit && styles.saveBtnDisabled]}
          onPress={() => setEditing(true)}
          disabled={!canEdit}
          activeOpacity={0.85}
        >
          <Text style={styles.saveBtnText}>编辑</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[styles.secondaryBtn, saving && styles.saveBtnDisabled]}
            onPress={handleCancelEdit}
            disabled={saving}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>取消编辑</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.saveBtnFlex, (saving || !dirty) && styles.saveBtnDisabled]}
            onPress={handleSave}
            disabled={saving || !dirty}
            activeOpacity={0.85}
          >
            {saving ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.saveBtnText}>保存</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

type SoulAgentFileEditorPanelProps = {
  editorKey: string;
  fileEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  currentText: string;
  currentMaxChars: number;
  currentDirty: boolean;
  canEdit: boolean;
  saving: boolean;
  over: boolean;
  err: string;
  savedHint: boolean;
  loading: boolean;
  onChangeText: (v: string) => void;
  onSave: () => void;
  styles: ReturnType<typeof createSoulSettingsStyles>;
  colors: AppColors;
};

function SoulAgentFileEditorPanel({
  editorKey,
  fileEditing,
  onStartEdit,
  onCancelEdit,
  currentText,
  currentMaxChars,
  currentDirty,
  canEdit,
  saving,
  over,
  err,
  savedHint,
  loading,
  onChangeText,
  onSave,
  styles,
  colors,
}: SoulAgentFileEditorPanelProps) {
  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.textMuted} />;
  }

  const inputsEditable = canEdit && fileEditing;
  const canSave = fileEditing && currentDirty && !over && canEdit;

  return (
    <View>
      <TextInput
        key={editorKey}
        style={[styles.input, !inputsEditable && styles.inputReadonly]}
        multiline
        scrollEnabled={false}
        textAlignVertical="top"
        placeholder="点「编辑」后可修改该文件内容…"
        placeholderTextColor={colors.placeholder}
        value={currentText}
        editable={inputsEditable}
        onChangeText={onChangeText}
        maxLength={currentMaxChars + 500}
      />
      <Text style={[styles.counter, over && styles.counterOver]}>
        {currentText.length} / {currentMaxChars}
      </Text>
      {err ? <Text style={styles.err}>{err}</Text> : null}
      {savedHint ? <Text style={styles.ok}>已保存</Text> : null}
      {fileEditing && currentDirty ? <Text style={styles.warn}>有未保存修改</Text> : null}
      {!fileEditing ? (
        <TouchableOpacity
          style={[styles.saveBtn, !canEdit && styles.saveBtnDisabled]}
          onPress={onStartEdit}
          disabled={!canEdit}
          activeOpacity={0.85}
        >
          <Text style={styles.saveBtnText}>编辑</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[styles.secondaryBtn, saving && styles.saveBtnDisabled]}
            onPress={onCancelEdit}
            disabled={saving}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>取消编辑</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.saveBtnFlex, (saving || !canSave) && styles.saveBtnDisabled]}
            onPress={onSave}
            disabled={saving || !canSave}
            activeOpacity={0.85}
          >
            {saving ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.saveBtnText}>保存</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

export function SoulSettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createSoulSettingsStyles(colors), [colors]);
  const { session } = useSession();
  const { width: screenWidth } = useWindowDimensions();
  const gestureStartX = React.useRef(0);

  const settingsTabs: Array<{ key: SettingsTab; label: string }> = [
    { key: 'basic', label: '基本信息' },
    { key: 'soul', label: 'SOUL' },
    { key: 'memory', label: 'MEMORY' },
    { key: 'recent', label: 'MEMORY_RECENT' },
    { key: 'daily', label: '今日记忆' },
    { key: 'memoryHistory', label: '过往记忆' },
  ];

  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedTab, setSelectedTab] = useState<SettingsTab>('basic');
  const [textByKey, setTextByKey] = useState<Record<string, string>>({});
  const [savedTextByKey, setSavedTextByKey] = useState<Record<string, string>>({});
  const [maxCharsByKey, setMaxCharsByKey] = useState<Record<string, number>>({});
  const [dirtyByKey, setDirtyByKey] = useState<Record<string, boolean>>({});
  const [basicDirty, setBasicDirty] = useState(false);
  const [fileEditing, setFileEditing] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedHint, setSavedHint] = useState(false);
  const [agentSheetOpen, setAgentSheetOpen] = useState(false);
  const [agentDisplayNameById, setAgentDisplayNameById] = useState<Record<string, string>>({});
  const [memoryHistoryDate, setMemoryHistoryDate] = useState(() => new Date());
  const agentSheetRef = useRef<BottomSheetModal>(null);

  const dismissAgentSheet = useCallback(() => {
    agentSheetRef.current?.dismiss();
  }, []);

  const renderAgentSheetBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={colors.bottomSheetBackdropOpacity}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    [colors.bottomSheetBackdropOpacity]
  );

  const handleAgentSheetChange = useCallback((index: number) => {
    setAgentSheetOpen(index >= 0);
  }, []);

  const todayKey = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const resolveFilePath = useCallback(
    (agentId: string, tab: FileTab) => {
      const base = String(agentId || '').trim();
      if (!base) return '';
      if (tab === 'soul') return `${base}/SOUL.md`;
      if (tab === 'memory') return `${base}/MEMORY.md`;
      if (tab === 'recent') return `${base}/MEMORY_RECENT.md`;
      return `${base}/memory/${todayKey}.md`;
    },
    [todayKey]
  );

  const currentKey = useMemo(
    () => `${selectedAgentId}::${selectedTab}`,
    [selectedAgentId, selectedTab]
  );
  const currentPath = useMemo(() => {
    if (selectedTab === 'basic' || selectedTab === 'memoryHistory') return '';
    return resolveFilePath(selectedAgentId, selectedTab as FileTab);
  }, [resolveFilePath, selectedAgentId, selectedTab]);
  const currentText =
    selectedTab === 'basic' || selectedTab === 'memoryHistory'
      ? ''
      : (textByKey[currentKey] ?? '');
  const currentMaxChars = selectedTab === 'basic' ? 32000 : (maxCharsByKey[currentKey] ?? 32000);
  const currentFileDirty = selectedTab === 'basic' ? false : Boolean(dirtyByKey[currentKey]);
  const currentDirty =
    selectedTab === 'basic'
      ? basicDirty
      : selectedTab === 'memoryHistory'
        ? false
        : currentFileDirty;

  const loadCurrentFile = useCallback(
    async (agentId: string, tab: FileTab) => {
      if (!session) return;
      const file = resolveFilePath(agentId, tab);
      if (!file) return;
      const key = `${agentId}::${tab}`;
      if (textByKey[key] != null) {
        setSavedTextByKey((prev) =>
          prev[key] !== undefined ? prev : { ...prev, [key]: textByKey[key] ?? '' }
        );
        setFileLoading(false);
        return;
      }
      setFileLoading(true);
      setErr('');
      try {
        const data = (await getAgentfFile(session, file)) as AgentfFilePayload;
        setTextByKey((prev) => ({ ...prev, [key]: data.content }));
        setSavedTextByKey((prev) => ({ ...prev, [key]: data.content }));
        setMaxCharsByKey((prev) => ({ ...prev, [key]: data.max_chars }));
        setDirtyByKey((prev) => ({ ...prev, [key]: false }));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setFileLoading(false);
      }
    },
    [resolveFilePath, session, textByKey]
  );

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoadingAgents(true);
    getAgentIds(session)
      .then((ids) => {
        if (cancelled) return;
        setAgentIds(ids);
        const first = ids.length > 0 ? ids[0] : 'default';
        setSelectedAgentId(first);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setSelectedAgentId('default');
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const agentProfileFetchKey = useMemo(() => {
    const s = new Set<string>();
    for (const id of agentIds) {
      const t = String(id || '').trim();
      if (t) s.add(t);
    }
    const one = String(selectedAgentId || '').trim();
    if (one) s.add(one);
    return [...s].sort().join('\0');
  }, [agentIds, selectedAgentId]);

  useEffect(() => {
    if (!session || !agentProfileFetchKey) return;
    const ids = agentProfileFetchKey.split('\0').filter(Boolean);
    let cancelled = false;
    void Promise.all(
      ids.map((id) =>
        getAgentProfile(session, id).then((p) => {
          const dn = (p.display_name || '').trim();
          return [id, dn] as const;
        })
      )
    ).then((entries) => {
      if (cancelled) return;
      setAgentDisplayNameById((prev) => {
        const next = { ...prev };
        for (const [id, dn] of entries) {
          if (dn) next[id] = dn;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [session, agentProfileFetchKey]);

  useEffect(() => {
    if (!selectedAgentId || selectedTab === 'basic' || selectedTab === 'memoryHistory') return;
    void loadCurrentFile(selectedAgentId, selectedTab as FileTab);
  }, [selectedAgentId, selectedTab, loadCurrentFile]);

  useEffect(() => {
    setMemoryHistoryDate(new Date());
  }, [selectedAgentId]);

  useEffect(() => {
    setFileEditing(false);
  }, [selectedAgentId, selectedTab]);

  const handleCancelFileEdit = useCallback(() => {
    const saved = savedTextByKey[currentKey] ?? '';
    setTextByKey((prev) => ({ ...prev, [currentKey]: saved }));
    setDirtyByKey((prev) => ({ ...prev, [currentKey]: false }));
    setFileEditing(false);
    setErr('');
  }, [currentKey, savedTextByKey]);

  const handleSaveFile = async () => {
    if (!session || saving || !currentPath || selectedTab === 'basic' || selectedTab === 'memoryHistory')
      return;
    if (currentText.length > currentMaxChars) {
      setErr(`超出上限（最多 ${currentMaxChars} 字）`);
      return;
    }
    setSaving(true);
    setErr('');
    setSavedHint(false);
    try {
      const data = await putAgentfFile(session, currentPath, currentText);
      setTextByKey((prev) => ({ ...prev, [currentKey]: data.content }));
      setSavedTextByKey((prev) => ({ ...prev, [currentKey]: data.content }));
      setMaxCharsByKey((prev) => ({ ...prev, [currentKey]: data.max_chars }));
      setDirtyByKey((prev) => ({ ...prev, [currentKey]: false }));
      setFileEditing(false);
      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const switchWithDirtyGuard = useCallback(
    (next: { agentId?: string; tab?: SettingsTab }) => {
      const apply = () => {
        if (next.agentId != null) {
          setSelectedAgentId(next.agentId);
          dismissAgentSheet();
        }
        if (next.tab != null) setSelectedTab(next.tab);
      };
      if (!currentDirty) {
        apply();
        return;
      }
      Alert.alert(
        '有未保存修改',
        '当前内容尚未保存，切换后未保存修改将丢失。确定继续吗？',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '继续',
            style: 'destructive',
            onPress: () => {
              if (selectedTab !== 'basic') {
                const k = `${selectedAgentId}::${selectedTab}`;
                const saved = savedTextByKey[k] ?? '';
                setTextByKey((prev) => ({ ...prev, [k]: saved }));
                setDirtyByKey((prev) => ({ ...prev, [k]: false }));
                setFileEditing(false);
              }
              apply();
            },
          },
        ]
      );
    },
    [currentDirty, dismissAgentSheet, savedTextByKey, selectedAgentId, selectedTab]
  );

  const agentSheetIds = useMemo(() => {
    if (agentIds.length > 0) return agentIds;
    return selectedAgentId ? [selectedAgentId] : ['default'];
  }, [agentIds, selectedAgentId]);

  const handleSavedDisplayName = useCallback((displayName: string) => {
    const id = String(selectedAgentId || '').trim();
    if (!id) return;
    const dn = displayName.trim();
    setAgentDisplayNameById((prev) => {
      const next = { ...prev };
      if (dn) next[id] = dn;
      else delete next[id];
      return next;
    });
  }, [selectedAgentId]);

  const stableBasicDirtySetter = useCallback((d: boolean) => {
    setBasicDirty(d);
  }, []);

  const tabBarScrollRef = useRef<ScrollView | null>(null);
  const tabBarViewportWidthRef = useRef(0);
  const tabBarContentWidthRef = useRef(0);
  const tabLayoutsRef = useRef<Partial<Record<SettingsTab, { x: number; width: number }>>>({});

  const scrollTabIntoView = useCallback((tabKey: SettingsTab) => {
    requestAnimationFrame(() => {
      const tab = tabLayoutsRef.current[tabKey];
      const vw = tabBarViewportWidthRef.current;
      const scroller = tabBarScrollRef.current;
      if (!tab || vw <= 0 || !scroller) return;

      const cw = tabBarContentWidthRef.current;
      const tabLeft = tab.x;
      const tabW = tab.width;

      let targetX = tabLeft + tabW / 2 - vw / 2;
      if (tabW > vw) {
        targetX = tabLeft;
      }

      if (cw > vw) {
        const maxScrollX = cw - vw;
        // 命中最右侧 tab（例如最后一个）时，优先滚到末尾，确保完整可见。
        if (tabLeft + tabW >= cw - 4) {
          targetX = maxScrollX;
        }
        targetX = Math.max(0, Math.min(targetX, maxScrollX));
      } else {
        targetX = Math.max(0, targetX);
      }

      scroller.scrollTo({ x: targetX, animated: true });
    });
  }, []);

  useLayoutEffect(() => {
    scrollTabIntoView(selectedTab);
  }, [selectedTab, scrollTabIntoView]);

  const rightEdgeClose = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10,
      onPanResponderGrant: (evt) => {
        gestureStartX.current = evt.nativeEvent.pageX;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (
          gestureState.dx < -SWIPE_THRESHOLD &&
          gestureStartX.current >= screenWidth - EDGE_WIDTH - 20
        ) {
          navigation.goBack();
        }
      },
    })
  ).current;

  if (!session) return null;

  const over =
    selectedTab !== 'basic' &&
    selectedTab !== 'memoryHistory' &&
    currentText.length > currentMaxChars;
  const canEdit = Boolean(selectedAgentId);
  const fileEditorKey = `${selectedAgentId}::${selectedTab}`;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View
        style={[styles.rightEdgeGesture, { right: 0 }]}
        {...rightEdgeClose.panHandlers}
        pointerEvents="box-only"
      />
      <KeyboardAvoidingView
        style={styles.flex1}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <View style={[styles.topChrome, { paddingTop: insets.top + 8 }]}>
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => navigation.goBack()}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="chevron-back" size={26} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerAgentTrigger}
              onPress={() => agentSheetRef.current?.present()}
              activeOpacity={0.8}
            >
              <Text style={styles.headerAgentText} numberOfLines={1} ellipsizeMode="tail">
                {resolveAgentDisplayLabel(selectedAgentId, agentDisplayNameById[selectedAgentId])}
              </Text>
              <Ionicons
                name={agentSheetOpen ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.textMuted}
              />
            </TouchableOpacity>
          </View>
          <View style={styles.tabsWrap}>
            <ScrollView
              ref={tabBarScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.secondaryTabsContent}
              onLayout={(e) => {
                tabBarViewportWidthRef.current = e.nativeEvent.layout.width;
                scrollTabIntoView(selectedTab);
              }}
              onContentSizeChange={(w) => {
                tabBarContentWidthRef.current = w;
                scrollTabIntoView(selectedTab);
              }}
            >
              {settingsTabs.map((t) => {
                const active = t.key === selectedTab;
                return (
                  <TouchableOpacity
                    key={t.key}
                    style={[styles.secondaryTabBtn, active && styles.secondaryTabBtnActive]}
                    onLayout={(e) => {
                      const { x, width } = e.nativeEvent.layout;
                      tabLayoutsRef.current[t.key] = { x, width };
                      if (t.key === selectedTab) {
                        scrollTabIntoView(selectedTab);
                      }
                    }}
                    onPress={() => switchWithDirtyGuard({ tab: t.key })}
                    activeOpacity={0.82}
                  >
                    <Text style={[styles.secondaryTabText, active && styles.secondaryTabTextActive]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>

        {loadingAgents ? (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <ActivityIndicator style={styles.loader} color={colors.textMuted} />
          </ScrollView>
        ) : selectedTab === 'memoryHistory' ? (
          <View style={styles.mainFlex}>
            <SoulMemoryHistoryPanel
              session={session}
              agentId={selectedAgentId}
              selectedDate={memoryHistoryDate}
              onSelectDate={setMemoryHistoryDate}
              styles={styles}
              colors={colors}
            />
          </View>
        ) : (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {selectedTab === 'basic' ? (
              <SoulAgentBasicPanel
                key={selectedAgentId}
                session={session}
                agentId={selectedAgentId}
                canEdit={canEdit}
                onDirtyChange={stableBasicDirtySetter}
                onSavedDisplayName={handleSavedDisplayName}
                styles={styles}
                colors={colors}
              />
            ) : (
              <SoulAgentFileEditorPanel
                key={fileEditorKey}
                editorKey={fileEditorKey}
                fileEditing={fileEditing}
                onStartEdit={() => setFileEditing(true)}
                onCancelEdit={handleCancelFileEdit}
                currentText={currentText}
                currentMaxChars={currentMaxChars}
                currentDirty={currentFileDirty}
                canEdit={canEdit}
                saving={saving}
                over={over}
                err={err}
                savedHint={savedHint}
                loading={fileLoading}
                onChangeText={(v) => {
                  setTextByKey((prev) => ({ ...prev, [currentKey]: v }));
                  const saved = savedTextByKey[currentKey] ?? '';
                  setDirtyByKey((prev) => ({ ...prev, [currentKey]: v !== saved }));
                }}
                onSave={handleSaveFile}
                styles={styles}
                colors={colors}
              />
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingView>

      <BottomSheetModal
        ref={agentSheetRef}
        snapPoints={['50%', '88%']}
        index={0}
        onChange={handleAgentSheetChange}
        onDismiss={() => setAgentSheetOpen(false)}
        enablePanDownToClose
        enableDynamicSizing={false}
        backdropComponent={renderAgentSheetBackdrop}
        backgroundStyle={[styles.agentSheetBg, styles.agentSheetShadow]}
        handleIndicatorStyle={styles.agentSheetHandle}
      >
        <View style={styles.agentSheetHeader}>
          <Text style={styles.agentSheetTitle}>选择 Agent</Text>
          <TouchableOpacity onPress={dismissAgentSheet} style={styles.agentSheetCloseBtn} activeOpacity={0.7}>
            <Text style={styles.agentSheetCloseText}>关闭</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.agentSheetHeaderBorder} />
        <BottomSheetScrollView
          contentContainerStyle={styles.agentSheetScroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {agentSheetIds.map((id, idx) => {
            const active = id === selectedAgentId;
            return (
              <TouchableOpacity
                key={id}
                style={[styles.agentSheetRow, active && styles.agentSheetRowActive, idx > 0 && styles.agentSheetRowGap]}
                onPress={() => switchWithDirtyGuard({ agentId: id })}
                activeOpacity={0.82}
              >
                <Text style={[styles.agentSheetRowText, active && styles.agentSheetRowTextActive]}>
                  {resolveAgentDisplayLabel(id, agentDisplayNameById[id])}
                </Text>
                {active ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
              </TouchableOpacity>
            );
          })}
        </BottomSheetScrollView>
      </BottomSheetModal>
    </SafeAreaView>
  );
}
