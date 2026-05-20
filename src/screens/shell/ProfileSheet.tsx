/**
 * ProfileSheet —— 用户/账户设置 bottom sheet。
 *
 * 替换原来从左滑入的 ProfileScreen 全屏页：
 *  - 由抽屉底栏头像按钮通过 BottomSheetModalRef 唤起，从底部弹起；可下滑关闭。
 *  - 顶部 grabber bar；顶部一个用户卡片；下面一组 row。
 *  - 点 row（账户操作 / Agent 与记忆 / 用量 / 外观 / 关于 / 通知）= 关 sheet + 同时 push 对应的 RootStack 子页（user 定的「关 sheet 同时 push 父层」）。
 *
 * 「关于 / 检查更新」原来在 ProfileScreen 内是一个嵌套 Modal；此处仍保留 RN Modal 嵌套渲染 —— Modal 在原生窗口层渲染、可叠在 BottomSheet 之上。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import KeepAwake from 'react-native-keep-awake';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { RootStackParamList } from '../../navigation/types';
import { getCurrentUserInfo } from '../../api';
import { APP_VERSION } from '../../appVersion';
import { getChangelogChanges } from '../../changelog';
import {
  compareVersions,
  getLatest,
  getReleases,
  type AndroidLatestRelease,
  type AndroidReleaseItem,
} from '../../api/androidUpdateApi';
import { downloadApk, installApk } from '../../utils/androidUpdate';
import { isApnsSupported } from '../../notifications/apnsClient';
import {
  subscribeClientOutdated,
  type ClientOutdatedDetail,
} from '../../utils/clientCompatBus';
import { shadowSheet, shadowCardThemed } from '../../theme/shadows';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';
type DownloadStatus = 'idle' | 'downloading' | 'ready' | 'error';

export function ProfileSheet({
  sheetRef,
}: {
  sheetRef: React.RefObject<BottomSheetModal | null>;
}) {
  const navigation = useNavigation<Nav>();
  const { session, serverBaseUrl } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  /** 用户头像 / 昵称 */
  const [userInfo, setUserInfo] = useState<{
    avatarUrl?: string;
    nickname?: string;
  } | null>(null);
  /** 服务器 426：当前 mobile 版本已被网关拒绝；用来在 about 面板顶部展示红色横幅 */
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

  /** 关于 / 检查更新（嵌套 Modal） */
  const [aboutVisible, setAboutVisible] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateError, setUpdateError] = useState('');
  const [latestRelease, setLatestRelease] = useState<AndroidLatestRelease | null>(
    null
  );
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>('idle');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState('');
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null);
  const [versionHistory, setVersionHistory] = useState<AndroidReleaseItem[]>([]);
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false);
  const [versionHistoryExpanded, setVersionHistoryExpanded] = useState(false);
  const [expandedChangelogVersion, setExpandedChangelogVersion] = useState<
    string | null
  >(null);

  /** 订阅 426 总线：记下被服务器拒掉的版本号用于横幅；并在 Android 上自动展开 about modal
   *  （iOS 没这步，会由 UpgradeRequiredOverlay 的「我知道了」结束流程） */
  useEffect(() => {
    return subscribeClientOutdated((d) => {
      setClientOutdated(d);
      if (Platform.OS === 'android') {
        setAboutVisible(true);
        setUpdateStatus('idle');
        setUpdateError('');
        setLatestRelease(null);
      }
    });
  }, []);

  const openAbout = useCallback(() => {
    setAboutVisible(true);
    setUpdateStatus('idle');
    setUpdateError('');
    setLatestRelease(null);
  }, []);
  const closeAbout = useCallback(() => setAboutVisible(false), []);

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

  const handleDownload = useCallback(async () => {
    if (!latestRelease?.url || !latestRelease?.filename) return;
    setDownloadStatus('downloading');
    setDownloadError('');
    setDownloadProgress(0);
    if (Platform.OS === 'android') KeepAwake.activate();
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
      if (Platform.OS === 'android') KeepAwake.deactivate();
    }
  }, [latestRelease]);

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

  /** 记一下「这次 dismiss 是因为要去子页」；子页 pop 回 DrawerShell focus 时
   *  自动重新 present，让 sheet 看起来"还在" —— 实测比让 sheet 跨页常驻更自然
   *  （后者会发生底栏 sheet 飘在不相关页面上的违和感）。 */
  const willReopenOnReturn = useRef(false);

  /** 关 sheet 同时 push 子页：sheet 下滑动画 与 RootStack push 动画并行 */
  const dismissAndNavigate = useCallback(
    (route: keyof RootStackParamList) => {
      willReopenOnReturn.current = true;
      sheetRef.current?.dismiss();
      // navigate 不要 setTimeout，让两个动画在同一帧并行启动
      navigation.navigate(route as never);
    },
    [navigation, sheetRef]
  );

  /** DrawerShell 再次 focus（= 从设置子页 pop 回来）时，若刚才是因 dismissAndNavigate
   *  关掉的，就再 present 一次。consume 完立刻清旗，避免下次普通 dismiss 又被错误重开。 */
  useFocusEffect(
    useCallback(() => {
      if (willReopenOnReturn.current) {
        willReopenOnReturn.current = false;
        sheetRef.current?.present();
      }
    }, [sheetRef])
  );

  const renderBackdrop = useCallback(
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

  if (!session) {
    // 没登录就不渲染 sheet 主体；但仍要 mount BottomSheetModal 避免 ref 报错
    return (
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={['80%']}
        index={0}
        enablePanDownToClose
        enableDynamicSizing={false}
        backdropComponent={renderBackdrop}
        backgroundStyle={[styles.sheetBg, styles.sheetShadow]}
        handleIndicatorStyle={styles.handle}
      >
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>请先登录</Text>
        </View>
      </BottomSheetModal>
    );
  }

  const initial = session.user_id.slice(0, 1).toUpperCase() || '?';
  const isAndroid = Platform.OS === 'android';

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={['80%']}
        index={0}
        enablePanDownToClose
        enableDynamicSizing={false}
        backdropComponent={renderBackdrop}
        backgroundStyle={[styles.sheetBg, styles.sheetShadow]}
        handleIndicatorStyle={styles.handle}
      >
        <BottomSheetScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.userCard}>
            <View style={styles.avatarWrap}>
              {userInfo?.avatarUrl ? (
                <Image source={{ uri: userInfo.avatarUrl }} style={styles.avatarImg} />
              ) : (
                <Text style={styles.avatarInitial}>{initial}</Text>
              )}
            </View>
            <Text style={styles.userId}>{userInfo?.nickname || session.user_id}</Text>
            <Text style={styles.userMeta}>已连接 · Flops</Text>
          </View>

          <View style={styles.section}>
            <Row
              icon="settings-outline"
              label="账户操作"
              onPress={() => dismissAndNavigate('AccountActions')}
              colors={colors}
            />
            <Row
              icon="sparkles-outline"
              label="Agent 与记忆"
              border
              onPress={() => dismissAndNavigate('SoulSettings')}
              colors={colors}
            />
            <Row
              icon="stats-chart-outline"
              label="用量与显示"
              border
              onPress={() => dismissAndNavigate('UsageSettings')}
              colors={colors}
            />
            <Row
              icon="moon-outline"
              label="外观"
              border
              onPress={() => dismissAndNavigate('AppearanceSettings')}
              colors={colors}
            />
            <Row
              icon="information-circle-outline"
              label="关于 / 检查更新"
              border
              onPress={openAbout}
              colors={colors}
            />
            {Platform.OS === 'ios' && isApnsSupported() && (
              <Row
                icon="notifications-outline"
                label="通知"
                border
                onPress={() => dismissAndNavigate('NotificationSettings')}
                colors={colors}
              />
            )}
          </View>
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* 关于 / 检查更新嵌套 Modal —— RN Modal 在原生窗口层，叠在 sheet 之上没问题 */}
      <Modal
        visible={aboutVisible}
        transparent
        animationType="fade"
        onRequestClose={closeAbout}
      >
        <TouchableOpacity
          style={styles.aboutOverlay}
          activeOpacity={1}
          onPress={closeAbout}
        >
          <View style={styles.aboutCard} onStartShouldSetResponder={() => true}>
            <View style={styles.aboutHeader}>
              <Text style={styles.aboutTitle}>关于</Text>
              <TouchableOpacity onPress={closeAbout} hitSlop={12}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.aboutBody}
              contentContainerStyle={styles.aboutBodyContent}
            >
              {clientOutdated ? (
                <View style={styles.outdatedBanner}>
                  <Text style={styles.outdatedBannerText}>
                    {`服务器已不再支持当前版本 ${clientOutdated.reported || APP_VERSION}`}
                    {clientOutdated.min ? `（要求 ≥ ${clientOutdated.min}）` : ''}
                    {isAndroid ? '，请使用下方"检查更新"升级。' : '。'}
                  </Text>
                </View>
              ) : null}
              <View style={styles.aboutRow}>
                <Text style={styles.aboutLabel}>当前版本</Text>
                <Text style={styles.aboutVersion}>{APP_VERSION}</Text>
              </View>
              {isAndroid && (
                <>
                  <View style={styles.aboutRow}>
                    <TouchableOpacity
                      style={[
                        styles.aboutCheckBtn,
                        updateStatus === 'checking' && styles.aboutBtnDisabled,
                      ]}
                      onPress={handleCheckUpdate}
                      disabled={updateStatus === 'checking'}
                    >
                      {updateStatus === 'checking' ? (
                        <ActivityIndicator size="small" color={colors.onPrimary} />
                      ) : (
                        <Text style={styles.aboutCheckBtnText}>检查更新</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                  {(updateStatus !== 'idle' || updateError) && (
                    <View style={styles.aboutStatusWrap}>
                      {updateStatus === 'checking' && (
                        <Text style={styles.aboutStatusText}>正在检查…</Text>
                      )}
                      {updateStatus === 'up-to-date' && (
                        <Text style={styles.aboutStatusText}>已是最新版</Text>
                      )}
                      {updateStatus === 'available' && (
                        <Text style={styles.aboutStatusText}>
                          发现新版本 {latestRelease?.version}
                        </Text>
                      )}
                      {updateStatus === 'error' && updateError && (
                        <Text style={styles.aboutStatusError}>{updateError}</Text>
                      )}
                    </View>
                  )}
                  {updateStatus === 'available' && latestRelease && (
                    <>
                      {(downloadStatus === 'idle' || downloadStatus === 'error') && (
                        <TouchableOpacity
                          style={styles.aboutDownloadBtn}
                          onPress={handleDownload}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.aboutDownloadBtnText}>
                            {downloadStatus === 'error' ? '重新下载' : '下载新版本'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {downloadStatus === 'downloading' && (
                        <View style={styles.aboutProgressWrap}>
                          <Text style={styles.aboutStatusText}>
                            下载中 {downloadProgress}%
                          </Text>
                          <View style={styles.aboutProgressBar}>
                            <View
                              style={[
                                styles.aboutProgressFill,
                                { width: `${downloadProgress}%` },
                              ]}
                            />
                          </View>
                        </View>
                      )}
                      {downloadStatus === 'ready' &&
                        downloadedVersion === latestRelease.version && (
                          <View style={styles.aboutReadyWrap}>
                            <Text style={styles.aboutReadyText}>
                              下载已就绪，可随时重启应用以更新到新版本。
                            </Text>
                            <TouchableOpacity
                              style={styles.aboutInstallBtn}
                              onPress={handleInstallAndRestart}
                              activeOpacity={0.8}
                            >
                              <Text style={styles.aboutInstallBtnText}>重启并更新</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      {downloadStatus === 'error' && downloadError && (
                        <Text style={styles.aboutStatusError}>{downloadError}</Text>
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
                        <ActivityIndicator
                          size="small"
                          color={colors.textMuted}
                          style={styles.versionHistoryLoader}
                        />
                      ) : versionHistory.length > 0 ? (
                        versionHistory.map((rel) => {
                          const isCurrent = rel.version === APP_VERSION;
                          const isChangelogExpanded =
                            expandedChangelogVersion === rel.version;
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
                                    onPress={() =>
                                      setExpandedChangelogVersion((prev) =>
                                        prev === rel.version ? null : rel.version
                                      )
                                    }
                                    style={styles.versionHistoryChangelogBtn}
                                  >
                                    <Ionicons
                                      name={
                                        isChangelogExpanded
                                          ? 'chevron-down'
                                          : 'chevron-forward'
                                      }
                                      size={16}
                                      color={colors.textMuted}
                                    />
                                    <Text style={styles.versionHistoryChangelogBtnText}>
                                      更新说明
                                    </Text>
                                  </TouchableOpacity>
                                  {!isCurrent && filename && (
                                    <TouchableOpacity
                                      onPress={() => {
                                        const url = `${serverBaseUrl.replace(/\/$/, '')}/api/android-update/${encodeURIComponent(filename)}`;
                                        Linking.openURL(url).catch(() => {});
                                      }}
                                      style={styles.versionHistoryInstallBtn}
                                    >
                                      <Text style={styles.versionHistoryInstallBtnText}>
                                        安装此版本
                                      </Text>
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
                                        <Text style={styles.versionHistoryChangelogBullet}>
                                          •
                                        </Text>
                                        <Text style={styles.versionHistoryChangelogText}>
                                          {line}
                                        </Text>
                                      </View>
                                    ))
                                  ) : (
                                    <Text style={styles.versionHistoryChangelogEmpty}>
                                      暂无更新说明
                                    </Text>
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
    </>
  );
}

function Row({
  icon,
  label,
  border,
  onPress,
  colors,
}: {
  icon: string;
  label: string;
  border?: boolean;
  onPress: () => void;
  colors: AppColors;
}) {
  const s = useMemo(() => createRowStyles(colors), [colors]);
  return (
    <TouchableOpacity
      style={[s.row, border && s.rowBorder]}
      activeOpacity={0.7}
      onPress={onPress}
    >
      <Ionicons name={icon as never} size={22} color={colors.textMuted} />
      <Text style={s.label}>{label}</Text>
      <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
    </TouchableOpacity>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    sheetBg: {
      backgroundColor: c.backgroundSecondary,
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
    },
    sheetShadow: { ...shadowSheet },
    handle: { backgroundColor: c.borderD4, width: 36 },
    emptyWrap: { padding: 32, alignItems: 'center' },
    emptyText: { color: c.textMuted, fontSize: 14 },
    scrollContent: { padding: 20, paddingBottom: 48 },
    userCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      paddingVertical: 24,
      paddingHorizontal: 20,
      alignItems: 'center',
      marginBottom: 20,
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
    avatarImg: { width: 72, height: 72, borderRadius: 36 },
    avatarInitial: { fontSize: 28, fontWeight: '700', color: c.onPrimary },
    userId: { fontSize: 18, fontWeight: '600', color: c.textPrimary },
    userMeta: { fontSize: 13, color: c.textMuted, marginTop: 4 },
    section: {
      backgroundColor: c.surface,
      borderRadius: 12,
      overflow: 'hidden',
    },
    /* About modal */
    aboutOverlay: {
      flex: 1,
      backgroundColor: c.modalBackdrop,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    aboutCard: {
      width: '100%',
      maxWidth: 400,
      maxHeight: '80%',
      backgroundColor: c.surface,
      borderRadius: 16,
      overflow: 'hidden',
    },
    aboutHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: c.headerBarBottomBorderWidth,
      borderBottomColor: c.headerBarBottomBorderColor,
    },
    aboutTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader },
    aboutBody: { maxHeight: 400 },
    aboutBodyContent: { padding: 16, paddingBottom: 24 },
    aboutRow: { marginBottom: 12 },
    aboutLabel: { fontSize: 14, color: c.textMuted, marginBottom: 4 },
    aboutVersion: { fontSize: 17, fontWeight: '600', color: c.textPrimary },
    outdatedBanner: {
      marginBottom: 12,
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.danger,
      backgroundColor: 'rgba(220, 38, 38, 0.10)',
    },
    outdatedBannerText: { color: c.textPrimary, fontSize: 13, lineHeight: 20 },
    aboutCheckBtn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 10,
      alignItems: 'center',
      minWidth: 120,
    },
    aboutBtnDisabled: { opacity: 0.7 },
    aboutCheckBtnText: { fontSize: 16, fontWeight: '600', color: c.onPrimary },
    aboutStatusWrap: { marginTop: 8, marginBottom: 8 },
    aboutStatusText: { fontSize: 14, color: c.textSecondary },
    aboutStatusError: { fontSize: 14, color: c.danger },
    aboutDownloadBtn: {
      backgroundColor: c.primary,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
      marginTop: 8,
    },
    aboutDownloadBtnText: { fontSize: 16, fontWeight: '600', color: c.onPrimary },
    aboutProgressWrap: { marginTop: 12 },
    aboutProgressBar: {
      height: 6,
      backgroundColor: c.border,
      borderRadius: 3,
      marginTop: 8,
      overflow: 'hidden',
    },
    aboutProgressFill: { height: '100%', backgroundColor: c.primary, borderRadius: 3 },
    aboutReadyWrap: { marginTop: 12 },
    aboutReadyText: { fontSize: 14, color: c.textSecondary, marginBottom: 12 },
    aboutInstallBtn: {
      backgroundColor: c.success,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
    },
    aboutInstallBtnText: { fontSize: 16, fontWeight: '600', color: '#fff' },
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
    versionHistoryActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
    versionHistoryChangelogBullet: { width: 14, color: c.textMuted, lineHeight: 18 },
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

function createRowStyles(c: AppColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 12,
    },
    rowBorder: { borderTopWidth: 1, borderTopColor: c.surfaceMuted },
    label: { flex: 1, fontSize: 16, color: c.textPrimary },
  });
}
