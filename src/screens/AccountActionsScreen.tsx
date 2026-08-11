/**
 * 账户操作子页：修改密码、绑定邮箱、绑定手机号、退出登录，从 Profile 进入。
 * 手机号一行仅在服务端 /api/auth/config 返回 sms_enabled 时出现。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import { getAuthConfig, getCurrentUserInfo } from '../api';

function createAccountActionsStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.backgroundSecondary },
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
    backBtn: { padding: 4 },
    headerTitle: { fontSize: 18, fontWeight: '700', color: c.textHeader },
    headerRight: { width: 32 },
    scroll: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 40 },
    section: {
      backgroundColor: c.surface,
      borderRadius: 12,
      overflow: 'hidden',
      marginBottom: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderMuted,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 12,
    },
    rowLabel: { flex: 1, fontSize: 16, color: c.textPrimary },
    rowValue: { fontSize: 14, color: c.textMuted, maxWidth: 180 },
    rowDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.borderMuted,
      marginLeft: 16,
    },
    logoutBtn: {
      backgroundColor: c.surface,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.roseBorder,
    },
    logoutBtnText: { fontSize: 16, fontWeight: '600', color: c.danger },
  });
}

export function AccountActionsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createAccountActionsStyles(colors), [colors]);
  const { session, serverBaseUrl, logout } = useSession();
  const [email, setEmail] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  // 服务端未开短信通道（未配 FLOPS_SMS_* 或未配 captcha）→ 整行不出现
  const [smsEnabled, setSmsEnabled] = useState(false);

  const refreshUserInfo = useCallback(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const info = await getCurrentUserInfo(serverBaseUrl, session.user_id, session.access_token);
      if (cancelled) return;
      const e = typeof info?.email === 'string' ? info.email.trim() : '';
      setEmail(e || null);
      const p = typeof info?.phone === 'string' ? info.phone.trim() : '';
      setPhone(p || null);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, serverBaseUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getAuthConfig(serverBaseUrl);
        if (!cancelled) setSmsEnabled(Boolean(cfg.sms_enabled));
      } catch {
        if (!cancelled) setSmsEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl]);

  useEffect(() => {
    refreshUserInfo();
  }, [refreshUserInfo]);

  // 从 BindEmailScreen / BindPhoneScreen 返回时刷新一次绑定信息展示
  useFocusEffect(
    useCallback(() => {
      refreshUserInfo();
    }, [refreshUserInfo])
  );

  const handleLogout = useCallback(() => {
    Alert.alert('退出登录', '确定要退出当前账号吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: async () => {
          await logout();
        },
      },
    ]);
  }, [logout]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="arrow-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>账户操作</Text>
        <View style={styles.headerRight} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('ChangePassword')}
          >
            <Ionicons name="key-outline" size={22} color={colors.textMuted} />
            <Text style={styles.rowLabel}>修改密码</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
          </TouchableOpacity>
          <View style={styles.rowDivider} />
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('BindEmail')}
          >
            <Ionicons name="mail-outline" size={22} color={colors.textMuted} />
            <Text style={styles.rowLabel}>{email ? '改绑邮箱' : '绑定邮箱'}</Text>
            {email ? (
              <Text style={styles.rowValue} numberOfLines={1} ellipsizeMode="middle">
                {email}
              </Text>
            ) : null}
            <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
          </TouchableOpacity>
          {smsEnabled ? (
            <>
              <View style={styles.rowDivider} />
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('BindPhone')}
              >
                <Ionicons name="phone-portrait-outline" size={22} color={colors.textMuted} />
                <Text style={styles.rowLabel}>{phone ? '改绑手机号' : '绑定手机号'}</Text>
                {phone ? (
                  <Text style={styles.rowValue} numberOfLines={1} ellipsizeMode="middle">
                    {phone}
                  </Text>
                ) : null}
                <Ionicons name="chevron-forward" size={20} color={colors.placeholder} />
              </TouchableOpacity>
            </>
          ) : null}
        </View>

        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={handleLogout}
          activeOpacity={0.8}
        >
          <Text style={styles.logoutBtnText}>退出登录</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
