import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';

function createTasksPlaceholderStyles(c: AppColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.chatScreenBackground,
    },
    icon: {
      fontSize: 48,
      color: c.placeholder,
      marginBottom: 16,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: c.textSecondary,
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 15,
      color: c.placeholder,
    },
  });
}

export function TasksPlaceholderScreen() {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createTasksPlaceholderStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>✓</Text>
      <Text style={styles.title}>Tasks</Text>
      <Text style={styles.subtitle}>敬请期待</Text>
    </View>
  );
}
