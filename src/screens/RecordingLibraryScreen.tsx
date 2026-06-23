/**
 * RecordingLibraryScreen —— DevTestScreen 录音机的本地库。
 *
 * GET /api/dev/recordings 列表，下拉刷新；点击播放/停止（react-native-audio-api
 * 的 AudioContext.decodeAudioData + BufferSource），长按删除。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { AudioContext, type AudioBuffer, type AudioBufferSourceNode } from 'react-native-audio-api';
import { useAppTheme } from '../context/ThemeContext';
import { useSession } from '../context/SessionContext';
import type { AppColors } from '../theme/appColors';

interface RecordingListItem {
  id: string;
  title: string;
  transcribed_text: string;
  duration_ms: number;
  audio_bytes: number;
  created_at: string;
}

interface RecordingDetail extends RecordingListItem {
  audio_base64: string;
}

export function RecordingLibraryScreen() {
  const { colors } = useAppTheme();
  const { session, serverBaseUrl } = useSession();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const baseUrl = session?.server_base_url || serverBaseUrl;

  const [items, setItems] = useState<RecordingListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const stopPlayback = useCallback(() => {
    const src = currentSourceRef.current;
    currentSourceRef.current = null;
    if (src) {
      try {
        src.stop(0);
      } catch {
        /* 已停 / 未播,忽略 */
      }
    }
    setPlayingId(null);
  }, []);

  useEffect(() => {
    return () => {
      stopPlayback();
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (ctx && typeof (ctx as any).close === 'function') {
        try {
          (ctx as any).close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [stopPlayback]);

  const apiBase = useMemo(
    () => (baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`),
    [baseUrl],
  );

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setErr('');
      try {
        const res = await fetch(`${apiBase}api/dev/recordings`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items: RecordingListItem[] };
        setItems(Array.isArray(data.items) ? data.items : []);
      } catch (e: any) {
        setErr(e?.message || '加载失败');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [apiBase],
  );

  useEffect(() => {
    load('initial');
  }, [load]);

  const playItem = useCallback(
    async (item: RecordingListItem) => {
      if (busyId) return;
      // 再点同一条 = 停止
      if (playingId === item.id) {
        stopPlayback();
        return;
      }
      // 切到新一条:先停旧的
      stopPlayback();

      setBusyId(item.id);
      try {
        const res = await fetch(`${apiBase}api/dev/recordings/${item.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = (await res.json()) as RecordingDetail;
        const audioBuf = base64ToArrayBuffer(detail.audio_base64 || '');
        if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
        const ctx = audioCtxRef.current;
        const decoded: AudioBuffer = await ctx.decodeAudioData(audioBuf);
        const src = ctx.createBufferSource();
        src.buffer = decoded;
        src.connect(ctx.destination);
        src.onEnded = () => {
          if (currentSourceRef.current === src) {
            currentSourceRef.current = null;
            setPlayingId(null);
          }
        };
        currentSourceRef.current = src;
        setPlayingId(item.id);
        src.start(0);
      } catch (e: any) {
        Alert.alert('播放失败', e?.message || '未知错误');
      } finally {
        setBusyId(null);
      }
    },
    [apiBase, busyId, playingId, stopPlayback],
  );

  const deleteItem = useCallback(
    (item: RecordingListItem) => {
      Alert.alert('删除这条录音?', short(item.transcribed_text) || `${formatDuration(item.duration_ms)}`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            if (playingId === item.id) stopPlayback();
            try {
              const res = await fetch(`${apiBase}api/dev/recordings/${item.id}`, {
                method: 'DELETE',
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              setItems((prev) => prev.filter((x) => x.id !== item.id));
            } catch (e: any) {
              Alert.alert('删除失败', e?.message || '未知错误');
            }
          },
        },
      ]);
    },
    [apiBase, playingId, stopPlayback],
  );

  const renderItem = useCallback(
    ({ item }: { item: RecordingListItem }) => {
      const isPlaying = playingId === item.id;
      const isBusy = busyId === item.id;
      return (
        <Pressable
          onPress={() => playItem(item)}
          onLongPress={() => deleteItem(item)}
          style={({ pressed }) => [
            styles.item,
            { borderColor: colors.border, backgroundColor: colors.surface },
            pressed && { opacity: 0.7 },
          ]}
        >
          <View style={[styles.playBubble, { borderColor: isPlaying ? colors.danger : colors.border }]}>
            {isBusy ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Text style={[styles.playIcon, { color: isPlaying ? colors.danger : colors.textPrimary }]}>
                {isPlaying ? '■' : '▶'}
              </Text>
            )}
          </View>
          <View style={styles.itemBody}>
            <Text style={[styles.itemText, { color: colors.textPrimary }]} numberOfLines={2}>
              {item.transcribed_text || '(无文本)'}
            </Text>
            <View style={styles.itemMeta}>
              <Text style={[styles.metaText, { color: colors.textSecondary }]}>
                {formatDuration(item.duration_ms)}
              </Text>
              <Text style={[styles.metaText, { color: colors.textMuted }]}>·</Text>
              <Text style={[styles.metaText, { color: colors.textMuted }]}>
                {formatBytes(item.audio_bytes)}
              </Text>
              <Text style={[styles.metaText, { color: colors.textMuted }]}>·</Text>
              <Text style={[styles.metaText, { color: colors.textMuted }]}>{item.created_at}</Text>
            </View>
          </View>
        </Pressable>
      );
    },
    [playItem, deleteItem, playingId, busyId, colors, styles],
  );

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
          style={({ pressed }) => [styles.topButton, pressed && { opacity: 0.5 }]}
        >
          <Text style={[styles.topButtonText, { color: colors.textPrimary }]}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.textPrimary }]}>录音库</Text>
        <View style={styles.topButton} />
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : err && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.errText, { color: colors.danger }]}>{err}</Text>
          <Pressable onPress={() => load('initial')} style={styles.retryBtn}>
            <Text style={[styles.retryText, { color: colors.textPrimary }]}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load('refresh')}
              tintColor={colors.textSecondary}
            />
          }
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.textMuted }]}>还没有录音，回到上一页录一条吧。</Text>
          }
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        />
      )}
      <Text style={[styles.hint, { color: colors.textMuted }]}>点击播放 / 再点停止 · 长按删除</Text>
    </View>
  );
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function short(t: string): string {
  if (!t) return '';
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = global.atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function createStyles(c: AppColors, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    topBar: {
      paddingTop: insets.top + 8,
      paddingHorizontal: 16,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    topButton: { minWidth: 60 },
    topButtonText: { fontSize: 16, fontWeight: '500' },
    topTitle: { fontSize: 16, fontWeight: '600' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    errText: { fontSize: 14, marginBottom: 12 },
    retryBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    retryText: { fontSize: 14, fontWeight: '500' },

    listContent: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: insets.bottom + 60,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
    },
    playBubble: {
      width: 44,
      height: 44,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    playIcon: { fontSize: 18 },
    itemBody: { flex: 1 },
    itemText: { fontSize: 15, lineHeight: 22 },
    itemMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 4,
    },
    metaText: { fontSize: 12 },
    empty: { fontSize: 14, textAlign: 'center', paddingVertical: 40 },
    hint: {
      fontSize: 12,
      textAlign: 'center',
      paddingBottom: insets.bottom + 12,
      paddingTop: 4,
    },
  });
}
