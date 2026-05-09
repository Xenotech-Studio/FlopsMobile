/**
 * APNs 通知点击 -> RN 路由跳转。
 *
 * 数据来源：
 *   1. 冷启动：原生侧把首次点击的 payload 缓存在 sharedPendingDeepLink；
 *      mount 时调一次 getPendingApnsDeepLink() 拉走。
 *   2. 热启动 / 后台 → 前台：`onAPNsDeepLink` 事件实时回流。
 *
 * 跳转策略（按 payload.kind）：
 *   - need_confirm  → Chat(conversationId) ；ChatScreen 内部已有 conversationId 切换时
 *                     拉取最新消息列表的逻辑，置顶的 safety_confirmation_required 卡片会自然显示。
 *   - turn_done     → Chat(conversationId)
 *   - turn_failed   → Chat(conversationId)
 *
 * 必须挂在 NavigationContainer 之内（实际上靠 navigationRef，所以位置不严格要求）。
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import { navigationRef } from '../navigation/navigationRef';
import {
  addApnsDeepLinkListener,
  getPendingApnsDeepLink,
  type ApnsDeepLinkPayload,
} from './apnsClient';

function navigateForPayload(payload: ApnsDeepLinkPayload | null): void {
  if (!payload || typeof payload !== 'object') return;
  if (!navigationRef.isReady()) return;

  const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : '';
  if (!conversationId) return;

  // reset 到 Main + Chat 两层栈，保证返回手势能回到主页面（与 initialNavState 对齐）
  navigationRef.dispatch(
    CommonActions.reset({
      index: 1,
      routes: [
        { name: 'Main' },
        { name: 'Chat', params: { conversationId } },
      ],
    }),
  );
}

export function DeepLinkRouter(): null {
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    let cancelled = false;

    // 冷启动：拉一次 pending（原生侧拉走后清空缓存，所以只会消费一次）
    void getPendingApnsDeepLink().then((p) => {
      if (cancelled) return;
      navigateForPayload(p);
    });

    // 热启动：实时事件
    const unsub = addApnsDeepLinkListener((p) => {
      if (cancelled) return;
      navigateForPayload(p);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return null;
}
