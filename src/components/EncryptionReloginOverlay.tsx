/**
 * 加密体系升级提示：本机有 session 但没 K_user → 所有加密对话的 title / 消息
 * 都会回退到 server 的 "[encrypted ...]" sentinel，没法本地解。
 *
 * 触发条件：
 *  - SessionProvider 完成 restoreSession 后，session != null 且 getStoredKUser() == null
 *  - 这种情况只发生在「K_user 体系上线之前登录、之后 OTA / TestFlight 升级」的老用户
 *
 * 处理：弹一个非强制 Modal，主按钮 = 退出登录（按完去登录页，SRP 登录会自动落
 * 一份 K_user）。次按钮 = 24 小时后再提醒（防止打扰 / 暂时只是想看明文 session）。
 *
 * 跟 UpgradeRequiredOverlay 完全平行的设计，只是触发源不同。
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSession } from '../context/SessionContext';
import { getStoredKUser } from '../lib/kUserStorage';

const DEFER_STORAGE_KEY = 'flops_encryption_relogin_defer_until';
const DEFER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function EncryptionReloginOverlay(): React.ReactElement | null {
  const { session, logout } = useSession();
  const [needsRelogin, setNeedsRelogin] = useState(false);
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

  /** session 变了就重新探测一次。logout 后 session 变 null 会直接卸 overlay。 */
  useEffect(() => {
    let cancelled = false;
    if (!session) {
      setNeedsRelogin(false);
      return () => {
        cancelled = true;
      };
    }
    getStoredKUser()
      .then((v) => {
        if (cancelled) return;
        setNeedsRelogin(!v);
      })
      .catch(() => {
        if (!cancelled) setNeedsRelogin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) return null;
  if (!needsRelogin) return null;
  if (deferUntil && Date.now() < deferUntil) return null;
  if (!deferLoadedRef.current) return null;

  const handleDefer24h = async () => {
    const until = Date.now() + DEFER_WINDOW_MS;
    try {
      await AsyncStorage.setItem(DEFER_STORAGE_KEY, String(until));
    } catch {
      /* noop */
    }
    setDeferUntil(until);
    setNeedsRelogin(false);
  };

  const handleLogout = async () => {
    setNeedsRelogin(false);
    try {
      await logout();
    } catch {
      /* logout 失败不阻断 UI */
    }
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={handleDefer24h}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>需要重新登录以启用加密</Text>
          <Text style={styles.body}>
            你这台设备的会话是加密体系上线之前留下的，本地缺一份加密主密钥（K_user），
            导致对话标题 / 消息内容显示为「[encrypted …]」占位。
          </Text>
          <Text style={styles.body}>
            退出登录再用账号 / 密码登录一次即可，之后内容会自动本地解密。
          </Text>
          <View style={styles.buttonsRow}>
            <Pressable style={[styles.button, styles.buttonGhost]} onPress={handleDefer24h}>
              <Text style={styles.buttonGhostText}>24 小时后再提醒</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={handleLogout}>
              <Text style={styles.buttonText}>退出登录</Text>
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
