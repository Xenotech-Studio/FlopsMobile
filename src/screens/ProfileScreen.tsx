/**
 * 用户信息与设置页，从左侧滑入；含账户信息、用量与显示、关于/检查更新；退出登录在「账户操作」子页。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  PanResponder,
  useWindowDimensions,
  Modal,
  Platform,
  Linking,
  ActivityIndicator,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { shadowSoftSubtle } from '../theme/shadows';
import { getCurrentUserInfo } from '../api';
import { APP_VERSION } from '../appVersion';
import {
  getLatest,
  getReleases,
  compareVersions,
  type AndroidLatestRelease,
  type AndroidReleaseItem,
} from '../api/androidUpdateApi';
import { downloadApk, installApk } from '../utils/androidUpdate';
import KeepAwake from 'react-native-keep-awake';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';
type DownloadStatus = 'idle' | 'downloading' | 'ready' | 'error';

export function ProfileScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { session, serverBaseUrl } = useSession();
  const { width: screenWidth } = useWindowDimensions();
  const gestureStartX = useRef(0);

  const [updateModalVisible, setUpdateModalVisible] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateError, setUpdateError] = useState('');
  const [latestRelease, setLatestRelease] = useState<AndroidLatestRelease | null>(null);
  const [versionHistory, setVersionHistory] = useState<AndroidReleaseItem[]>([]);
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false);
  const [versionHistoryExpanded, setVersionHistoryExpanded] = useState(false);
  /** 下载与安装分两步：下载完成后由用户决定何时「重启并更新」 */
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>('idle');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState('');
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<{ avatarUrl?: string; nickname?: string } | null>(null);

  useEffect(() => {
    if (!session) {
      setUserInfo(null);
      return;
    }
    getCurrentUserInfo(serverBaseUrl, session.user_id, session.access_token)
      .then((info) => {
        if (info) setUserInfo({ avatarUrl: info.avatarUrl, nickname: info.nickname });
        else setUserInfo(null);
      })
      .catch(() => setUserInfo(null));
  }, [session, serverBaseUrl]);

  const rightEdgeClose = useRef(
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

  const openUpdateModal = useCallback(() => {
    setUpdateModalVisible(true);
    setUpdateStatus('idle');
    setUpdateError('');
    setLatestRelease(null);
  }, []);

  const closeUpdateModal = useCallback(() => {
    setUpdateModalVisible(false);
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateError('');
    setLatestRelease(null);
    try {
      const latest = await getLatest(serverBaseUrl);
      if (!latest) {
        setUpdateStatus('error');
        setUpdateError('无法获取更新信息');
        return;
      }
      setLatestRelease(latest);
      const cmp = compareVersions(latest.version, APP_VERSION);
      if (cmp > 0) {
        setUpdateStatus('available');
        if (downloadedVersion !== latest.version) {
          setDownloadStatus('idle');
          setDownloadedPath(null);
          setDownloadedVersion(null);
        }
      } else {
        setUpdateStatus('up-to-date');
      }
    } catch {
      setUpdateStatus('error');
      setUpdateError('检查更新失败');
    }
  }, [serverBaseUrl, downloadedVersion]);

  /** 第一步：下载 APK 到本地，下载完成后显示「下载已就绪」。下载期间保持屏幕常亮不熄屏。 */
  const handleDownload = useCallback(async () => {
    if (!latestRelease?.url || !latestRelease?.filename) return;
    setDownloadStatus('downloading');
    setDownloadError('');
    setDownloadProgress(0);
    if (Platform.OS === 'android') {
      KeepAwake.activate();
    }
    try {
      const { path } = await downloadApk(
        latestRelease.url,
        latestRelease.filename,
        (percent) => setDownloadProgress(percent)
      );
      setDownloadedPath(path);
      setDownloadedVersion(latestRelease.version);
      setDownloadStatus('ready');
    } catch (e) {
      setDownloadStatus('error');
      setDownloadError(e instanceof Error ? e.message : '下载失败');
    } finally {
      if (Platform.OS === 'android') {
        KeepAwake.deactivate();
      }
    }
  }, [latestRelease]);

  /** 第二步：用户决定后调起系统安装，安装完成后用户可重启应用 */
  const handleInstallAndRestart = useCallback(async () => {
    if (!downloadedPath) return;
    try {
      await installApk(downloadedPath);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : '安装失败');
    }
  }, [downloadedPath]);

  const handleLoadVersionHistory = useCallback(async () => {
    setVersionHistoryLoading(true);
    try {
      const list = await getReleases(serverBaseUrl);
      setVersionHistory(list);
    } catch {
      setVersionHistory([]);
    } finally {
      setVersionHistoryLoading(false);
    }
  }, [serverBaseUrl]);

  if (!session) return null;

  const isAndroid = Platform.OS === 'android';

  const initial = session.user_id.slice(0, 1).toUpperCase() || '?';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View
        style={[styles.rightEdgeGesture, { right: 0 }]}
        {...rightEdgeClose.panHandlers}
        pointerEvents="box-only"
      />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>账户</Text>
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={24} color="#374151" />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.userCard}>
          <View style={styles.avatarWrap}>
            {userInfo?.avatarUrl ? (
              <Image source={{ uri: userInfo.avatarUrl }} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarText}>{initial}</Text>
            )}
          </View>
          <Text style={styles.userId}>{userInfo?.nickname || session.user_id}</Text>
          <Text style={styles.userMeta}>已连接 · Flops</Text>
        </View>

        <View style={styles.section}>
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('AccountActions')}
          >
            <Ionicons name="settings-outline" size={22} color="#6b7280" />
            <Text style={styles.rowLabel}>账户操作</Text>
            <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('UsageSettings')}
          >
            <Ionicons name="stats-chart-outline" size={22} color="#6b7280" />
            <Text style={styles.rowLabel}>用量与显示</Text>
            <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            activeOpacity={0.7}
            onPress={openUpdateModal}
          >
            <Ionicons name="information-circle-outline" size={22} color="#6b7280" />
            <Text style={styles.rowLabel}>关于 / 检查更新</Text>
            <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal
        visible={updateModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeUpdateModal}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={closeUpdateModal}
        >
          <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>关于</Text>
              <TouchableOpacity onPress={closeUpdateModal} hitSlop={12}>
                <Ionicons name="close" size={24} color="#374151" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} contentContainerStyle={styles.modalBodyContent}>
              <View style={styles.updateRow}>
                <Text style={styles.updateLabel}>当前版本</Text>
                <Text style={styles.updateVersion}>{APP_VERSION}</Text>
              </View>
              {isAndroid && (
                <>
                  <View style={styles.updateRow}>
                    <TouchableOpacity
                      style={[
                        styles.updateCheckBtn,
                        updateStatus === 'checking' && styles.updateCheckBtnDisabled,
                      ]}
                      onPress={handleCheckUpdate}
                      disabled={updateStatus === 'checking'}
                    >
                      {updateStatus === 'checking' ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.updateCheckBtnText}>检查更新</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                  {(updateStatus !== 'idle' || updateError) && (
                    <View style={styles.updateStatusWrap}>
                      {updateStatus === 'checking' && <Text style={styles.updateStatusText}>正在检查…</Text>}
                      {updateStatus === 'up-to-date' && <Text style={styles.updateStatusText}>已是最新版</Text>}
                      {updateStatus === 'available' && (
                        <Text style={styles.updateStatusText}>发现新版本 {latestRelease?.version}</Text>
                      )}
                      {updateStatus === 'error' && updateError && (
                        <Text style={styles.updateStatusError}>{updateError}</Text>
                      )}
                    </View>
                  )}
                  {updateStatus === 'available' && latestRelease && (
                    <>
                      {(downloadStatus === 'idle' || downloadStatus === 'error') && (
                        <TouchableOpacity
                          style={styles.updateDownloadBtn}
                          onPress={handleDownload}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.updateDownloadBtnText}>
                            {downloadStatus === 'error' ? '重新下载' : '下载新版本'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {downloadStatus === 'downloading' && (
                        <View style={styles.updateDownloadProgressWrap}>
                          <Text style={styles.updateStatusText}>下载中 {downloadProgress}%</Text>
                          <View style={styles.updateProgressBar}>
                            <View style={[styles.updateProgressFill, { width: `${downloadProgress}%` }]} />
                          </View>
                        </View>
                      )}
                      {downloadStatus === 'ready' && downloadedVersion === latestRelease.version && (
                        <View style={styles.updateReadyWrap}>
                          <Text style={styles.updateReadyText}>下载已就绪，可随时重启应用以更新到新版本。</Text>
                          <TouchableOpacity
                            style={styles.updateInstallBtn}
                            onPress={handleInstallAndRestart}
                            activeOpacity={0.8}
                          >
                            <Text style={styles.updateInstallBtnText}>重启并更新</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      {downloadStatus === 'error' && downloadError && (
                        <Text style={styles.updateStatusError}>{downloadError}</Text>
                      )}
                    </>
                  )}
                  <TouchableOpacity
                    style={styles.versionHistoryHeader}
                    onPress={() => {
                      const next = !versionHistoryExpanded;
                      setVersionHistoryExpanded(next);
                      if (next && versionHistory.length === 0) handleLoadVersionHistory();
                    }}
                  >
                    <Ionicons
                      name={versionHistoryExpanded ? 'chevron-down' : 'chevron-forward'}
                      size={18}
                      color="#6b7280"
                    />
                    <Text style={styles.versionHistoryTitle}>
                      历史版本
                      {versionHistory.length > 0 ? ` (${versionHistory.length})` : ''}
                    </Text>
                  </TouchableOpacity>
                  {versionHistoryExpanded && (
                    <View style={styles.versionHistoryBody}>
                      {versionHistoryLoading && versionHistory.length === 0 ? (
                        <ActivityIndicator size="small" color="#6b7280" style={styles.versionHistoryLoader} />
                      ) : versionHistory.length > 0 ? (
                        versionHistory.map((rel) => {
                          const isCurrent = rel.version === APP_VERSION;
                          return (
                            <View key={rel.version} style={styles.versionHistoryItem}>
                              <Text style={styles.versionHistoryVersion}>
                                v{rel.version}
                                {isCurrent ? ' (当前)' : ''}
                              </Text>
                              {!isCurrent && rel.filename && (
                                <TouchableOpacity
                                  onPress={() => {
                                    const url = `${serverBaseUrl.replace(/\/$/, '')}/api/android-update/${encodeURIComponent(rel.filename)}`;
                                    Linking.openURL(url).catch(() => {});
                                  }}
                                  style={styles.versionHistoryInstallBtn}
                                >
                                  <Text style={styles.versionHistoryInstallBtnText}>安装此版本</Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          );
                        })
                      ) : (
                        <Text style={styles.versionHistoryEmpty}>暂无已发布版本</Text>
                      )}
                    </View>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  closeBtn: { padding: 4 },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  userCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginBottom: 20,
    ...shadowSoftSubtle,
  },
  avatarWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    overflow: 'hidden',
  },
  avatarImage: {
    width: 72,
    height: 72,
    borderRadius: 36,
  },
  avatarText: { fontSize: 28, fontWeight: '700', color: '#fff' },
  userId: { fontSize: 18, fontWeight: '600', color: '#111827' },
  userMeta: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  rowLabel: { flex: 1, fontSize: 16, color: '#111827' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  modalBody: { maxHeight: 400 },
  modalBodyContent: { padding: 16, paddingBottom: 24 },
  updateRow: { marginBottom: 12 },
  updateLabel: { fontSize: 14, color: '#6b7280', marginBottom: 4 },
  updateVersion: { fontSize: 17, fontWeight: '600', color: '#111827' },
  updateCheckBtn: {
    backgroundColor: '#0f172a',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    minWidth: 120,
  },
  updateCheckBtnDisabled: { opacity: 0.7 },
  updateCheckBtnText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  updateStatusWrap: { marginTop: 8, marginBottom: 8 },
  updateStatusText: { fontSize: 14, color: '#374151' },
  updateStatusError: { fontSize: 14, color: '#dc2626' },
  updateDownloadBtn: {
    backgroundColor: '#0f172a',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  updateDownloadBtnText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  updateDownloadProgressWrap: { marginTop: 12 },
  updateProgressBar: {
    height: 6,
    backgroundColor: '#e5e7eb',
    borderRadius: 3,
    marginTop: 8,
    overflow: 'hidden',
  },
  updateProgressFill: {
    height: '100%',
    backgroundColor: '#0f172a',
    borderRadius: 3,
  },
  updateReadyWrap: { marginTop: 12 },
  updateReadyText: { fontSize: 14, color: '#374151', marginBottom: 12 },
  updateInstallBtn: {
    backgroundColor: '#0a7b0a',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  updateInstallBtnText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  versionHistoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    paddingVertical: 8,
  },
  versionHistoryTitle: { fontSize: 15, color: '#374151' },
  versionHistoryBody: { marginLeft: 8, marginTop: 4 },
  versionHistoryLoader: { marginVertical: 12 },
  versionHistoryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  versionHistoryVersion: { fontSize: 14, color: '#111827' },
  versionHistoryInstallBtn: { paddingVertical: 4, paddingHorizontal: 10 },
  versionHistoryInstallBtnText: { fontSize: 14, color: '#0a7b0a', fontWeight: '500' },
  versionHistoryEmpty: { fontSize: 14, color: '#6b7280', marginVertical: 12 },
});
