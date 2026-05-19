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
 * Recents 走 listConversations，挂载时拉一次，前 5 条。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useDrawer } from './DrawerContext';
import { useTask } from '../../context/TaskContext';
import { useSession } from '../../context/SessionContext';
import { useAppTheme } from '../../context/ThemeContext';
import {
  getCurrentUserInfo,
  listConversations,
  type ConversationListItem,
} from '../../api';
import type { AppColors } from '../../theme/appColors';
import { shadowCircleButtonThemed } from '../../theme/shadows';

/** Project 列表行 */
type DrawerProjectRow = { id: string; name: string };

export function DrawerContent() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
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

  /** Recents 列表（前 5 条），每次抽屉 mount 拉一次 */
  const [recents, setRecents] = useState<ConversationListItem[]>([]);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    listConversations(session)
      .then(({ conversations }) => {
        if (cancelled) return;
        setRecents((conversations ?? []).slice(0, 5));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session]);

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
    // nonce 让每次点 + 都强制 remount 一个全新 ChatScreen
    setActive({ kind: 'chat', nonce: Date.now() });
  }, [setActive]);

  const onAvatarPress = useCallback(() => {
    presentProfileSheet();
  }, [presentProfileSheet]);

  /** 当前 active 比对（高亮） */
  const isTodayActive = active.kind === 'today';
  const isDocsActive = active.kind === 'docs';
  const activeProjectId = active.kind === 'project' ? active.projectId : null;

  const initial = (userInfo?.nickname || session?.user_id || '?').slice(0, 1).toUpperCase();

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
          />
          <MenuRow
            label="文档"
            icon="document-text-outline"
            active={isDocsActive}
            onPress={onPickDocs}
            colors={colors}
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
              <TouchableOpacity
                key={c.id}
                style={styles.recentRow}
                onPress={() => onPickRecent(c)}
                activeOpacity={0.6}
              >
                <Text style={styles.recentText} numberOfLines={1}>
                  {(c.title && c.title.trim()) || '新对话'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {/* 底栏 sticky */}
      <View
        style={[
          styles.bottomBar,
          { paddingBottom: Math.max(insets.bottom, 12) + 4 },
        ]}
      >
        <TouchableOpacity
          style={styles.avatarBtn}
          onPress={onAvatarPress}
          activeOpacity={0.8}
        >
          {userInfo?.avatarUrl ? (
            <Image source={{ uri: userInfo.avatarUrl }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarInitial}>{initial}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.newChatPill}
          onPress={onNewChat}
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={20} color={colors.onUserBubble} />
          <Text style={styles.newChatText}>新对话</Text>
        </TouchableOpacity>

        {/* 占位，让胶囊保持靠中偏右 */}
        <View style={styles.bottomSpacer} />
      </View>
    </View>
  );
}

function MenuRow({
  label,
  icon,
  active,
  onPress,
  colors,
}: {
  label: string;
  icon: string;
  active: boolean;
  onPress: () => void;
  colors: AppColors;
}) {
  const styles = useMemo(() => createMenuRowStyles(colors), [colors]);
  return (
    <TouchableOpacity
      style={[styles.row, active && styles.rowActive]}
      onPress={onPress}
      activeOpacity={0.6}
    >
      <Ionicons
        name={icon as never}
        size={18}
        color={active ? colors.textHeader : colors.textSecondary}
        style={styles.icon}
      />
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
        fontSize: 11,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginTop: 18,
        marginBottom: 6,
        paddingHorizontal: 4,
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
      paddingHorizontal: 20,
    },
    appTitle: {
      fontSize: 26,
      fontWeight: '700',
      color: c.textHeader,
      /** scrollContent.paddingHorizontal=20，再缩进 8 跟 MenuRow.row 的 paddingHorizontal 同步，
       *  让 "Flops" 起始 x 和下面菜单项内容（icon）的起始 x 对齐。 */
      marginLeft: 8,
      marginBottom: 16,
      fontFamily: 'serif',
    },
    menuGroup: {
      marginTop: 2,
    },
    emptyHint: {
      fontSize: 13,
      color: c.placeholder,
      paddingHorizontal: 6,
      paddingVertical: 8,
    },
    recentRow: {
      paddingVertical: 10,
      paddingHorizontal: 6,
    },
    recentText: {
      fontSize: 14,
      color: c.textPrimary,
    },
    bottomBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 10,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderMuted,
      backgroundColor: c.drawerBackground,
    },
    avatarBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      ...shadowCircleButtonThemed(c),
    },
    avatarImg: { width: 40, height: 40, borderRadius: 20 },
    avatarInitial: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
    newChatPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 22,
      backgroundColor: c.userBubble,
    },
    newChatText: {
      color: c.onUserBubble,
      fontSize: 14,
      fontWeight: '600',
    },
    bottomSpacer: { flex: 1 },
  });
}

function createMenuRowStyles(c: AppColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 10,
      gap: 12,
    },
    rowActive: {
      backgroundColor: c.surfaceMuted,
    },
    icon: { width: 22 },
    label: {
      fontSize: 16,
      color: c.textPrimary,
      flex: 1,
    },
    labelActive: {
      fontWeight: '700',
      color: c.textHeader,
    },
  });
}

