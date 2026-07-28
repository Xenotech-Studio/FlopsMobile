/**
 * DrawerContent —— 抽屉本体，索引型菜单。
 *
 * 自上而下：
 *   1. App title "Flops"（serif 字体感）
 *   2. 一级菜单：今天 / 文档（带 icon + 文字 + active 高亮）
 *   3. "Projects" 段头 + 全量 project 列表（按 name 拼音/字母升序）
 *   4. "Recents" 段头 + 最近 5 条对话快捷
 *   5. 底栏 sticky：左 = 圆头像（打开 ProfileSheet）；右 = 黑色胶囊 "+ New chat"（push Chat 无 conversationId）
 *
 * 当前 active 顶层页用 [[useDrawer]] 取，project 条目展开时高亮当前 projectId。
 * Project 数据走 useTask().projects；archived 字段后端目前未提供，未来加上时在此处过滤。
 * Recents 取自全局 ConversationContext（useConversations），前 5 条，零加载即用。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useDrawer } from './DrawerContext';
import { useTask } from '../../context/TaskContext';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import {
  getCurrentUserInfo,
  type ConversationListItem,
} from '../../api';
import { useConversations } from '../../context/ConversationContext';
import type { AppColors } from '../../theme/appColors';
import { IS_IOS_LIQUID_GLASS } from '../../components/AnimatedCircleButton';
import { BouncyGlassCard } from '../../components/BouncyGlassCard';
import { HEADER_CIRCLE_BTN_SIZE } from '../../theme/layout';
import { androidCircleFabOutline } from '../../theme/shadows';
import { PRESS_SPRING_CONFIG } from '../../constants/animation';

/** Project 列表行 */
type DrawerProjectRow = { id: string; name: string };

const PB_RELEASE_SPRING = { mass: 1, stiffness: 220, damping: 14 };

/** 底栏专用 bouncy（Android / iOS<26 fallback 用；iOS26 走 BouncyGlassCard）。
 *  用 manualActivation 的 Pan：手指一落下就 activate() 抢占手势 → 外层抽屉/侧栏 Pan 被取消，
 *  既不会触发开关抽屉，又能在按住后移动时全程保持放大（不像 Tap 被外层 Pan 抢走就回弹）。
 *  松手落点在按钮内才触发 onPress。 */
function PanBouncy({
  children,
  style,
  onPress,
  pressScale = 1.4,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  pressScale?: number;
}) {
  const scale = useSharedValue(1);
  const w = useSharedValue(0);
  const h = useSharedValue(0);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((_e, manager) => {
          'worklet';
          manager.activate();
          scale.value = withSpring(pressScale, PRESS_SPRING_CONFIG);
        })
        .onFinalize((e) => {
          'worklet';
          scale.value = withSpring(1, PB_RELEASE_SPRING);
          const inside = e.x >= 0 && e.y >= 0 && e.x <= w.value && e.y <= h.value;
          if (inside && onPress) runOnJS(onPress)();
        }),
    [onPress, pressScale, scale, w, h]
  );
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[style, animStyle]}
        onLayout={(ev) => {
          w.value = ev.nativeEvent.layout.width;
          h.value = ev.nativeEvent.layout.height;
        }}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

export function DrawerContent() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { active, setActive, presentProfileSheet } = useDrawer();
  const { session, serverBaseUrl } = useSession();
  const { projects, loadProjects } = useTask();

  /** 用户头像 / 昵称（用于底栏左侧圆按钮） */
  const [userInfo, setUserInfo] = useState<{ avatarUrl?: string; nickname?: string } | null>(null);

  useEffect(() => {
    if (!session) {
      setUserInfo(null);
      return;
    }
    getCurrentUserInfo(serverBaseUrl, session.user_id, session.access_token)
      .then((info) => {
        if (info) setUserInfo({ avatarUrl: info.avatarUrl, nickname: info.nickname });
      })
      .catch(() => {});
  }, [session, serverBaseUrl]);

  /** Recents 列表（前 5 条）：取自全局 ConversationContext，零加载即用 */
  const recents = useConversations().slice(0, 5);

  /** Project context 在首次渲染时也要拉一遍，确保抽屉刚打开就能看到列表 */
  useEffect(() => {
    if (session) loadProjects(false).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /** Project 列表：按 name 升序（中文走 localeCompare zh） */
  const sortedProjects: DrawerProjectRow[] = useMemo(() => {
    const rows = projects.map((p) => ({
      id: p.id,
      name: (p.name ?? '').trim() || p.id,
    }));
    rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return rows;
  }, [projects]);

  /** 点击事件 */
  const onPickToday = useCallback(() => setActive({ kind: 'today' }), [setActive]);
  const onPickDocs = useCallback(() => setActive({ kind: 'docs' }), [setActive]);
  /** 小应用 = 与今天/文档同级的抽屉内部顶层页（setActive 驱动，非 stack push）。 */
  const onPickMiniApp = useCallback(() => setActive({ kind: 'miniApps' }), [setActive]);
  const onPickProject = useCallback(
    (row: DrawerProjectRow) =>
      setActive({ kind: 'project', projectId: row.id, projectName: row.name }),
    [setActive]
  );

  /** Recents 行点击 / 新对话 + 都走 setActive，把 Chat 提升为抽屉顶层页（不再 stack push） */
  const onPickRecent = useCallback(
    (conv: ConversationListItem) => {
      setActive({
        kind: 'chat',
        conversationId: conv.id,
        conversationTitle: (conv.title && conv.title.trim()) || '新对话',
      });
    },
    [setActive]
  );

  const onNewChat = useCallback(() => {
    // 新对话始终加密。createConversation 内部若本机无 K_user 会抛错引导重登。
    setActive({ kind: 'chat', nonce: Date.now(), createEncrypted: true });
  }, [setActive]);

  const onAvatarPress = useCallback(() => {
    presentProfileSheet();
  }, [presentProfileSheet]);

  /** 当前 active 比对（高亮） */
  const isTodayActive = active.kind === 'today';
  const isDocsActive = active.kind === 'docs';
  const isMiniAppsActive = active.kind === 'miniApps';
  const activeProjectId = active.kind === 'project' ? active.projectId : null;
  const activeChatId = active.kind === 'chat' ? active.conversationId : null;

  const initial = (userInfo?.nickname || session?.user_id || '?').slice(0, 1).toUpperCase();

  /** 底栏吸收横向拖的空 Pan：阈值 ±1（小于关抽屉 −2 / 侧栏拖动 ±6），在底栏两个钮上拖动时先激活、
   *  取消外层的开关抽屉手势，自身不做任何事 → 钮上拖动不会滑动抽屉；纯点击无位移仍触发 onPress。 */
  const blockBottomBarSwipe = useMemo(
    () => Gesture.Pan().activeOffsetX([-1, 1]),
    []
  );

  /** 头像内容物（图 or 首字母），两条路径（glass / worklet）共用 */
  const avatarContent = userInfo?.avatarUrl ? (
    <Image source={{ uri: userInfo.avatarUrl }} style={styles.avatarImg} />
  ) : (
    <Text style={styles.avatarInitial}>{initial}</Text>
  );
  /** 新对话内容物（＋ + 文字），两条路径共用 */
  const newChatContent = (
    <>
      <Ionicons name="add" size={20} color={colors.onUserBubble} />
      <Text style={styles.newChatText}>新对话</Text>
    </>
  );

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + 16, paddingBottom: 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* App title */}
        <Text style={styles.appTitle}>Flops</Text>

        {/* 一级菜单 */}
        <View style={styles.menuGroup}>
          <MenuRow
            label="今天"
            icon="today-outline"
            active={isTodayActive}
            onPress={onPickToday}
            colors={colors}
            isDark={isDark}
          />
          <MenuRow
            label="文档"
            icon="document-text-outline"
            active={isDocsActive}
            onPress={onPickDocs}
            colors={colors}
            isDark={isDark}
          />
          <MenuRow
            label="小应用"
            icon="apps-outline"
            active={isMiniAppsActive}
            onPress={onPickMiniApp}
            colors={colors}
            isDark={isDark}
          />
        </View>

        {/* Projects 段头 */}
        <SectionLabel text="Projects" colors={colors} />
        {sortedProjects.length === 0 ? (
          <Text style={styles.emptyHint}>暂无项目</Text>
        ) : (
          <View style={styles.menuGroup}>
            {sortedProjects.map((p) => (
              <MenuRow
                key={p.id}
                label={p.name}
                icon="folder-outline"
                active={activeProjectId === p.id}
                onPress={() => onPickProject(p)}
                colors={colors}
                isDark={isDark}
              />
            ))}
          </View>
        )}

        {/* Recents 段头 + 5 条 */}
        <SectionLabel text="Recents" colors={colors} />
        {recents.length === 0 ? (
          <Text style={styles.emptyHint}>暂无对话</Text>
        ) : (
          <View style={styles.menuGroup}>
            {recents.map((c) => (
              <MenuRow
                key={c.id}
                label={(c.title && c.title.trim()) || '新对话'}
                active={activeChatId === c.id}
                onPress={() => onPickRecent(c)}
                colors={colors}
                isDark={isDark}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/* 底栏 sticky。包一层吸收横向拖的 Pan（阈值 ±1，小于关抽屉 −2 / 侧栏 ±6）→ 在底栏两个钮上
          拖动会先激活它、取消外层抽屉/侧栏滑动手势 → 不触发开关抽屉；纯点击不位移仍正常 onPress。 */}
      <GestureDetector gesture={blockBottomBarSwipe}>
      <View
        style={[
          styles.bottomBar,
          { paddingBottom: Math.max(insets.bottom, 12) + 4 },
        ]}
      >
        {/* Profile 头像。iOS 26：走 BouncyGlassCard（UIVisualEffectView interactive）——按下后平移
            手指有原生玻璃「搓」偏移反馈（worklet 给不出）。头像图盖在玻璃上、跟卡片一起动；无头像时
            给玻璃上 primary tint 当原色圈。iOS<26/Android：回退 worklet 圆钮。 */}
        {IS_IOS_LIQUID_GLASS ? (
          <BouncyGlassCard
            style={styles.avatarGlass}
            cornerRadius={HEADER_CIRCLE_BTN_SIZE / 2}
            tintColor={userInfo?.avatarUrl ? undefined : colors.primary}
            onPress={onAvatarPress}
          >
            {avatarContent}
          </BouncyGlassCard>
        ) : (
          <PanBouncy style={styles.avatarBtn} onPress={onAvatarPress}>
            {avatarContent}
          </PanBouncy>
        )}

        {/* 占位：把新对话胶囊推到最右 */}
        <View style={styles.bottomSpacer} />

        {/* 新对话胶囊。iOS 26：BouncyGlassCard 深色 tint 玻璃（带「搓」反馈，同 composer 卡片那套）；
            iOS<26/Android：回退黑色 worklet 胶囊。 */}
        {IS_IOS_LIQUID_GLASS ? (
          <BouncyGlassCard
            style={styles.newChatGlass}
            cornerRadius={HEADER_CIRCLE_BTN_SIZE / 2}
            tintColor={colors.userBubble}
            onPress={onNewChat}
          >
            {newChatContent}
          </BouncyGlassCard>
        ) : (
          <PanBouncy style={styles.newChatPill} onPress={onNewChat}>
            {newChatContent}
          </PanBouncy>
        )}
      </View>
      </GestureDetector>
    </View>
  );
}

function MenuRow({
  label,
  icon,
  active,
  onPress,
  colors,
  isDark,
}: {
  label: string;
  /** 可选：Recents 行无 icon，文字直接从内容左缘起（跟 Claude 一致） */
  icon?: string;
  active: boolean;
  onPress: () => void;
  colors: AppColors;
  isDark: boolean;
}) {
  const styles = useMemo(() => createMenuRowStyles(colors, isDark), [colors, isDark]);
  return (
    <TouchableOpacity
      style={[styles.row, active && styles.rowActive]}
      onPress={onPress}
      activeOpacity={0.6}
    >
      {icon ? (
        <Ionicons
          name={icon as never}
          size={21}
          color={active ? colors.textHeader : colors.textSecondary}
          style={styles.icon}
        />
      ) : null}
      <Text
        style={[styles.label, active && styles.labelActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function SectionLabel({ text, colors }: { text: string; colors: AppColors }) {
  return (
    <Text
      style={{
        fontSize: 12,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginTop: 24,
        marginBottom: 8,
        paddingHorizontal: 12,
      }}
    >
      {text}
    </Text>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.drawerBackground },
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: 16,
    },
    appTitle: {
      fontSize: 28,
      fontWeight: '700',
      color: c.textHeader,
      /** scrollContent.paddingHorizontal=20，再缩进 12 跟 MenuRow.row 的 paddingHorizontal 同步，
       *  让 "Flops" 起始 x 和下面菜单项内容（icon）的起始 x 对齐。 */
      marginLeft: 12,
      marginBottom: 22,
      fontFamily: 'serif',
    },
    menuGroup: {
      marginTop: 2,
    },
    emptyHint: {
      fontSize: 14,
      color: c.placeholder,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    bottomBar: {
      flexDirection: 'row',
      alignItems: 'center',
      /* 左 28：让 profile 胶囊左缘(=头像左缘)对齐上方列表项「图标」左缘(scrollPad16 + rowPad12)，
         而不是高亮方块左缘(16)。右 16：+ 钮右缘对齐高亮方块右缘。 */
      paddingLeft: 28,
      paddingRight: 16,
      paddingTop: 10,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderMuted,
      backgroundColor: c.drawerBackground,
    },
    /** Profile：纯圆形头像 bouncy 钮。直径 = 今日页角钮(HEADER_CIRCLE_BTN_SIZE=52)。
     *  iOS：shadow props 画圆阴影、不用 overflow（否则裁掉阴影），Image 自带 borderRadius 自裁圆。
     *  Android：跟今日页底部 FAB 同一套阴影（见下 Platform.select）。 */
    avatarBtn: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      alignSelf: 'center',
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      ...Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.18,
          shadowRadius: 8,
        },
        /* Android：跟今日页底部 FAB 同一套阴影（elevation 5 + shadowColor，无 overflow）。
           头像图自带 borderRadius 自裁圆，不需 overflow；elevation 阴影按圆角/胶囊形状走、不方。 */
        android: androidCircleFabOutline(c),
      }),
    },
    /** iOS26 玻璃头像：尺寸/居中布局，无 bg/shadow（玻璃材质自带）。圆角由 BouncyGlassCard prop 控制。 */
    avatarGlass: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      alignSelf: 'center',
      alignItems: 'center',
      justifyContent: 'center',
      /* iOS：玻璃材质本身投影很弱，显式补一道（挂在 BouncyGlassCard 宿主层，不影响玻璃材质）。
         淡而柔：低 opacity + 大 radius。 */
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 13,
    },
    avatarImg: {
      width: HEADER_CIRCLE_BTN_SIZE,
      height: HEADER_CIRCLE_BTN_SIZE,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
    },
    avatarInitial: { color: c.onPrimary, fontSize: 20, fontWeight: '700' },
    /** 新对话：黑色带文字胶囊，靠最右，高 = 头像钮(52)。borderCurve continuous + 阴影做出卡片感。
     *  Android 阴影跟今日页底部 FAB 同一套（见下 Platform.select）。 */
    newChatPill: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: HEADER_CIRCLE_BTN_SIZE,
      paddingHorizontal: 20,
      borderRadius: HEADER_CIRCLE_BTN_SIZE / 2,
      borderCurve: 'continuous',
      backgroundColor: c.userBubble,
      ...Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.18,
          shadowRadius: 8,
        },
        /* Android：跟今日页底部 FAB 同一套阴影（elevation 5 + shadowColor，无 overflow）。
           头像图自带 borderRadius 自裁圆，不需 overflow；elevation 阴影按圆角/胶囊形状走、不方。 */
        android: androidCircleFabOutline(c),
      }),
    },
    /** iOS26 玻璃新对话胶囊：行布局，无 bg/shadow（深色 tint 玻璃自带）。圆角走 BouncyGlassCard prop。 */
    newChatGlass: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: HEADER_CIRCLE_BTN_SIZE,
      paddingHorizontal: 20,
      alignSelf: 'center',
      /* 深色胶囊不加阴影（玻璃材质自身就够）。 */
    },
    newChatText: {
      color: c.onUserBubble,
      fontSize: 14,
      fontWeight: '600',
    },
    bottomSpacer: { flex: 1 },
  });
}

function createMenuRowStyles(c: AppColors, isDark: boolean) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 12,
      /* iOS continuous corner curve（squircle）：选中高亮方块圆弧↔直边 G2 连续，跟系统圆角同质感。Android 忽略。 */
      borderCurve: 'continuous',
      gap: 14,
    },
    /* 选中高亮：浅色主题用比抽屉画布(#ededef)更深的灰「变暗」；深色主题保持比底略亮(surfaceMuted)。
       字体不加粗——仅靠底色区分选中。 */
    rowActive: {
      backgroundColor: isDark ? c.surfaceMuted : '#e1e1e4',
    },
    icon: { width: 24 },
    label: {
      fontSize: 16,
      color: c.textPrimary,
      flex: 1,
    },
    labelActive: {
      color: c.textHeader,
    },
  });
}

