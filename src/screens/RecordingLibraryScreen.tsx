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
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { AudioContext, type AudioBuffer, type AudioBufferSourceNode } from 'react-native-audio-api';
import { useAppTheme } from '../context/ThemeContext';
import { useSession } from '../context/SessionContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { setPendingRevisit } from './DevTestScreen';

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
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const baseUrl = session?.server_base_url || serverBaseUrl;

  const [items, setItems] = useState<RecordingListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 「重访」下载进度：id → 0..100；以及下载错误：id → 文案
  const [downloading, setDownloading] = useState<Record<string, number>>({});
  const [dlError, setDlError] = useState<Record<string, string>>({});

  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const xhrRef = useRef<Record<string, XMLHttpRequest>>({});

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
      // 卸载时中止所有进行中的「重访」下载
      Object.values(xhrRef.current).forEach((x) => {
        try {
          x.abort();
        } catch {
          /* ignore */
        }
      });
      xhrRef.current = {};
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

  // 「重访」：XHR 下载整条音频(带进度条)，完成后回退(pop)回 DevTestScreen 进入回放模式。
  const revisitItem = useCallback(
    (item: RecordingListItem) => {
      if (downloading[item.id] != null) return; // 已在下载
      stopPlayback();
      setDlError((m) => {
        if (m[item.id] == null) return m;
        const n = { ...m };
        delete n[item.id];
        return n;
      });
      setDownloading((m) => ({ ...m, [item.id]: 0 }));

      const clearDownloading = () =>
        setDownloading((m) => {
          const n = { ...m };
          delete n[item.id];
          return n;
        });

      const xhr = new XMLHttpRequest();
      xhrRef.current[item.id] = xhr;
      xhr.open('GET', `${apiBase}api/dev/recordings/${item.id}`);
      xhr.responseType = 'text';
      xhr.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
          setDownloading((m) => (m[item.id] == null ? m : { ...m, [item.id]: pct }));
        }
      };
      xhr.onload = () => {
        delete xhrRef.current[item.id];
        clearDownloading();
        if (xhr.status < 200 || xhr.status >= 300) {
          setDlError((m) => ({ ...m, [item.id]: `下载失败 HTTP ${xhr.status}` }));
          return;
        }
        let detail: RecordingDetail;
        try {
          detail = JSON.parse(xhr.responseText) as RecordingDetail;
        } catch {
          setDlError((m) => ({ ...m, [item.id]: '解析失败' }));
          return;
        }
        setPendingRevisit({
          id: detail.id,
          title: detail.title || '',
          durationMs: detail.duration_ms,
          text: detail.transcribed_text || '',
          audioBase64: detail.audio_base64 || '',
        });
        navigation.pop(); // 回退到已有的 DevTest，而不是推一个新页
      };
      xhr.onerror = () => {
        delete xhrRef.current[item.id];
        clearDownloading();
        setDlError((m) => ({ ...m, [item.id]: '下载失败' }));
      };
      xhr.send();
    },
    [apiBase, downloading, navigation, stopPlayback],
  );

  const renderItem = useCallback(
    ({ item }: { item: RecordingListItem }) => {
      const isPlaying = playingId === item.id;
      const isBusy = busyId === item.id;
      const dlPct = downloading[item.id]; // number | undefined
      const dlErr = dlError[item.id];
      const isDownloading = dlPct != null;
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
              <Ionicons
                name={isPlaying ? 'stop' : 'play'}
                size={20}
                color={isPlaying ? colors.danger : colors.textPrimary}
              />
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
            {dlErr ? <Text style={[styles.dlErrText, { color: colors.danger }]}>{dlErr}</Text> : null}
          </View>
          {isDownloading ? (
            <View style={styles.revisitBtn}>
              <Text style={[styles.dlPctText, { color: colors.accentLoadBar }]}>{dlPct}%</Text>
            </View>
          ) : (
            <Pressable
              onPress={() => revisitItem(item)}
              hitSlop={8}
              style={({ pressed }) => [styles.revisitBtn, pressed && { opacity: 0.5 }]}
              accessibilityLabel="重访这条录音"
            >
              <Ionicons name="add-circle-outline" size={26} color={colors.textSecondary} />
            </Pressable>
          )}
          {isDownloading ? (
            <View style={styles.progressTrack}>
              <View
                style={[styles.progressFill, { width: `${dlPct}%`, backgroundColor: colors.accentLoadBar }]}
              />
            </View>
          ) : null}
        </Pressable>
      );
    },
    [playItem, deleteItem, revisitItem, playingId, busyId, downloading, dlError, colors, styles],
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
          ItemSeparatorComponent={ItemSeparator}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
        />
      )}
      <Text style={[styles.hint, { color: colors.textMuted }]}>点击播放 / 再点停止 · 长按删除</Text>
    </View>
  );
}

function ItemSeparator() {
  return <View style={separatorStyle} />;
}
const separatorStyle = { height: 10 };

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
      overflow: 'hidden', // 让底部进度条贴合圆角
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
    itemBody: { flex: 1 },
    revisitBtn: {
      marginLeft: 10,
      padding: 4,
      minWidth: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dlPctText: { fontSize: 13, fontWeight: '700' },
    dlErrText: { fontSize: 12, marginTop: 4 },
    progressTrack: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: 3,
    },
    progressFill: { height: 3 },
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
