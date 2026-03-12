import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export function DocsPlaceholderScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📄</Text>
      <Text style={styles.title}>Docs</Text>
      <Text style={styles.subtitle}>开发中</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#9ca3af',
  },
});
