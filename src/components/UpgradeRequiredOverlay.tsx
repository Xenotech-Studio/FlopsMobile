/**
 * 服务器返回 426 后弹 Modal——iOS / Android 体验一致，只是主按钮不同：
 *  - Android：「前往更新页」→ 跳 Profile，ProfileScreen 订阅同一总线会自动开 modal
 *  - iOS：暂无应用内升级（TestFlight / App Store 都还没上链接），只给「我知道了」
 *
 * 两端都给「24 小时后再提醒」让暂时没法 / 不想升级的用户能继续用。
 * 暂缓时间戳写 AsyncStorage，窗口内不再弹。
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
const IS_ANDROID = Platform.OS === 'android';

export function UpgradeRequiredOverlay(): React.ReactElement | null {
  const [detail, setDetail] = useState<ClientOutdatedDetail | null>(null);
  const [deferUntil, setDeferUntil] = useState<number>(0);
  const deferLoadedRef = useRef(false);

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

  if (!detail) return null;
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

  const handleGoToUpdatePage = () => {
    setDetail(null);
    try {
      if (navigationRef.isReady()) {
        navigationRef.navigate('Profile' as never);
      }
    } catch {
      /* ProfileScreen 自己也订阅总线：即使这里 navigate 失败，下次进 Profile 也会自动开 modal */
    }
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
            {IS_ANDROID
              ? '请前往更新页下载新版本。'
              : 'iOS 暂时只能通过 TestFlight / App Store 升级，等新版本铺到分发渠道后请第一时间更新。'}
          </Text>
          <View style={styles.buttonsRow}>
            <Pressable style={[styles.button, styles.buttonGhost]} onPress={handleDefer24h}>
              <Text style={styles.buttonGhostText}>24 小时后再提醒</Text>
            </Pressable>
            {IS_ANDROID ? (
              <Pressable style={styles.button} onPress={handleGoToUpdatePage}>
                <Text style={styles.buttonText}>前往更新页</Text>
              </Pressable>
            ) : (
              <Pressable style={styles.button} onPress={handleAck}>
                <Text style={styles.buttonText}>我知道了</Text>
              </Pressable>
            )}
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
