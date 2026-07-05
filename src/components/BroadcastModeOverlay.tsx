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
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import { disableBroadcastMode, useBroadcastMode } from '../audio/ttsRealtime';

/** 边框粗细（"明显黑色边框"）。 */
const BORDER_WIDTH = 5;
/** 手机屏幕物理圆角半径（≈ iPhone 40px）：黑边 / 底部横条底角都按它取圆角，贴合屏幕。 */
const SCREEN_RADIUS = 40;
/** 底部横条整体高度（贴屏幕最底部、覆盖安全区，不额外避让）。 */
const BAR_HEIGHT = 54;
/** 播报态强调色（暖橙，区别于常规 UI）。 */
const ACCENT = '#FF8A34';

export function BroadcastModeOverlay(): React.ReactElement | null {
  const active = useBroadcastMode();
  const { session } = useSession();

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
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  if (!active) return null;

  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

  const handleExit = () => {
    void disableBroadcastMode(session);
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* 四条黑边拼出的边框：pointerEvents=none 纯装饰，中心镂空不挡触摸。 */}
      <Animated.View
        pointerEvents="none"
        style={[styles.frame, { opacity: pulseOpacity }]}
      />

      {/* 底部横条：黑底，左侧呼吸点 + "语音播报中"，右侧退出按钮。
          bottom:0 且不加安全区偏移 → 贴屏幕最底部、覆盖 SafeArea 底边。 */}
      <View
        pointerEvents="box-none"
        style={styles.barWrap}
      >
        <View style={[styles.bar, { height: BAR_HEIGHT }]}>
          <View style={styles.labelRow}>
            <Animated.View style={[styles.dot, { opacity: pulseOpacity }]} />
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
    </View>
  );
}

/**
 * 播报态下把整棵页面树的底部安全区 inset 顶高，给底部横条让路——避免逐页改 marginBottom。
 *
 * 底部横条现在贴屏幕最底 (bottom:0) 且高 BAR_HEIGHT，覆盖了原本的 SafeArea 底边。各页面统一用
 * useSafeAreaInsets().bottom 做底部避让，这里在播报激活时把该 inset 覆写为 max(真实 bottom Y,
 * 横条高度 Z)：页面原来"距底 = Y + 自身 marginBottom X"，覆写后变成"距底 = max(Y,Z) + X"，
 * 即内容恰好落在横条顶沿之上 X 处，既让开横条又不与 home indicator 重叠。
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

  const lifted = { ...insets, bottom: Math.max(insets.bottom, BAR_HEIGHT) };
  return (
    <SafeAreaInsetsContext.Provider value={lifted}>
      {children}
    </SafeAreaInsetsContext.Provider>
  );
}

const styles = StyleSheet.create({
  frame: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: BORDER_WIDTH,
    borderColor: '#000',
    // 贴合手机屏幕物理圆角，四角走圆弧而非直角。
    borderRadius: SCREEN_RADIUS,
  },
  barWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // 让横条压在黑边内侧，视觉上边框把它一起框住。
    paddingHorizontal: BORDER_WIDTH,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    backgroundColor: '#000',
    // 底角随屏幕圆角收圆（减去黑边宽度得内侧半径），黑条不越出圆角落到屏幕方角外。
    borderBottomLeftRadius: SCREEN_RADIUS - BORDER_WIDTH,
    borderBottomRightRadius: SCREEN_RADIUS - BORDER_WIDTH,
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
