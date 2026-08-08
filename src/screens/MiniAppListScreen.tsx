/**
 * MiniAppListScreen —— 「我的小应用」列表（抽屉「小应用」入口跳入）。
 *
 * 类微信小程序：grid of icons。每条用 app 名称 + 图标展示。数据实时从服务端拉（getApp），
 * 优先显示 config.icon 对应的 Lucide SVG 图标；未设置则灰色首字符占位。点进 Applet 全屏页。
 * 列表来自 [[useMyApplets]]（AsyncStorage 持久化，只存 appId+baseId+addedAt）。
 */
import React, { useMemo, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useAppTheme } from '../context/ThemeContext';
import type { AppColors } from '../theme/appColors';
import type { RootStackParamList } from '../navigation/types';
import { HamburgerButton } from './shell/HamburgerButton';
import { HEADER_CIRCLE_BTN_SIZE } from '../theme/layout';
import { useMyApplets, type MyApplet } from '../hooks/useMyApplets';
import { getApp } from '../flowbase/api';
import { useSession } from '../context/SessionContext';
import type { App } from '../flowbase/types';
import { AppIcon } from '../components/AppIcons';

// 抽屉内部页：navigate('Applet') 会从当前 navigator 冒泡到 RootStack（Applet 所在栈）解析。
type Nav = StackNavigationProp<RootStackParamList>;

const NUM_COLUMNS = 4;
const H_PADDING = 16;

// 图标占位色：统一使用灰色（用户明确要求不要彩色）。
const ICON_COLOR = '#9e9e9e';

type AppItem = {
  myApplet: MyApplet;
  app: App | null;
  loading: boolean;
  error: string | null;
};

function initialFor(item: AppItem): string {
  const name = item.app?.name || item.myApplet.appId;
  return name.trim().slice(0, 1).toUpperCase();
}

export function MiniAppListScreen() {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { session } = useSession();
  const { applets, loading } = useMyApplets();
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const cellW = (width - H_PADDING * 2) / NUM_COLUMNS;
  const iconSize = Math.min(60, cellW - 16);

  // 每个 appId 的服务端拉取结果（成功=app，失败=error）。缺键 = 尚未拉到（loading）。
  // 关键：列表本身由 applets（AsyncStorage，本地可靠源）渲染，这里只做「富化」。
  // 这样 session 未就绪 / getApp 失败 / 网络慢 时列表也不会整屏空白 —— 只是图标/名称退化为占位。
  const [appResults, setAppResults] = useState<Record<string, { app: App | null; error: string | null }>>({});

  // 渲染数据永远与 applets 等长，杜绝「applets 非空但 items 为空 → 空白 grid」。
  const items = useMemo<AppItem[]>(
    () =>
      applets.map((my) => {
        const r = appResults[my.appId];
        return {
          myApplet: my,
          app: r?.app ?? null,
          loading: !r, // 还没有该 app 的拉取结果
          error: r?.error ?? null,
        };
      }),
    [applets, appResults]
  );

  const loadApps = async () => {
    if (!session) {
      // session 未就绪：静默等待（deps 里含 session，就绪后本 effect 会重跑）。列表仍由 applets 渲染。
      console.log('[MiniAppList] loadApps skipped: no session yet', { applets: applets.length });
      return;
    }
    console.log('[MiniAppList] loadApps start', {
      applets: applets.length,
      base: session.server_base_url,
      user: session.user_id,
    });
    await Promise.all(
      applets.map(async (my) => {
        try {
          const app = await getApp(session, my.baseId, my.appId);
          setAppResults((prev) => ({ ...prev, [my.appId]: { app, error: null } }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 之前这里被静默吞掉 —— Android 上 getApp 失败时列表整片空白且无任何日志。
          console.warn('[MiniAppList] getApp failed', { appId: my.appId, baseId: my.baseId, error: msg });
          setAppResults((prev) => ({ ...prev, [my.appId]: { app: null, error: msg } }));
        }
      })
    );
  };

  useFocusEffect(
    React.useCallback(() => {
      if (!loading) loadApps();
    }, [applets, loading, session])
  );

  const renderItem = ({ item }: { item: AppItem }) => {
    const app = item.app;
    const iconName = app?.config?.icon;
    const hasIcon = iconName && !item.loading;
    return (
      <TouchableOpacity
        style={[styles.cell, { width: cellW }]}
        activeOpacity={0.72}
        disabled={!app}
        onPress={() => nav.navigate('Applet', { baseId: item.myApplet.baseId, appId: item.myApplet.appId })}
      >
        <View style={[styles.icon, { width: iconSize, height: iconSize, backgroundColor: ICON_COLOR }]}>
          {item.loading ? (
            <Text style={[styles.iconText, { fontSize: iconSize * 0.42 }]}>…</Text>
          ) : hasIcon ? (
            <AppIcon name={iconName} size={iconSize * 0.55} color="#fff" />
          ) : (
            <Text style={[styles.iconText, { fontSize: iconSize * 0.42 }]}>{initialFor(item)}</Text>
          )}
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {item.loading ? '加载中…' : item.error ? '加载失败' : app?.name || item.myApplet.appId.slice(0, 6)}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 10 }]}>
      <View style={styles.topBar}>
        <HamburgerButton />
        <Text style={styles.headerTitle}>小应用</Text>
        <View style={styles.headerRightSpacer} />
      </View>
      {loading ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>加载中…</Text>
        </View>
      ) : applets.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="apps-outline" size={40} color={colors.placeholder} />
          <Text style={styles.emptyText}>还没有小应用</Text>
          <Text style={styles.emptyHint}>
            打开任意手机版应用，点右上角胶囊菜单，选择「添加到我的小应用」
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          renderItem={renderItem}
          keyExtractor={(it) => it.myApplet.appId}
          numColumns={NUM_COLUMNS}
          columnWrapperStyle={{ gap: 0 }}
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
