import React from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { useVersionWelcome, type VersionWelcomeType } from '../context/VersionWelcomeContext';

const COPY: Record<VersionWelcomeType, { title: string; subtitle: string }> = {
  upgrade: {
    title: '欢迎升级',
    subtitle: '已更新到新版本，感谢使用 Flops。',
  },
  downgrade: {
    title: '版本已回退',
    subtitle: '当前为较早版本，如有问题可重新安装最新版。',
  },
};

export function VersionWelcomeScreen() {
  const { showWelcome, welcomeType, currentVersion, previousVersion, dismissWelcome } =
    useVersionWelcome();

  if (!showWelcome || !welcomeType) return null;

  const { title, subtitle } = COPY[welcomeType];

  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          <View style={styles.versionRow}>
            {previousVersion != null && (
              <Text style={styles.versionLabel}>上一版本：{previousVersion}</Text>
            )}
            <Text style={styles.versionLabel}>当前版本：{currentVersion}</Text>
          </View>
          <TouchableOpacity style={styles.btn} onPress={dismissWelcome} activeOpacity={0.8}>
            <Text style={styles.btnText}>进入</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 24,
    width: '100%',
    maxWidth: 320,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 15,
    color: '#475569',
    lineHeight: 22,
    marginBottom: 14,
  },
  versionRow: {
    marginBottom: 20,
  },
  versionLabel: {
    fontSize: 13,
    color: '#94a3b8',
    marginBottom: 4,
  },
  btn: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});
