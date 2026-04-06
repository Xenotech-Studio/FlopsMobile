import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { useVersionWelcome, type VersionWelcomeType } from '../context/VersionWelcomeContext';
import { getChangelogChanges } from '../changelog';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';

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
  const { colors } = useAppTheme();
  const styles = useMemo(() => createVersionWelcomeStyles(colors), [colors]);
  const { showWelcome, welcomeType, currentVersion, previousVersion, dismissWelcome } =
    useVersionWelcome();

  if (!showWelcome || !welcomeType) return null;

  const { title, subtitle } = COPY[welcomeType];
  const changes = welcomeType === 'upgrade' ? getChangelogChanges(currentVersion) : [];

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
          {welcomeType === 'upgrade' && (
            <View style={styles.changelog}>
              <Text style={styles.changelogTitle}>本次更新</Text>
              {changes.length > 0 ? (
                changes.map((line, idx) => (
                  <View key={`${idx}-${line}`} style={styles.changelogItem}>
                    <Text style={styles.changelogBullet}>•</Text>
                    <Text style={styles.changelogText}>{line}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.changelogEmpty}>暂无更新说明</Text>
              )}
            </View>
          )}
          <TouchableOpacity style={styles.btn} onPress={dismissWelcome} activeOpacity={0.8}>
            <Text style={styles.btnText}>进入</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function createVersionWelcomeStyles(c: AppColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: c.modalBackdrop,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      padding: 24,
      width: '100%',
      maxWidth: 320,
      borderWidth: 1,
      borderColor: c.borderMuted,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textHeader,
      marginBottom: 10,
    },
    subtitle: {
      fontSize: 15,
      color: c.textSecondary,
      lineHeight: 22,
      marginBottom: 14,
    },
    versionRow: {
      marginBottom: 20,
    },
    versionLabel: {
      fontSize: 13,
      color: c.textMuted,
      marginBottom: 4,
    },
    changelog: {
      marginBottom: 18,
    },
    changelogTitle: {
      fontSize: 14,
      fontWeight: '700',
      color: c.textHeader,
      marginBottom: 10,
    },
    changelogItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: 8,
    },
    changelogBullet: {
      width: 14,
      color: c.textMutedSlate,
      lineHeight: 20,
    },
    changelogText: {
      flex: 1,
      fontSize: 14,
      color: c.textSecondary,
      lineHeight: 20,
    },
    changelogEmpty: {
      fontSize: 13,
      color: c.placeholder,
    },
    btn: {
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
    },
    btnText: {
      fontSize: 16,
      fontWeight: '600',
      color: c.onPrimary,
    },
  });
}
