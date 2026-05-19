/**
 * 服务器返回 426 后的处理——分平台两套策略，都不做"全屏屏蔽"：
 *  - Android：可应用内自更新，自动跳到关于/检查更新页（ProfileScreen 监听同一总线，开 modal）
 *  - iOS：目前 TestFlight 邀请链 / App Store 都还没上，只能弹个解释，配「24 小时后再提醒」让用户能继续用
 *
 * 24h 暂缓状态写在 AsyncStorage，避免每次 426 都弹。
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeClientOutdated, type ClientOutdatedDetail } from '../utils/clientCompatBus';
import { APP_VERSION } from '../appVersion';
import { navigationRef } from '../navigation/navigationRef';

const DEFER_STORAGE_KEY = 'flops_client_outdated_defer_until';
const DEFER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function UpgradeRequiredOverlay(): React.ReactElement | null {
  const [detail, setDetail] = useState<ClientOutdatedDetail | null>(null);
  const [deferUntil, setDeferUntil] = useState<number>(0);
  const deferLoadedRef = useRef(false);
  const androidNavigatedRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(DEFER_STORAGE_KEY)
      .then((raw) => {
        const n = raw ? Number(raw) : 0;
        if (Number.isFinite(n) && n > 0) setDeferUntil(n);
      })
      .catch(() => {})
      .finally(() => {
        deferLoadedRef.current = true;
      });
  }, []);

  useEffect(() => {
    return subscribeClientOutdated((d) => setDetail(d));
  }, []);

  // Android：发现 426 即自动跳关于/检查更新页，由 ProfileScreen 自己监听总线开 modal
  useEffect(() => {
    if (!detail) return;
    if (Platform.OS !== 'android') return;
    if (androidNavigatedRef.current) return;
    androidNavigatedRef.current = true;
    try {
      if (navigationRef.isReady()) {
        navigationRef.navigate('Profile' as never);
      }
    } catch {
      /* navigation 尚未就绪：ProfileScreen 自己也会在挂载时拉最近一次 detail */
    }
  }, [detail]);

  if (!detail) return null;

  // iOS：弹 modal；deferUntil 期内或非 iOS 不渲染
  if (Platform.OS !== 'ios') return null;
  if (deferUntil && Date.now() < deferUntil) return null;
  if (!deferLoadedRef.current) return null;

  const handleAck = () => setDetail(null);

  const handleDefer24h = async () => {
    const until = Date.now() + DEFER_WINDOW_MS;
    try {
      await AsyncStorage.setItem(DEFER_STORAGE_KEY, String(until));
    } catch {
      /* noop */
    }
    setDeferUntil(until);
    setDetail(null);
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={handleAck}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>需要升级 Flops Mobile</Text>
          <Text style={styles.body}>
            {`当前版本 ${detail.reported || APP_VERSION} 已不再受服务器支持`}
            {detail.min ? `（要求 ≥ ${detail.min}）` : ''}
            {'。'}
          </Text>
          <Text style={styles.body}>
            iOS 暂时只能通过 TestFlight / App Store 升级，等新版本铺到分发渠道后请第一时间更新。
          </Text>
          <View style={styles.buttonsRow}>
            <Pressable style={[styles.button, styles.buttonGhost]} onPress={handleDefer24h}>
              <Text style={styles.buttonGhostText}>24 小时后再提醒</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={handleAck}>
              <Text style={styles.buttonText}>我知道了</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,15,18,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: { width: '100%', maxWidth: 420, gap: 12, alignItems: 'center' },
  title: { color: '#fff', fontSize: 22, fontWeight: '600', textAlign: 'center' },
  body: { color: 'rgba(255,255,255,0.82)', fontSize: 14, lineHeight: 22, textAlign: 'center' },
  buttonsRow: { flexDirection: 'row', gap: 10, marginTop: 12, flexWrap: 'wrap', justifyContent: 'center' },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 9999,
    backgroundColor: '#fff',
  },
  buttonText: { color: '#111', fontSize: 14, fontWeight: '600' },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  buttonGhostText: { color: '#fff', fontSize: 14, fontWeight: '500' },
});
