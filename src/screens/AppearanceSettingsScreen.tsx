/**
 * 外观：浅色 / 深色 / 跟随系统
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { RootStackParamList } from '../navigation/types';
import {
  useAppTheme,
  themePreferenceLabels,
  type ThemePreference,
} from '../context/ThemeContext';
import { shadowSoftSubtle } from '../theme/shadows';

const OPTIONS: ThemePreference[] = ['system', 'light', 'dark'];

export function AppearanceSettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { preference, setPreference, colors } = useAppTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.backgroundSecondary }]} edges={['bottom']}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 8,
            backgroundColor: colors.headerBarBackground,
            borderBottomWidth: colors.headerBarBottomBorderWidth,
            borderBottomColor: colors.headerBarBottomBorderColor,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textHeader }]}>外观</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.hint, { color: colors.textMuted }]}>
          选择应用界面是始终浅色、始终深色，还是随系统设置自动切换。
        </Text>
        <View style={[styles.card, { backgroundColor: colors.surface }, shadowSoftSubtle]}>
          {OPTIONS.map((key, index) => {
            const selected = preference === key;
            return (
              <TouchableOpacity
                key={key}
                style={[
                  styles.row,
                  index > 0 && { borderTopWidth: 1, borderTopColor: colors.surfaceMuted },
                ]}
                onPress={() => setPreference(key)}
                activeOpacity={0.7}
              >
                <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>
                  {themePreferenceLabels[key]}
                </Text>
                {selected ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                ) : (
                  <View style={styles.radioOuter}>
                    <View style={[styles.radioInner, { borderColor: colors.border }]} />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
  },
  backBtn: { padding: 8, width: 40 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700' },
  headerSpacer: { width: 40 },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  hint: { fontSize: 14, lineHeight: 20, marginBottom: 16 },
  card: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  rowLabel: { fontSize: 16 },
  radioOuter: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, backgroundColor: 'transparent' },
});
