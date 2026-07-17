/**
 * AppletScreen —— 全屏「Applet」（类小程序）页面。
 *
 * 一个 Applet = 一个 FlowBase app（Agent 写的自包含 HTML+CSS+JS），此前只能在 FlowBaseScreen
 * 页内的 tab 里嵌入查看。本页把它独立成整页全屏承载，支持 deep-link 直达。
 *
 * 设计要点：
 *   - **全屏无顶栏**：app HTML 从屏幕顶到底零边距铺满（含状态栏 / home indicator 区域）。安全区
 *     由 app 自己经父页注入的 `--fb-safe-area-*` CSS 变量 / `FlowBaseSDK.device` 处理，RN 层不再
 *     额外让位（不加 header、不加 safe-area padding）。
 *   - **右上角悬浮胶囊**：外观一比一对齐桌面版 AppView 的手机胶囊（宽 87×高 32、半透明深色 + 细白描边、
 *     左三圆点 | 竖线 | 右圆环）。位于安全区顶 + 15、右 12。真机上真交互：点三圆点开合菜单（关闭 / 预留
 *     「其他」）、点圆环直接关闭 applet（goBack）——区别于桌面那份 pointerEvents:none 的纯装饰件。
 *
 * 定位参数（route.params）：
 *   - appId    必填。app.id 全局唯一。
 *   - baseId?  选填。缺省时用反查端点 GET /apps/{app_id}/base 解析出所属 Base。
 *
 * 数据流：解析 baseId → 拉本 Base 的表（供 app 内 SDK 名字→id 解析）→ 全屏渲染 CustomAppWebView
 * （fillHeight）。取数/鉴权仍走原生侧 token，App 内不直连后端（见 CustomAppWebView）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import type { AppColors } from '../../theme/appColors';
import { shadowSheet } from '../../theme/shadows';
import type { RootStackParamList } from '../../navigation/types';
import { getAppBase, getBase } from '../api';
import type { Table } from '../types';
import { CustomAppWebView, type FlowBaseDevice } from './CustomAppWebView';
// iOS 原生胶囊（CALayer 绘制，避免 RN borderWidth:0.5 + overflow 的锯齿）；Android 走下方 RN 兜底。
import AppletCapsuleView from '../../flowdoc-native-input/spec/AppletCapsuleViewNativeComponent';

type Nav = StackNavigationProp<RootStackParamList, 'Applet'>;
type Rt = RouteProp<RootStackParamList, 'Applet'>;

// 胶囊外观对齐桌面版 AppView 的手机胶囊（AppView.jsx 的 CAPSULE_W/H + phoneCapsule 样式）。
// 桌面那份是 pointerEvents:none 的装饰件；这里真机上可交互（三点开菜单、圆环关闭）。
const CAPSULE_W = 87;
const CAPSULE_H = 32;
const CAPSULE_GAP_TOP = 15; // 胶囊上沿距安全区顶的间隙（与桌面模拟器 CAPSULE_GAP_TOP 一致）
const CAPSULE_GAP_RIGHT = 12; // 胶囊右端距屏幕右沿的间隙（= capsule 样式的 right；device.capsule 与之同源）
// 胶囊半块底色：常态半透明深色，按下整块加深（图标色不动，靠背景变暗给「整块按下」质感）。
const CAPSULE_BG = 'rgba(0,0,0,0.28)';
const CAPSULE_BG_PRESSED = 'rgba(0,0,0,0.5)';

export function AppletScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { appId, baseId: baseIdParam } = route.params;
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [baseId, setBaseId] = useState<string | null>(baseIdParam ?? null);
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const capsuleTop = insets.top + CAPSULE_GAP_TOP;

  // 传给 WebView 的真实设备信息（安全区 / 胶囊 / DPR）——注入到 app 的 --fb-* / FlowBaseSDK.device。
  // 坐标系与桌面版一致：capsule.top 相对安全区顶、left/right 为距屏幕左沿的 x（与胶囊实际渲染同源）。
  const { width: winW } = useWindowDimensions();
  const device = useMemo<FlowBaseDevice>(
    () => ({
      env: 'native',
      pixelRatio: PixelRatio.get(),
      safeAreaInsets: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
      statusBarHeight: insets.top,
      homeIndicatorHeight: insets.bottom,
      keyboardHeight: 0,
      capsule: {
        top: CAPSULE_GAP_TOP,
        height: CAPSULE_H,
        left: winW - CAPSULE_GAP_RIGHT - CAPSULE_W,
        right: winW - CAPSULE_GAP_RIGHT,
        width: CAPSULE_W,
      },
    }),
    [insets.top, insets.right, insets.bottom, insets.left, winW],
  );

  return (
    <View style={styles.container}>
      {/* 全屏 app：零到零铺满，安全区由 app 自己经 --fb-* / FlowBaseSDK.device 处理，RN 层不让位 */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.hint}>{error}</Text>
        </View>
      ) : baseId ? (
        <CustomAppWebView baseId={baseId} appId={appId} tables={tables} fillHeight device={device} />
      ) : null}

      {/* 右上角悬浮胶囊。iOS 走原生 CALayer 组件（无锯齿/毛边）；Android 走 RN 兜底。
          左半（三圆点）→ 弹出底部菜单 sheet；右半（圆环）→ 关闭 applet。 */}
      {Platform.OS === 'ios' ? (
        <AppletCapsuleView
          style={[styles.capsuleNative, { top: capsuleTop }]}
          onPressLeft={() => setMenuOpen(true)}
          onPressRight={() => navigation.goBack()}
        />
      ) : (
        <View style={[styles.capsule, { top: capsuleTop }]} pointerEvents="auto">
          {/* 左格：三圆点 → 弹出底部菜单 sheet */}
          <Pressable
            style={({ pressed }) => [styles.capsuleCell, { backgroundColor: pressed ? CAPSULE_BG_PRESSED : CAPSULE_BG }]}
            onPress={() => setMenuOpen(true)}
          >
            <View style={styles.capsuleDots}>
              <View style={styles.capsuleDot} />
              <View style={styles.capsuleDot} />
              <View style={styles.capsuleDot} />
            </View>
          </Pressable>
          {/* 右格：圆环 → 直接关闭 applet */}
          <Pressable
            style={({ pressed }) => [styles.capsuleCell, { backgroundColor: pressed ? CAPSULE_BG_PRESSED : CAPSULE_BG }]}
            onPress={() => navigation.goBack()}
          >
            <View style={styles.capsuleRing}>
              <View style={styles.capsuleRingDot} />
            </View>
          </Pressable>
          {/* 中缝分隔竖线：绝对居中叠在两半之上，不拦点击 */}
          <View style={styles.capsuleDivider} pointerEvents="none" />
        </View>
      )}

      {/* 三圆点弹出的底部菜单（项目通用 @gorhom BottomSheetModal 同款）：关闭 + 预留「其他」 */}
      <AppletMenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onCloseApplet={() => {
          setMenuOpen(false);
          navigation.goBack();
        }}
      />
    </View>
  );
}

/**
 * AppletMenuSheet —— 三圆点弹出的底部菜单，走项目通用的 @gorhom/bottom-sheet BottomSheetModal
 * 同款交互（visible 控制 present/dismiss + BottomSheetBackdrop 点击关闭，与 ModelSelectSheet 等一致）。
 * 需 App.tsx 的 BottomSheetModalProvider 祖先（已具备）。菜单项：关闭 / 预留「其他」。
 */
function AppletMenuSheet({
  visible,
  onClose,
  onCloseApplet,
}: {
  visible: boolean;
  onClose: () => void;
  onCloseApplet: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createSheetStyles(colors), [colors]);
  const modalRef = useRef<BottomSheetModal>(null);

  useEffect(() => {
    if (visible) modalRef.current?.present();
    else modalRef.current?.dismiss();
  }, [visible]);

  const handleChange = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose],
  );
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={colors.bottomSheetBackdropOpacity}
        pressBehavior="close"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
      />
    ),
    [colors.bottomSheetBackdropOpacity],
  );

  const items: Array<{ key: string; label: string; icon: string; run: () => void }> = [
    { key: 'close', label: '关闭', icon: 'close-outline', run: onCloseApplet },
    // 预留入口：后续可挂分享 / 关于 / 设置等；当前占位（只收起 sheet）。
    { key: 'more', label: '其他', icon: 'ellipsis-horizontal', run: onClose },
  ];

  return (
    <BottomSheetModal
      ref={modalRef}
      index={0}
      enableDynamicSizing
      onChange={handleChange}
      onDismiss={onClose}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={[styles.sheetBg, styles.sheetShadow]}
      handleIndicatorStyle={styles.handle}
    >
      <BottomSheetView style={[styles.content, { paddingBottom: insets.bottom + 12 }]}>
        {items.map((it) => (
          <TouchableOpacity key={it.key} style={styles.row} activeOpacity={0.6} onPress={it.run}>
            <Ionicons name={it.icon} size={20} color={colors.textPrimary} />
            <Text style={styles.rowText}>{it.label}</Text>
          </TouchableOpacity>
        ))}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    // 加载/错误占位铺满全屏（无 header，故整屏居中）
    centered: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 32 },
    hint: { fontSize: 13, color: c.placeholder },
    // 右上角悬浮胶囊：宽胶囊，半透明深色底 + 细白描边；左格三圆点 / 右格圆环，中间竖线分隔。
    // 尺寸/配色一比一对齐桌面版 AppView 的 phoneCapsule。
    // iOS 原生胶囊：RN 只负责定位与尺寸，视觉（底色/圆点/圆环/边框/按下变暗）全在 native 画。
    capsuleNative: { position: 'absolute', right: CAPSULE_GAP_RIGHT, width: CAPSULE_W, height: CAPSULE_H, zIndex: 20 },
    // 底色不放这里：由左右两半 Pressable 各自铺（含按下变暗）；两半 flush 相接铺满整块（含中缝），无缝隙。
    capsule: {
      position: 'absolute',
      right: CAPSULE_GAP_RIGHT,
      width: CAPSULE_W,
      height: CAPSULE_H,
      borderRadius: CAPSULE_H / 2,
      borderWidth: 0.5,
      borderColor: 'rgba(255,255,255,0.28)',
      flexDirection: 'row',
      alignItems: 'stretch',
      overflow: 'hidden',
      zIndex: 20,
    },
    // 左右等宽格子：各自 flush 填满半边（含底色，由 Pressable 动态设），内容居中
    capsuleCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    capsuleDots: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    capsuleDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.9)' },
    // 中缝竖线：绝对居中叠在两半之上（两半 flush 无 flex 间隙 → 中缝不会透出下层 app）
    capsuleDivider: {
      position: 'absolute',
      top: (CAPSULE_H - 18) / 2,
      left: '50%',
      marginLeft: -0.5,
      width: 1,
      height: 18,
      backgroundColor: 'rgba(255,255,255,0.28)',
    },
    // 圆环（关闭图标）：外圈描边 + 中心实心点，等效桌面版 SVG（r7.25 stroke1.5 / r3.3 fill）
    capsuleRing: {
      width: 15,
      height: 15,
      borderRadius: 7.5,
      borderWidth: 1.5,
      borderColor: 'rgba(255,255,255,0.9)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    capsuleRingDot: { width: 6.5, height: 6.5, borderRadius: 3.25, backgroundColor: 'rgba(255,255,255,0.9)' },
  });
}

// 底部菜单 sheet 样式（对齐项目通用 sheet：圆角顶 + shadowSheet + 灰 grip 条）
function createSheetStyles(c: AppColors) {
  return StyleSheet.create({
    sheetBg: { backgroundColor: c.surface, borderTopLeftRadius: 32, borderTopRightRadius: 32 },
    sheetShadow: { ...shadowSheet },
    handle: { backgroundColor: c.borderD5, width: 36 },
    content: { paddingTop: 8 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, gap: 12 },
    rowText: { fontSize: 16, color: c.textPrimary },
  });
}
