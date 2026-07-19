/**
 * AppletScreen —— 全屏「Applet」（类小程序）页面 + 内嵌页栈（原生翻页）。
 *
 * 一个 Applet = 一个 FlowBase app（Agent 写的自包含 HTML+CSS+JS），此前只能在 FlowBaseScreen
 * 页内的 tab 里嵌入查看。本页把它独立成整页全屏承载，支持 deep-link 直达。
 *
 * 设计要点：
 *   - **全屏无顶栏**：app HTML 从屏幕顶到底零边距铺满（含状态栏 / home indicator 区域）。安全区
 *     由 app 自己经父页注入的 `--fb-safe-area-*` CSS 变量 / `FlowBaseSDK.device` 处理，RN 层不再
 *     额外让位（不加 header、不加 safe-area padding）。
 *   - **右上角悬浮胶囊（固定在 applet 外壳层）**：外观一比一对齐桌面版 AppView 的手机胶囊（宽 87×高 32、
 *     半透明深色 + 细白描边、左三圆点 | 竖线 | 右圆环）。位于安全区顶 + 15、右 12。**恒定不变**：作为
 *     AppletScreen 里 Navigator 的兄弟节点绝对定位悬浮（box-none 盖在整个页栈之上），压子页时不动、不重建
 *     —— 对齐微信小程序。真机上真交互：点三圆点开合菜单（加入我的小应用 / 关闭 / 预留「其他」）、点圆环直接
 *     关闭整个 applet（goBack）——区别于桌面那份 pointerEvents:none 的纯装饰件。
 *   - **原生翻页（类微信小程序页栈）**：本页内建一个嵌套 Stack。首屏 `AppletMain` 跑主 WebView；App 内调
 *     `FlowBaseSDK.navigate('page',{title})` 会 push 一层 `AppletPage`——另起一个 WebView 实例载入同一份
 *     HTML，但以 `initialPage=page` 决定首屏 div。全屏沉浸式（headerShown:false），返回由 iOS 右滑手势 +
 *     应用自己的 HTML 返回按钮承担。子页也能继续 `navigate` 往更深压栈。
 *     取一个新 WebView 实例载页是可接受的取舍（见需求约束）。
 *
 * 定位参数（route.params）：
 *   - appId    必填。app.id 全局唯一。
 *   - baseId?  选填。缺省时用反查端点 GET /apps/{app_id}/base 解析出所属 Base。
 *
 * 数据流：解析 baseId → 拉本 Base 的表（供 app 内 SDK 名字→id 解析）+ app 设置（disableBackSwipe）→
 * 经 [[AppletContext]] 下发给页栈两屏 → 全屏渲染 CustomAppWebView（fillHeight）。取数/鉴权仍走原生侧
 * token，App 内不直连后端（见 CustomAppWebView）。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  createStackNavigator,
  type StackCardInterpolationProps,
  type StackNavigationProp,
} from '@react-navigation/stack';
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
import { getApp, getAppBase, getBase } from '../api';
import type { Table } from '../types';
import { CustomAppWebView, type FlowBaseDevice } from './CustomAppWebView';
import { useMyApplets } from '../../hooks/useMyApplets';
// iOS 原生胶囊（CALayer 绘制，避免 RN borderWidth:0.5 + overflow 的锯齿）；Android 走下方 RN 兜底。
import AppletCapsuleView from '../../flowdoc-native-input/spec/AppletCapsuleViewNativeComponent';

type Nav = StackNavigationProp<RootStackParamList, 'Applet'>;
type Rt = RouteProp<RootStackParamList, 'Applet'>;

/** Applet 内建页栈：AppletMain=主页；AppletPage=原生子页（携 page/title）。 */
type AppletStackParamList = {
  AppletMain: undefined;
  AppletPage: { page?: string; title?: string };
};
const AppletStack = createStackNavigator<AppletStackParamList>();
type PageNav = StackNavigationProp<AppletStackParamList>;
type PageRt = RouteProp<AppletStackParamList, 'AppletPage'>;

/** 子页右滑入（与账户操作页 / 文档预览一致）：从屏幕右缘平移进入。 */
function rightCardStyleInterpolator({ current, layouts }: StackCardInterpolationProps) {
  return {
    cardStyle: {
      transform: [
        {
          translateX: current.progress.interpolate({
            inputRange: [0, 1],
            outputRange: [layouts.screen.width, 0],
          }),
        },
      ],
    },
  };
}

/**
 * AppletContext —— 页栈两屏（主页 / 子页）共享的承载态：Base/表/设备/设置 + applet 级操作。
 * baseId/tables/device 由外层 AppletScreen 解析后下发；两屏各自 new 一个 CustomAppWebView 复用同一份。
 */
type AppletCtx = {
  baseId: string;
  appId: string;
  tables: Table[];
  device: FlowBaseDevice;
  /** app 配置：禁用 iOS 左缘右滑返回（子页据此关手势）。 */
  disableBackSwipe: boolean;
  /** 「我的小应用」：主页菜单用。 */
  added: boolean;
  canAdd: boolean;
  onAdd: () => void;
  /** 关闭整个 applet（把 Applet 路由弹出 RootStack）——胶囊圆环 / 菜单「关闭」用。 */
  closeApplet: () => void;
  /** WebView key：调 reloadKey++ 令 WebView 重新挂载，实现「重新进入」。 */
  reloadKey: number;
};
const AppletContext = createContext<AppletCtx | null>(null);
function useApplet(): AppletCtx {
  const c = useContext(AppletContext);
  if (!c) throw new Error('useApplet must be used within AppletContext');
  return c;
}

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
  const { appId, baseId: baseIdParam, appName } = route.params;
  const { session } = useSession();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [baseId, setBaseId] = useState<string | null>(baseIdParam ?? null);
  const [tables, setTables] = useState<Table[]>([]);
  const [disableBackSwipe, setDisableBackSwipe] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 「我的小应用」：sheet 里的添加/已添加状态与操作。baseId 用解析后的值（非 param），未解析时不可加。
  const { has, add } = useMyApplets();
  const added = has(appId);
  const onAdd = useCallback(() => {
    if (!baseId) return;
    add({ appId, baseId }).catch(() => {});
  }, [add, appId, baseId, appName]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!session) return;
      setLoading(true);
      setError(null);
      try {
        // 已知 base 直接用；否则反查 GET /apps/{app_id}/base 解析出所属 Base（404 → 抛错落到 catch）。
        const bId = baseIdParam ?? (await getAppBase(session, appId));
        // 并行：本 Base 的表（SDK RPC 名字→id 解析用）+ app 详情（读 settings.disableBackSwipe 供子页手势）。
        const [{ tables: tbls }, app] = await Promise.all([getBase(session, bId), getApp(session, bId, appId)]);
        if (!alive) return;
        setBaseId(bId);
        setTables(tbls);
        setDisableBackSwipe(!!app.config?.settings?.disableBackSwipe);
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

  // 关闭整个 applet = 把 Applet 路由弹出 RootStack（无论当前在页栈第几层）。
  const closeApplet = useCallback(() => navigation.goBack(), [navigation]);

  // 永远禁止外层 RootStack 对 Applet 的手势关闭——页栈内部的返回手势由内层 Stack 独享。
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: false });
  }, [navigation]);

  // 三圆点弹出的菜单开合。胶囊固定在 applet 外壳层，故菜单态也提到本层。
  const [menuOpen, setMenuOpen] = useState(false);

  // 「重新进入小应用」→ bump WebView key 令其完全重新挂载。
  const [reloadKey, setReloadKey] = useState(0);
  const onReload = useCallback(() => setReloadKey(k => k + 1), []);

  const ctx = useMemo<AppletCtx | null>(
    () =>
      baseId
        ? { baseId, appId, tables, device, disableBackSwipe, added, canAdd: true, onAdd, closeApplet, reloadKey }
        : null,
    [baseId, appId, tables, device, disableBackSwipe, added, onAdd, closeApplet, reloadKey],
  );

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      </View>
    );
  }
  if (error || !ctx) {
    return (
      <View style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.hint}>{error || '应用不存在'}</Text>
        </View>
      </View>
    );
  }

  // 内建页栈：主页 + 原生子页。detachInactiveScreens=false → push 子页时主页 WebView 保持挂载（状态不丢）。
  //
  // 胶囊固定在 applet 外壳层（Navigator 的兄弟节点，绝对定位悬浮层），而非放进页栈每屏 —— 对齐微信小程序：
  // 压子页时胶囊不动、不重建，恒为「左三圆点(开菜单) | 右圆环(关整个 applet)」。子页返回改由原生 Stack header
  // 全屏沉浸式（headerShown:false），返回由 iOS 右滑手势 + app 自己的 HTML 返回按钮承担，胶囊不参与导航。
  return (
    <AppletContext.Provider value={ctx}>
      <View style={styles.container}>
        <AppletStack.Navigator
          detachInactiveScreens={false}
          screenOptions={{
            headerShown: false,
            cardStyle: { backgroundColor: colors.background },
            cardStyleInterpolator: rightCardStyleInterpolator,
          }}
        >
          <AppletStack.Screen name="AppletMain" component={AppletMainScreen} options={{ gestureEnabled: false }} />
          <AppletStack.Screen
            name="AppletPage"
            component={AppletPageScreen}
            options={({ route }) => ({
              gestureEnabled: true,
              headerShown: false,
              title: route.params?.title ?? '',
            })}
          />
        </AppletStack.Navigator>

        {/* 胶囊固定悬浮层：盖在整个页栈之上；box-none → 除胶囊本体外的点击穿透给下方 WebView。 */}
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <AppletCapsule onPressLeft={() => setMenuOpen(true)} onPressRight={closeApplet} styles={styles} />
        </View>

        {/* 三圆点弹出的底部菜单（项目通用 @gorhom BottomSheetModal 同款）：添加/已添加 + 关闭 + 预留「其他」 */}
        <AppletMenuSheet
          visible={menuOpen}
          onClose={() => setMenuOpen(false)}
          onCloseApplet={() => {
            setMenuOpen(false);
            closeApplet();
          }}
          added={added}
          canAdd={ctx.canAdd}
          onAdd={onAdd}
          onReload={() => {
            setMenuOpen(false);
            onReload();
          }}
        />
      </View>
    </AppletContext.Provider>
  );
}

/**
 * AppletMainScreen —— 页栈首屏。跑主 WebView（无 initialPage）；App 内 `navigate` → push 一层子页。
 * 胶囊 / 菜单不在本屏 —— 已提到 applet 外壳层（AppletScreen）固定悬浮，压子页时不动、不重建。
 */
function AppletMainScreen() {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const nav = useNavigation<PageNav>();
  const { baseId, appId, tables, device, reloadKey } = useApplet();

  // App 内 FlowBaseSDK.navigate('page',{title}) → push 一层原生子页（右滑入 + 原生返回）。
  const onNavigate = useCallback(
    (args: { page?: string; title?: string }) => nav.push('AppletPage', { page: args.page, title: args.title }),
    [nav],
  );

  return (
    <View style={styles.container}>
      <CustomAppWebView baseId={baseId} appId={appId} tables={tables} fillHeight device={device} onNavigate={onNavigate} key={String(reloadKey)} />
    </View>
  );
}

/**
 * AppletPageScreen —— 原生子页。另起一个 WebView 实例，以 route.params.page 作 initialPage。
 * 全屏沉浸式（headerShown:false），返回由 iOS 右滑手势 + app HTML 内自己画的返回按钮承担。
 */
function AppletPageScreen() {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const nav = useNavigation<PageNav>();
  const route = useRoute<PageRt>();
  const { page } = route.params || {};
  const { baseId, appId, tables, device } = useApplet();

  // 子页也能继续 navigate → 再 push 一层（类微信小程序层层深入）。
  const onNavigate = useCallback(
    (args: { page?: string; title?: string }) => nav.push('AppletPage', { page: args.page, title: args.title }),
    [nav],
  );

  return (
    <View style={styles.container}>
      <CustomAppWebView
        baseId={baseId}
        appId={appId}
        tables={tables}
        fillHeight
        device={device}
        initialPage={page}
        onNavigate={onNavigate}
      />
    </View>
  );
}

/**
 * AppletCapsule —— 右上角悬浮胶囊。固定在 applet 外壳层（不随页栈变化）：左半恒为三圆点（开菜单：关闭 /
 * 加入我的小应用 / 其他）、右半恒为圆环（直接关整个 applet）。子页返回由原生 Stack header 负责，与胶囊无关。
 * iOS 走原生 CALayer 组件（无锯齿）；Android 走 RN 兜底。
 */
function AppletCapsule({
  onPressLeft,
  onPressRight,
  styles,
}: {
  onPressLeft: () => void;
  onPressRight: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  const insets = useSafeAreaInsets();
  const capsuleTop = insets.top + CAPSULE_GAP_TOP;

  // iOS：原生胶囊（左三圆点 / 右圆环，视觉全在 native 画）。
  if (Platform.OS === 'ios') {
    return (
      <AppletCapsuleView
        style={[styles.capsuleNative, { top: capsuleTop }]}
        onPressLeft={onPressLeft}
        onPressRight={onPressRight}
      />
    );
  }

  // RN 兜底（Android）：左半三圆点，右半圆环。
  return (
    <View style={[styles.capsule, { top: capsuleTop }]} pointerEvents="auto">
      <Pressable
        style={({ pressed }) => [styles.capsuleCell, { backgroundColor: pressed ? CAPSULE_BG_PRESSED : CAPSULE_BG }]}
        onPress={onPressLeft}
      >
        <View style={styles.capsuleDots}>
          <View style={styles.capsuleDot} />
          <View style={styles.capsuleDot} />
          <View style={styles.capsuleDot} />
        </View>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.capsuleCell, { backgroundColor: pressed ? CAPSULE_BG_PRESSED : CAPSULE_BG }]}
        onPress={onPressRight}
      >
        <View style={styles.capsuleRing}>
          <View style={styles.capsuleRingDot} />
        </View>
      </Pressable>
      {/* 中缝分隔竖线：绝对居中叠在两半之上，不拦点击 */}
      <View style={styles.capsuleDivider} pointerEvents="none" />
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
  added,
  canAdd,
  onAdd,
  onReload,
}: {
  visible: boolean;
  onClose: () => void;
  onCloseApplet: () => void;
  /** 是否已加入「我的小应用」 */
  added: boolean;
  /** baseId 已解析、可添加（未解析且未添加时不显示添加项） */
  canAdd: boolean;
  onAdd: () => void;
  onReload: () => void;
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

  const items: Array<{ key: string; label: string; icon: string; run: () => void }> = [];
  // 「添加到我的小应用」/「已添加到我的小应用」——已添加显示为状态（点击仅收起）；未添加且可加则可点击添加。
  if (added) {
    items.push({ key: 'added', label: '已添加到我的小应用', icon: 'checkmark-circle', run: onClose });
  } else if (canAdd) {
    items.push({
      key: 'add',
      label: '添加到我的小应用',
      icon: 'add-circle-outline',
      run: () => {
        onAdd();
        onClose();
      },
    });
  }
  items.push({ key: 'close', label: '关闭', icon: 'close-outline', run: onCloseApplet });
  items.push({ key: 'reload', label: '重新进入小应用', icon: 'refresh', run: onReload });

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
