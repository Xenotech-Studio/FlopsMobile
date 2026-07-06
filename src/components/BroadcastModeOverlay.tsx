/**
 * 播报模式沉浸式 UI —— app 级全局 overlay（跨所有页面生效）。
 *
 * 挂在 SessionProvider 内、NavigationContainer 之上（与 UpgradeRequiredOverlay 同级），
 * 只要 tts_broadcast_mode 开着就常驻：给整屏套一圈明显黑边 + 底部「语音播报中」横条，
 * 让用户在任何页面都能一眼看出正处于播报态，并随手退出。
 *
 * 不用 Modal（会吞掉全部触摸、挡死底层 app）；改用 absolute overlay + pointerEvents='box-none'：
 *  - 外层 box-none：空白处触摸穿透到底层页面，app 照常可用；
 *  - 黑边框 pointerEvents='none'：纯装饰，永不拦截；
 *  - 底部横条 pointerEvents='auto'：承接退出按钮点击。
 *
 * 只碰 UI / JS：退出走既有 disableBroadcastMode()（本地断流 + 写回 layout-preferences），
 * 不触碰原生层。
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import { disableBroadcastMode, useBroadcastMode } from '../audio/ttsRealtime';
import { getScreenCornerRadiusSync, inferScreenCornerRadius } from '../utils/screenInfo';

/** 边框粗细（"明显黑色边框"）。 */
const BORDER_WIDTH = 5;
/**
 * 底部横条高度（贴屏幕最底部、覆盖安全区）。比原先小一档，配合 BAR_CONTENT_GAP 让横条不贴死内容。
 */
const BAR_HEIGHT = 46;
/**
 * 横条顶沿与页面内容底部之间的额外留白：BroadcastInsetProvider 顶高 inset 时叠加，避免内容紧贴横条。
 */
const BAR_CONTENT_GAP = 10;
/** 播报态强调色（暖橙，区别于常规 UI）。 */
const ACCENT = '#FF8A34';
/**
 * 边框侧边"收进"底部横条时的内凹圆角半径（dp）。
 * 这是本次要修的关键：左下 / 右下两处，5px 竖边框与横条顶沿相交的直角内角，用它抹成圆弧。
 */
const JUNCTION_FILLET = 18;

/** 生成一条独立四角半径的圆角矩形子路径（顺时针）。半径按边长自动收敛，避免过大溢出。 */
function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  corners: { tl: number; tr: number; br: number; bl: number },
): string {
  const cap = Math.min(w, h) / 2;
  const tl = Math.max(0, Math.min(corners.tl, cap));
  const tr = Math.max(0, Math.min(corners.tr, cap));
  const br = Math.max(0, Math.min(corners.br, cap));
  const bl = Math.max(0, Math.min(corners.bl, cap));
  return [
    `M ${x + tl} ${y}`,
    `L ${x + w - tr} ${y}`,
    `A ${tr} ${tr} 0 0 1 ${x + w} ${y + tr}`,
    `L ${x + w} ${y + h - br}`,
    `A ${br} ${br} 0 0 1 ${x + w - br} ${y + h}`,
    `L ${x + bl} ${y + h}`,
    `A ${bl} ${bl} 0 0 1 ${x} ${y + h - bl}`,
    `L ${x} ${y + tl}`,
    `A ${tl} ${tl} 0 0 1 ${x + tl} ${y}`,
    'Z',
  ].join(' ');
}

/**
 * 整块黑色装饰（外边框 + 底部横条）合成为一条 even-odd 填充路径。
 *
 * 外轮廓：整窗圆角矩形，半径 = 屏幕物理圆角 R（贴合机身四角）。
 * 内挖空（透明内容区）：四周内缩 BORDER_WIDTH、下沿落在横条顶（H-barH）的圆角矩形——顶角 R-B，
 * **底角取 JUNCTION_FILLET**。挖空的底角是凸的，反映到黑色块上就是那两处交接的内凹圆弧，直角消失。
 */
function buildChromePath(w: number, h: number, radius: number, barHeight: number): string {
  const outer = roundedRectPath(0, 0, w, h, { tl: radius, tr: radius, br: radius, bl: radius });
  const innerTop = Math.max(0, radius - BORDER_WIDTH);
  const inner = roundedRectPath(
    BORDER_WIDTH,
    BORDER_WIDTH,
    w - BORDER_WIDTH * 2,
    h - barHeight - BORDER_WIDTH,
    { tl: innerTop, tr: innerTop, br: JUNCTION_FILLET, bl: JUNCTION_FILLET },
  );
  return `${outer} ${inner}`;
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * 取当前设备屏幕物理圆角（dp）：Android 用 native 实测（sync），iOS / 旧 build 用 safe-area top inset
 * 查表推断（灵动岛≈55 / 刘海≈47 / 直角屏 0）。与 DrawerShell / CompactDocsPreviewOverlay 同一套取法，
 * 替代此前硬编码的 40（在刘海 / 灵动岛机上偏小、不贴合）。
 */
function useScreenCornerRadius(topInset: number): number {
  const nativeRadius = getScreenCornerRadiusSync();
  return nativeRadius && nativeRadius > 0 ? nativeRadius : inferScreenCornerRadius(topInset);
}

export function BroadcastModeOverlay(): React.ReactElement | null {
  const active = useBroadcastMode();
  const { session } = useSession();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // 真实屏幕圆角：黑边 / 横条底角都按它取圆，替代硬编码 40。
  const screenRadius = useScreenCornerRadius(insets.top);

  // 呼吸动画：让边框 + 指示点缓慢明暗，传达"正在监听"的活体感。
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          // 呼吸驱动 SVG Path 的 fill 颜色（非 transform/opacity），走 JS 驱动。
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          // 呼吸驱动 SVG Path 的 fill 颜色（非 transform/opacity），走 JS 驱动。
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  if (!active) return null;

  const pulseColor = pulse.interpolate({ inputRange: [0, 1], outputRange: ['#444444', '#000000'] });

  const handleExit = () => {
    void disableBroadcastMode(session);
  };

  // 外边框 + 底部横条合成一条路径：左下 / 右下交接处用凹圆角，取代原先的直角。
  const chromePath = buildChromePath(width, height, screenRadius, BAR_HEIGHT);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* 纯装饰的黑色 chrome（边框 + 横条一体）。full-screen 且 pointerEvents=none →
           透明内容区触摸照常穿透到底层页面；填充色随呼吸从 #444 到 #000 脉动。 */}
      <Svg
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        width={width}
        height={height}
      >
        <AnimatedPath d={chromePath} fill={pulseColor} fillRule="evenodd" />
      </Svg>

      {/* 底部横条上的内容：标签 + 退出按钮。叠在 SVG 横条之上，box-none 让空白处穿透，
           仅退出按钮 pointerEvents=auto 承接点击。 */}
      <View
        pointerEvents="box-none"
        style={[
          styles.barContent,
          { height: BAR_HEIGHT, paddingHorizontal: screenRadius * 0.6 },
        ]}
      >
        <View style={styles.labelRow}>
          <View style={styles.dot} />
          <Text style={styles.label} numberOfLines={1}>
            语音播报中
          </Text>
        </View>
        <Pressable
          onPress={handleExit}
          hitSlop={8}
          style={({ pressed }) => [styles.exitBtn, pressed && styles.exitBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel="退出语音播报模式"
        >
          <Text style={styles.exitText}>退出</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * 播报态下把整棵页面树的底部安全区 inset 顶高，给底部横条让路——避免逐页改 marginBottom。
 *
 * 底部横条现在贴屏幕最底 (bottom:0) 且高 BAR_HEIGHT，覆盖了原本的 SafeArea 底边。各页面统一用
 * useSafeAreaInsets().bottom 做底部避让，这里在播报激活时把该 inset 覆写为
 * max(真实 bottom Y, 横条高度 Z) + 间距 GAP：页面原来"距底 = inset + 自身 marginBottom X"，覆写后
 * 内容底沿落在 max(Y,Z)+GAP+X 处 —— 至少高出横条顶沿 GAP，不再贴死横条，也不与 home indicator 重叠。
 *
 * 只覆写 insets context（不动 frame context），非播报态原样透传、零影响。
 */
export function BroadcastInsetProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const active = useBroadcastMode();
  const insets = useSafeAreaInsets();

  if (!active) return <>{children}</>;

  const lifted = {
    ...insets,
    bottom: Math.max(insets.bottom, BAR_HEIGHT) + BAR_CONTENT_GAP,
  };
  return (
    <SafeAreaInsetsContext.Provider value={lifted}>
      {children}
    </SafeAreaInsetsContext.Provider>
  );
}

const styles = StyleSheet.create({
  // 底部横条内容行：贴屏底、满宽，横条视觉由 SVG chrome 画，这里只放标签 + 退出按钮。
  barContent: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // 横向缩进随屏幕圆角半径缩放（见 barContent 内联 paddingHorizontal），让文字/按钮的
    // 内缩与圆角曲线协调，取代原固定值 16 + BORDER_WIDTH。
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 9999,
    backgroundColor: ACCENT,
    marginRight: 10,
  },
  label: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  exitBtn: {
    paddingVertical: 7,
    paddingHorizontal: 18,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    marginLeft: 12,
  },
  exitBtnPressed: {
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  exitText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
