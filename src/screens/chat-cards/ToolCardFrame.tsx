import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';

type Props = {
  cardKey: string;
  viewMode: 'collapsed' | 'preview' | 'full';
  styles: Record<string, object>;
  status: string;
  collapsedName: string;
  collapsedTail?: string | null;
  collapsedSuccessStyle?: 'ok' | 'success' | 'none';
  getToolStatusLabel: (status: string) => string;
  setToolCardMode: (key: string, mode: 'collapsed' | 'preview' | 'full') => void;
  children: React.ReactNode;
  hideExpandRow?: boolean;
};

export function ToolCardFrame({
  cardKey,
  viewMode,
  styles,
  status,
  collapsedName,
  collapsedTail,
  collapsedSuccessStyle = 'none',
  getToolStatusLabel,
  setToolCardMode,
  children,
  hideExpandRow = false,
}: Props) {
  const isFull = viewMode === 'full';
  const collapsedBadgeStyle =
    collapsedSuccessStyle === 'ok' && status === 'completed'
      ? styles.toolCardBadgeOk
      : collapsedSuccessStyle === 'success' && status === 'completed'
        ? styles.toolCardBadgeSuccess
        : undefined;

  if (viewMode === 'collapsed') {
    return (
      <Pressable
        key={cardKey}
        style={({ pressed }) => [styles.toolCard, styles.toolCardCollapsed, pressed && styles.toolCardCollapsedPressed]}
        onPress={() => setToolCardMode(cardKey, 'preview')}
        accessibilityLabel="点击展开"
      >
        <View style={styles.toolCardCollapsedMain}>
          <Text
            style={styles.toolCardCollapsedName}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {collapsedName}
          </Text>
          {collapsedTail != null && collapsedTail !== '' ? (
            <Text
              style={styles.toolCardCollapsedTail}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {collapsedTail}
            </Text>
          ) : null}
        </View>
        <View style={styles.toolCardBadgeWrap}>
          <Text style={[styles.toolCardBadge, collapsedBadgeStyle]}>{getToolStatusLabel(status)}</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <View key={cardKey} style={styles.toolCard}>
      <Pressable
        onPress={() => {
          if (!isFull) setToolCardMode(cardKey, 'collapsed');
        }}
        style={({ pressed }) => (pressed && !isFull ? styles.toolCardContentPressed : undefined)}
        accessibilityLabel={isFull ? undefined : '点击收起'}
      >
        {children}
      </Pressable>
      {!hideExpandRow ? (
        <Pressable
          style={({ pressed }) => [
            styles.toolCardExpandRow,
            pressed && styles.toolCardExpandRowPressed,
          ]}
          onPress={() => setToolCardMode(cardKey, isFull ? 'preview' : 'full')}
          accessibilityLabel={isFull ? '收起' : '完全展开'}
        >
          <Ionicons
            name={isFull ? 'chevron-up' : 'chevron-down'}
            size={16}
            color="#64748b"
          />
        </Pressable>
      ) : null}
    </View>
  );
}

