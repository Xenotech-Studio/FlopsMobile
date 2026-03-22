import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

/** 与 FlopsWeb `.inbox-run-spinner` 一致：14px 环、灰底 + 深顶弧、0.7s 旋转 */
export function InboxRunSpinner() {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View
      style={[styles.runSpinner, { transform: [{ rotate }] }]}
      accessibilityLabel="生成中"
      accessibilityRole="image"
    />
  );
}

/** 与 FlopsWeb `.inbox-unread-check` 一致 */
export function InboxUnreadCheck() {
  return (
    <View style={styles.unreadWrap} accessibilityLabel="新回复" accessibilityRole="image">
      <Text style={styles.unreadGlyph}>✓</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  runSpinner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#d4d4d4',
    borderTopColor: '#404040',
  },
  unreadWrap: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadGlyph: {
    fontSize: 13,
    fontWeight: '700',
    color: '#16a34a',
    lineHeight: 16,
  },
});
