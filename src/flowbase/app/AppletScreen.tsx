/**
 * AppletScreen —— 全屏「Applet」（类小程序）页面。
 *
 * 一个 Applet = 一个 FlowBase app（Agent 写的自包含 HTML+CSS+JS），此前只能在 FlowBaseScreen
 * 页内的 tab 里嵌入查看。本页把它独立成整页全屏承载，支持 deep-link 直达。
 *
 * 定位参数（route.params）：
 *   - appId    必填。app.id 全局唯一。
 *   - baseId?  选填。缺省时用反查端点 GET /apps/{app_id}/base 解析出所属 Base。
 *   - appName? 选填。仅用于顶栏标题（拿不到就显示「应用」）。
 *
 * 数据流：解析 baseId → 拉本 Base 的表（供 app 内 SDK 名字→id 解析）→ 全屏渲染 CustomAppWebView
 * （fillHeight，App 自己滚）。取数/鉴权仍走原生侧 token，App 内不直连后端（见 CustomAppWebView）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import type { RootStackParamList } from '../../navigation/types';
import { getAppBase, getBase } from '../api';
import type { Table } from '../types';
import { CustomAppWebView } from './CustomAppWebView';

type Nav = StackNavigationProp<RootStackParamList, 'Applet'>;
type Rt = RouteProp<RootStackParamList, 'Applet'>;

export function AppletScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { appId, baseId: baseIdParam, appName } = route.params;
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [baseId, setBaseId] = useState<string | null>(baseIdParam ?? null);
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!session) return;
      setLoading(true);
      setError(null);
      try {
        // 已知 base 直接用；否则反查 GET /apps/{app_id}/base 解析出所属 Base（404 → 抛错落到 catch）。
        const bId = baseIdParam ?? (await getAppBase(session, appId));
        // 载入本 Base 的表：CustomAppWebView 的 SDK RPC 用它把「表名」解析成 table_id。
        const { tables: tbls } = await getBase(session, bId);
        if (!alive) return;
        setBaseId(bId);
        setTables(tbls);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, appId, baseIdParam]);

  const title = appName || '应用';

  return (
    <View style={styles.container}>
      {/* 顶栏：返回 + 标题（右侧等宽占位保证标题居中） */}
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      {/* 主区：底部预留 home indicator 安全区（App 内容不压到手势条） */}
      <View style={[styles.body, { paddingBottom: insets.bottom }]}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.textMuted} />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={styles.hint}>{error}</Text>
          </View>
        ) : baseId ? (
          <CustomAppWebView baseId={baseId} appId={appId} tables={tables} fillHeight />
        ) : null}
      </View>
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderMuted,
      backgroundColor: c.background,
    },
    headerBtn: { width: 40, height: 34, alignItems: 'center', justifyContent: 'center' },
    title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: c.textPrimary },
    body: { flex: 1 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    hint: { fontSize: 13, color: c.placeholder },
  });
}
