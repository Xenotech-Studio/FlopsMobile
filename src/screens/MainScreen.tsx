import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Pressable,
  PanResponder,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { shadowMenu } from '../theme/shadows';
import { ConversationListScreen } from './ConversationListScreen';
import { TasksNavigator } from './TasksNavigator';
import { CalendarPlaceholderScreen } from './CalendarPlaceholderScreen';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';

const Tab = createBottomTabNavigator<MainTabParamList>();

const TAB_BAR_BASE_HEIGHT = 60;

function MainHeaderLeft() {
  const navigation = useNavigation();
  const rootNav = navigation.getParent() as NavigationProp<RootStackParamList> | undefined;

  return (
    <TouchableOpacity
      style={headerStyles.iconBtn}
      onPress={() => rootNav?.navigate('Profile')}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Ionicons name="person-outline" size={20} color="#111827" />
    </TouchableOpacity>
  );
}

function MainHeaderRight({ onNewConversation }: { onNewConversation: () => void }) {
  const [menuVisible, setMenuVisible] = useState(false);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const openMenu = useCallback(() => setMenuVisible(true), []);
  const closeMenu = useCallback(() => setMenuVisible(false), []);

  const onNewChat = useCallback(() => {
    setMenuVisible(false);
    onNewConversation();
  }, [onNewConversation]);

  return (
    <>
      <TouchableOpacity
        style={headerStyles.menuBtn}
        onPress={openMenu}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="menu" size={24} color="#111827" />
      </TouchableOpacity>
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={closeMenu}
      >
        <Pressable style={headerStyles.menuOverlay} onPress={closeMenu}>
          <View
            style={[
              headerStyles.menuPanel,
              {
                top: insets.top + 56,
                right: 16,
                minWidth: Math.min(width * 0.5, 200),
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <TouchableOpacity
              style={headerStyles.menuItem}
              onPress={onNewChat}
              activeOpacity={0.7}
            >
              <Ionicons name="add-circle-outline" size={20} color="#374151" />
              <Text style={headerStyles.menuItemText}>新建对话</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const headerStyles = StyleSheet.create({
  iconBtn: { marginLeft: 8, padding: 4 },
  menuBtn: { marginRight: 8, padding: 4 },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  menuPanel: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 8,
    ...shadowMenu,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  menuItemText: { fontSize: 16, color: '#111827' },
});

const EDGE_WIDTH = 24;
const SWIPE_THRESHOLD = 60;

export function MainScreen() {
  const insets = useSafeAreaInsets();
  const rootNav = useNavigation<NavigationProp<RootStackParamList>>();

  const onNewConversation = useCallback(() => {
    rootNav.navigate('Chat', undefined);
  }, [rootNav]);

  const gestureStartX = useRef(0);
  const leftEdgeOpenProfile = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10,
      onPanResponderGrant: (evt) => {
        gestureStartX.current = evt.nativeEvent.pageX;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (
          gestureState.dx > SWIPE_THRESHOLD &&
          gestureStartX.current <= EDGE_WIDTH + 20
        ) {
          rootNav.navigate('Profile');
        }
      },
    })
  ).current;

  return (
    <View style={{ flex: 1 }}>
      <View style={mainStyles.leftEdgeGesture} {...leftEdgeOpenProfile.panHandlers} pointerEvents="box-only" />
      <Tab.Navigator
      initialRouteName="Chat"
      screenOptions={{
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: {
          fontSize: 18,
          fontWeight: '700',
          color: '#0f172a',
          ...(Platform.OS === 'android' ? { marginLeft: -22 } : {}),
        },
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerTintColor: '#374151',
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopWidth: 1,
          borderTopColor: '#e5e7eb',
          paddingTop: 8,
          paddingBottom: insets.bottom,
          height: TAB_BAR_BASE_HEIGHT + insets.bottom,
        },
        tabBarActiveTintColor: '#0f172a',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Chat"
        component={ConversationListScreen}
        options={{
          title: '对话',
          headerTitle: '对话',
          headerLeft: () => <MainHeaderLeft />,
          headerRight: () => <MainHeaderRight onNewConversation={onNewConversation} />,
          tabBarLabel: 'Chat',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Tasks"
        component={TasksNavigator}
        options={{
          headerShown: false,
          title: '任务',
          tabBarLabel: 'Tasks',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="checkmark-done" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Calendar"
        component={CalendarPlaceholderScreen}
        options={{
          title: 'Calendar',
          tabBarLabel: 'Calendar',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
    </View>
  );
}

const mainStyles = StyleSheet.create({
  leftEdgeGesture: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: EDGE_WIDTH,
    zIndex: 10,
  },
});
