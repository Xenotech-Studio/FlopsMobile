/**
 * 用户人设 SOUL 编辑（阶段 0）：写入后下一轮主对话 system 会注入。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import {
  DEFAULT_AGENT_SOUL_FILE,
  getAgentfFile,
  putAgentfFile,
  type AgentfFilePayload,
} from '../api';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

export function SoulSettingsScreen() {
  const navigation = useNavigation();
  const { session } = useSession();
  const { width: screenWidth } = useWindowDimensions();
  const gestureStartX = React.useRef(0);

  const [text, setText] = useState('');
  const [maxChars, setMaxChars] = useState(32000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedHint, setSavedHint] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setErr('');
    try {
      const data = (await getAgentfFile(session, DEFAULT_AGENT_SOUL_FILE)) as AgentfFilePayload;
      setText(data.content);
      setMaxChars(data.max_chars);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!session || saving) return;
    if (text.length > maxChars) {
      setErr(`超出上限（最多 ${maxChars} 字）`);
      return;
    }
    setSaving(true);
    setErr('');
    setSavedHint(false);
    try {
      const data = await putAgentfFile(session, DEFAULT_AGENT_SOUL_FILE, text);
      setText(data.content);
      setMaxChars(data.max_chars);
      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

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

  const over = text.length > maxChars;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View
        style={[styles.rightEdgeGesture, { right: 0 }]}
        {...rightEdgeClose.panHandlers}
        pointerEvents="box-only"
      />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={26} color="#374151" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>人设（SOUL）</Text>
        <View style={styles.headerRight} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex1}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.desc}>
            以下为助手的人设说明，会注入到每一轮对话的系统提示中（你保存后，下一条消息起生效）。留空则使用默认助手行为。
          </Text>
          {loading ? (
            <ActivityIndicator style={styles.loader} color="#6b7280" />
          ) : (
            <>
              <TextInput
                style={styles.input}
                multiline
                textAlignVertical="top"
                placeholder="例如：语气偏好、称呼、边界、长期角色等…"
                placeholderTextColor="#9ca3af"
                value={text}
                onChangeText={setText}
                maxLength={maxChars + 500}
              />
              <Text style={[styles.counter, over && styles.counterOver]}>
                {text.length} / {maxChars}
              </Text>
              {err ? <Text style={styles.err}>{err}</Text> : null}
              {savedHint ? <Text style={styles.ok}>已保存</Text> : null}
              <TouchableOpacity
                style={[styles.saveBtn, (saving || over) && styles.saveBtnDisabled]}
                onPress={handleSave}
                disabled={saving || over}
                activeOpacity={0.85}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveBtnText}>保存</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  flex1: { flex: 1 },
  rightEdgeGesture: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: EDGE_WIDTH,
    zIndex: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { padding: 8, width: 44 },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#111827' },
  headerRight: { width: 44 },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  desc: { fontSize: 14, color: '#6b7280', lineHeight: 21, marginBottom: 14 },
  loader: { marginTop: 24 },
  input: {
    minHeight: 200,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#f9fafb',
  },
  counter: { marginTop: 8, fontSize: 13, color: '#9ca3af', textAlign: 'right' },
  counterOver: { color: '#dc2626', fontWeight: '600' },
  err: { marginTop: 10, fontSize: 14, color: '#dc2626' },
  ok: { marginTop: 8, fontSize: 14, color: '#059669' },
  saveBtn: {
    marginTop: 20,
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
