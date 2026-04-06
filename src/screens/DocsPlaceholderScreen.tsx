import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { AppColors } from '../theme/appColors';
import { useAppTheme } from '../context/ThemeContext';

function createDocsPlaceholderStyles(c: AppColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.chatScreenBackground,
    },
    icon: {
      fontSize: 48,
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

export function DocsPlaceholderScreen() {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createDocsPlaceholderStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📄</Text>
      <Text style={styles.title}>Docs</Text>
      <Text style={styles.subtitle}>开发中</Text>
    </View>
  );
}
