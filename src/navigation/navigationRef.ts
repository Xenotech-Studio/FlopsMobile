/**
 * 全局 NavigationContainer ref。
 *
 * 提取到独立文件，避免 App.tsx <-> 其它 navigation 消费者之间的循环依赖。
 * 例如 push 通知点击后的 deep-link 路由 (DeepLinkRouter)
 * 需要在 NavigationContainer 之外触发跳转，就用这个 ref。
 */
import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();
