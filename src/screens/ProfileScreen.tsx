/**
 * 用户信息与设置页，从左侧滑入；含账户信息、用量与显示、关于/检查更新；退出登录在「账户操作」子页。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { shadowCardThemed } from '../theme/shadows';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';
import { getCurrentUserInfo } from '../api';
import { APP_VERSION } from '../appVersion';
import { getChangelogChanges } from '../changelog';
import {
  getLatest,
  getReleases,
  compareVersions,
  type AndroidLatestRelease,
  type AndroidReleaseItem,
} from '../api/androidUpdateApi';
import { downloadApk, installApk } from '../utils/androidUpdate';
import KeepAwake from 'react-native-keep-awake';
import { isApnsSupported } from '../notifications/apnsClient';
import { subscribeClientOutdated, type ClientOutdatedDetail } from '../utils/clientCompatBus';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';
type DownloadStatus = 'idle' | 'downloading' | 'ready' | 'error';

export function ProfileScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { session, serverBaseUrl } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createProfileStyles(colors), [colors]);
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
  const [expandedChangelogVersion, setExpandedChangelogVersion] = useState<string | null>(null);
  /** 服务器 426：当前 mobile 版本已被网关拒绝；用来在更新面板顶部展示红色横幅 */
  const [clientOutdated, setClientOutdated] = useState<ClientOutdatedDetail | null>(null);

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

  // 订阅 426 总线：Android 通过此触发自动开「关于/检查更新」modal；iOS 由 UpgradeRequiredOverlay 自己处理
  useEffect(() => {
    return subscribeClientOutdated((d) => {
      setClientOutdated(d);
      if (Platform.OS === 'android') {
        setUpdateModalVisible(true);
        setUpdateStatus('idle');
        setUpdateError('');
        setLatestRelease(null);
      }
    });
  }, []);

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
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View
        style={[styles.rightEdgeGesture, { right: 0 }]}
        {...rightEdgeClose.panHandlers}
        pointerEvents="box-only"
      />
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.headerTitle}>账户</Text>
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={24} color={colors.textSecondary} />
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
            <Ionicons name="settings-outline" size={22} color={colors.textMuted} />
            <Text style={styles.rowLabel}>账户操作</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('SoulSettings')}
          >
            <Ionicons name="sparkles-outline" size={22} color={colors.textMuted} />
            <Text style={styles.rowLabel}>Agent 与记忆</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('UsageSettings')}
          >
            <Ionicons name="stats-chart-outline" size={22} color={colors.textMuted} />
            <Text style={styles.rowLabel}>用量与显示</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('AppearanceSettings')}
          >
            <Ionicons name="moon-outline" size={22} color={colors.textMuted} />
            <Text style={styles.rowLabel}>外观</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            activeOpacity={0.7}
            onPress={openUpdateModal}
          >
            <Ionicons name="information-circle-outline" size={22} color={colors.textMuted} />
            <Text style={styles.rowLabel}>关于 / 检查更新</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
          </TouchableOpacity>
          {Platform.OS === 'ios' && isApnsSupported() && (
            <TouchableOpacity
              style={[styles.row, styles.rowBorder]}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('NotificationSettings')}
            >
              <Ionicons name="notifications-outline" size={22} color={colors.textMuted} />
              <Text style={styles.rowLabel}>通知</Text>
              <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
            </TouchableOpacity>
          )}
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
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} contentContainerStyle={styles.modalBodyContent}>
              {clientOutdated ? (
                <View style={styles.outdatedBanner}>
                  <Text style={styles.outdatedBannerText}>
                    {`服务器已不再支持当前版本 ${clientOutdated.reported || APP_VERSION}`}
                    {clientOutdated.min ? `（要求 ≥ ${clientOutdated.min}）` : ''}
                    {isAndroid ? '，请使用下方"检查更新"升级。' : '。'}
                  </Text>
                </View>
              ) : null}
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
                        <ActivityIndicator size="small" color={colors.onPrimary} />
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
                      color={colors.textMuted}
                    />
                    <Text style={styles.versionHistoryTitle}>
                      历史版本
                      {versionHistory.length > 0 ? ` (${versionHistory.length})` : ''}
                    </Text>
                  </TouchableOpacity>
                  {versionHistoryExpanded && (
                    <View style={styles.versionHistoryBody}>
                      {versionHistoryLoading && versionHistory.length === 0 ? (
                        <ActivityIndicator size="small" color={colors.textMuted} style={styles.versionHistoryLoader} />
                      ) : versionHistory.length > 0 ? (
                        versionHistory.map((rel) => {
                          const isCurrent = rel.version === APP_VERSION;
                          const isChangelogExpanded = expandedChangelogVersion === rel.version;
                          const changes = getChangelogChanges(rel.version);
                          const filename = rel.filename;
                          return (
                            <View key={rel.version} style={styles.versionHistoryItem}>
                              <View style={styles.versionHistoryRow}>
                                <Text style={styles.versionHistoryVersion}>
                                  v{rel.version}
                                  {isCurrent ? ' (当前)' : ''}
                                </Text>
                                <View style={styles.versionHistoryActions}>
                                  <TouchableOpacity
                                    onPress={() => {
                                      setExpandedChangelogVersion((prev) =>
                                        prev === rel.version ? null : rel.version
                                      );
                                    }}
                                    style={styles.versionHistoryChangelogBtn}
                                  >
                                    <Ionicons
                                      name={isChangelogExpanded ? 'chevron-down' : 'chevron-forward'}
                                      size={16}
                                      color={colors.textMuted}
                                    />
                                    <Text style={styles.versionHistoryChangelogBtnText}>更新说明</Text>
                                  </TouchableOpacity>
                                  {!isCurrent && filename && (
                                    <TouchableOpacity
                                      onPress={() => {
                                        if (!filename) return;
                                        const url = `${serverBaseUrl.replace(/\/$/, '')}/api/android-update/${encodeURIComponent(filename)}`;
                                        Linking.openURL(url).catch(() => {});
                                      }}
                                      style={styles.versionHistoryInstallBtn}
                                    >
                                      <Text style={styles.versionHistoryInstallBtnText}>安装此版本</Text>
                                    </TouchableOpacity>
                                  )}
                                </View>
                              </View>
                              {isChangelogExpanded && (
                                <View style={styles.versionHistoryChangelog}>
                                  {changes.length > 0 ? (
                                    changes.map((line, idx) => (
                                      <View
                                        key={`${rel.version}-${idx}`}
                                        style={styles.versionHistoryChangelogItem}
                                      >
                                        <Text style={styles.versionHistoryChangelogBullet}>•</Text>
                                        <Text style={styles.versionHistoryChangelogText}>{line}</Text>
                                      </View>
                                    ))
                                  ) : (
                                    <Text style={styles.versionHistoryChangelogEmpty}>暂无更新说明</Text>
                                  )}
                                </View>
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

function createProfileStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.backgroundSecondary },
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
      paddingBottom: 12,
      borderBottomWidth: c.headerBarBottomBorderWidth,
      borderBottomColor: c.headerBarBottomBorderColor,
      backgroundColor: c.headerBarBackground,
    },
    headerTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader },
    closeBtn: { padding: 4 },
    scroll: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 40 },
    userCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      paddingVertical: 24,
      paddingHorizontal: 20,
      alignItems: 'center',
      marginBottom: 20,
      // Android：与圆钮/FAB 一致用细描边；iOS 保持原极轻阴影（与 shadowSoftSubtle 同参）
      ...shadowCardThemed(c),
    },
    avatarWrap: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: c.primary,
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
    avatarText: { fontSize: 28, fontWeight: '700', color: c.onPrimary },
    userId: { fontSize: 18, fontWeight: '600', color: c.textPrimary },
    userMeta: { fontSize: 13, color: c.textMuted, marginTop: 4 },
    section: {
      backgroundColor: c.surface,
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
    rowBorder: { borderTopWidth: 1, borderTopColor: c.surfaceMuted },
    rowLabel: { flex: 1, fontSize: 16, color: c.textPrimary },
    modalOverlay: {
      flex: 1,
      backgroundColor: c.modalBackdrop,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    modalContent: {
      width: '100%',
      maxWidth: 400,
      maxHeight: '80%',
      backgroundColor: c.surface,
      borderRadius: 16,
      overflow: 'hidden',
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: c.headerBarBottomBorderWidth,
      borderBottomColor: c.headerBarBottomBorderColor,
    },
    modalTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader },
    modalBody: { maxHeight: 400 },
    modalBodyContent: { padding: 16, paddingBottom: 24 },
    outdatedBanner: {
      marginBottom: 12,
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.danger,
      backgroundColor: 'rgba(220, 38, 38, 0.10)',
    },
    outdatedBannerText: { color: c.textPrimary, fontSize: 13, lineHeight: 20 },
    updateRow: { marginBottom: 12 },
    updateLabel: { fontSize: 14, color: c.textMuted, marginBottom: 4 },
    updateVersion: { fontSize: 17, fontWeight: '600', color: c.textPrimary },
    updateCheckBtn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 10,
      alignItems: 'center',
      minWidth: 120,
    },
    updateCheckBtnDisabled: { opacity: 0.7 },
    updateCheckBtnText: { fontSize: 16, fontWeight: '600', color: c.onPrimary },
    updateStatusWrap: { marginTop: 8, marginBottom: 8 },
    updateStatusText: { fontSize: 14, color: c.textSecondary },
    updateStatusError: { fontSize: 14, color: c.danger },
    updateDownloadBtn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
      marginTop: 8,
    },
    updateDownloadBtnText: { fontSize: 16, fontWeight: '600', color: c.onPrimary },
    updateDownloadProgressWrap: { marginTop: 12 },
    updateProgressBar: {
      height: 6,
      backgroundColor: c.border,
      borderRadius: 3,
      marginTop: 8,
      overflow: 'hidden',
    },
    updateProgressFill: {
      height: '100%',
      backgroundColor: c.primary,
      borderRadius: 3,
    },
    updateReadyWrap: { marginTop: 12 },
    updateReadyText: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
    updateInstallBtn: {
      backgroundColor: c.success,
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
    versionHistoryTitle: { fontSize: 15, color: c.textSecondary },
    versionHistoryBody: { marginLeft: 8, marginTop: 4 },
    versionHistoryLoader: { marginVertical: 12 },
    versionHistoryItem: {
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.surfaceMuted,
    },
    versionHistoryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    versionHistoryVersion: { fontSize: 14, color: c.textPrimary },
    versionHistoryActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    versionHistoryChangelogBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 10,
      backgroundColor: c.surfaceMuted,
    },
    versionHistoryChangelogBtnText: { fontSize: 13, color: c.textMuted, fontWeight: '500' },
    versionHistoryInstallBtn: { paddingVertical: 4, paddingHorizontal: 10 },
    versionHistoryInstallBtnText: { fontSize: 14, color: c.success, fontWeight: '500' },
    versionHistoryChangelog: { marginTop: 10 },
    versionHistoryChangelogItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: 8,
    },
    versionHistoryChangelogBullet: {
      width: 14,
      color: c.textMuted,
      lineHeight: 18,
    },
    versionHistoryChangelogText: {
      flex: 1,
      fontSize: 13,
      color: c.textSecondary,
      lineHeight: 18,
    },
    versionHistoryChangelogEmpty: { fontSize: 13, color: c.placeholder },
    versionHistoryEmpty: { fontSize: 14, color: c.textMuted, marginVertical: 12 },
  });
}
