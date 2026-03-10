/**
 * 用户信息与设置页，从左侧滑入；含账户信息、设置入口、退出登录。
 */
import React, { useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  PanResponder,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSession } from '../context/SessionContext';

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

export function ProfileScreen() {
  const navigation = useNavigation();
  const { session, logout } = useSession();
  const { width: screenWidth } = useWindowDimensions();
  const gestureStartX = useRef(0);

  const rightEdgeClose = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10,
      onPanResponderGrant: (evt) => {
        gestureStartX.current = evt.nativeEvent.pageX;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (
          gestureState.dx < -SWIPE_THRESHOLD &&
          gestureStartX.current >= screenWidth - EDGE_WIDTH - 20
        ) {
          navigation.goBack();
        }
      },
    })
  ).current;

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

  if (!session) return null;

  const initial = session.user_id.slice(0, 1).toUpperCase() || '?';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View
        style={[styles.rightEdgeGesture, { right: 0 }]}
        {...rightEdgeClose.panHandlers}
        pointerEvents="box-only"
      />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>账户</Text>
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={24} color="#374151" />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.userCard}>
          <View style={styles.avatarWrap}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <Text style={styles.userId}>{session.user_id}</Text>
          <Text style={styles.userMeta}>已连接 · Flops</Text>
        </View>

        <View style={styles.section}>
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => {}}
          >
            <Ionicons name="person-outline" size={22} color="#6b7280" />
            <Text style={styles.rowLabel}>账户与安全</Text>
            <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowBorder]}
            activeOpacity={0.7}
            onPress={() => {}}
          >
            <Ionicons name="information-circle-outline" size={22} color="#6b7280" />
            <Text style={styles.rowLabel}>关于</Text>
            <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
          </TouchableOpacity>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  rightEdgeGesture: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: EDGE_WIDTH,
    zIndex: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  closeBtn: { padding: 4 },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  userCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 2,
  },
  avatarWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: { fontSize: 28, fontWeight: '700', color: '#fff' },
  userId: { fontSize: 18, fontWeight: '600', color: '#111827' },
  userMeta: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  rowLabel: { flex: 1, fontSize: 16, color: '#111827' },
  logoutBtn: {
    backgroundColor: '#fff',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  logoutBtnText: { fontSize: 16, fontWeight: '600', color: '#dc2626' },
});
