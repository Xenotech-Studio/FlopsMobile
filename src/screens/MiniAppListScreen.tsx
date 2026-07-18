/**
 * MiniAppListScreen —— 「我的小应用」列表（抽屉「小应用」入口跳入）。
 *
 * 类微信小程序：grid of icons。每条用 app 名称 + 图标展示；当前存的数据无图标 URL，
 * 统一用「名称首字符」占位（色块由 appId 稳定散列取色，视觉有区分）。点进 Applet 全屏页。
 * 列表来自 [[useMyApplets]]（AsyncStorage 持久化，add/remove 跨屏即时同步）。
 */
import React, { useMemo } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { HamburgerButton } from './shell/HamburgerButton';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { useMyApplets, type MyApplet } from '../hooks/useMyApplets';

// 抽屉内部页：navigate('Applet') 会从当前 navigator 冒泡到 RootStack（Applet 所在栈）解析。
type Nav = StackNavigationProp<RootStackParamList>;

const NUM_COLUMNS = 4;
const H_PADDING = 16;

// 图标占位色板：按 appId 稳定散列取一色，同一 app 每次同色。
const ICON_COLORS = ['#5b8def', '#f0883e', '#34c759', '#af52de', '#ff6482', '#00b8d4', '#ffb020', '#7c8aff'];
function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 2147483647;
  return ICON_COLORS[h % ICON_COLORS.length];
}
function initialFor(a: MyApplet): string {
  const s = (a.name || '').trim() || a.appId;
  return s.slice(0, 1).toUpperCase();
}

export function MiniAppListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { applets, loading } = useMyApplets();

  const cellW = (width - H_PADDING * 2) / NUM_COLUMNS;
  const iconSize = Math.min(60, cellW - 16);

  const renderItem = ({ item }: { item: MyApplet }) => (
    <TouchableOpacity
      style={[styles.cell, { width: cellW }]}
      activeOpacity={0.7}
      onPress={() =>
        navigation.navigate('Applet', { appId: item.appId, baseId: item.baseId, appName: item.name })
      }
    >
      <View style={[styles.icon, { width: iconSize, height: iconSize, backgroundColor: colorForId(item.appId) }]}>
        <Text style={[styles.iconText, { fontSize: iconSize * 0.42 }]}>{initialFor(item)}</Text>
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {(item.name || '').trim() || '未命名应用'}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* 顶栏对齐今日页：左上角汉堡（开抽屉）+ 居中标题；右侧等宽占位保证标题居中。 */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <HamburgerButton />
        <Text style={styles.headerTitle}>小应用</Text>
        <View style={styles.headerRightSpacer} />
      </View>

      {loading ? null : applets.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="apps-outline" size={40} color={colors.placeholder} />
          <Text style={styles.emptyText}>还没有添加小应用</Text>
          <Text style={styles.emptyHint}>打开一个手机版应用，在右上角菜单里「添加到我的小应用」</Text>
        </View>
      ) : (
        <FlatList
          data={applets}
          keyExtractor={(a) => a.appId}
          numColumns={NUM_COLUMNS}
          renderItem={renderItem}
          contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 32 }]}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.backgroundSecondary },
    // 今日页同款顶栏：hamburger | 居中标题 | 等宽右占位
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    headerTitle: { flex: 1, textAlign: 'center', fontSize: 20, fontWeight: '700', color: c.textHeader },
    headerRightSpacer: { width: HEADER_CIRCLE_BTN_SIZE },
    grid: { padding: H_PADDING },
    cell: { alignItems: 'center', marginBottom: 20 },
    icon: {
      borderRadius: 16,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconText: { color: '#fff', fontWeight: '700' },
    name: { marginTop: 6, fontSize: 12, color: c.textPrimary, textAlign: 'center', width: '100%', paddingHorizontal: 2 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
    emptyText: { fontSize: 15, fontWeight: '600', color: c.textSecondary },
    emptyHint: { fontSize: 13, color: c.placeholder, textAlign: 'center', lineHeight: 19 },
  });
}
