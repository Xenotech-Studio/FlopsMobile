/**
 * 捕获子树内 React 渲染期错误，避免整页白屏/进程被系统结束（仅 JS 异常；原生 OOM 等无法拦截）。
 */
import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

type Props = {
  children: ReactNode;
  /** 主标题 */
  title?: string;
};

type State = {
  hasError: boolean;
  message: string;
};

export class ScreenErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): Partial<State> {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : '未知错误';
    return { hasError: true, message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (__DEV__) {
      console.error('[ScreenErrorBoundary]', error.message, info.componentStack);
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.wrap} accessibilityRole="alert">
          <Text style={styles.title}>{this.props.title ?? '这部分内容加载失败'}</Text>
          <Text style={styles.detail} numberOfLines={8}>
            {this.state.message}
          </Text>
          <Text style={styles.hint}>可尝试切换底部标签或返回上一页后再进入。若持续出现，请向开发者反馈。</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={this.handleRetry} activeOpacity={0.7}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 24,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#222',
    marginBottom: 10,
    textAlign: 'center',
  },
  detail: {
    fontSize: 13,
    color: '#666',
    marginBottom: 16,
    textAlign: 'center',
  },
  hint: {
    fontSize: 13,
    color: '#888',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 20,
  },
  retryBtn: {
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 10,
    backgroundColor: '#333',
  },
  retryText: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '500',
  },
});
