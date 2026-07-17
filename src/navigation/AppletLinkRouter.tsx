/**
 * AppletLinkRouter —— URL scheme 深链 `flops://applet/{appId}` → 打开全屏 Applet。
 *
 * 与 [[DeepLinkRouter]]（APNs 通知点击，走原生事件）不同，这里处理**系统 URL scheme**：
 *   - 冷启动：Linking.getInitialURL() 拿到启动时的 url。
 *   - 热启动：Linking.addEventListener('url') 实时回流。
 * 解析出 appId 后经 navigationRef 跳 Applet（只带 appId，baseId 由 AppletScreen 反查解析）。
 *
 * 原生侧：iOS 走 SceneDelegate 的 RCTLinkingManager 转发 + Info.plist CFBundleURLTypes；
 * Android 走 AndroidManifest 的 VIEW intent-filter（singleTask + onNewIntent）。
 * 挂在 NavigationContainer 之内（靠 navigationRef，位置不严格）。
 */
import { useEffect } from 'react';
import { Linking } from 'react-native';
import { navigationRef } from './navigationRef';

/** `flops://applet/<appId>`（可带 query/fragment）→ appId；不匹配返回 null。 */
export function parseAppletUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^flops:\/\/applet\/([^/?#]+)/i.exec(url.trim());
  return m ? decodeURIComponent(m[1]) : null;
}

/** 跳转到 Applet；container 未就绪时短暂重试（冷启动 url 可能早于导航栈就绪）。 */
function openApplet(appId: string, retries = 10): void {
  if (!navigationRef.isReady()) {
    if (retries > 0) setTimeout(() => openApplet(appId, retries - 1), 300);
    return;
  }
  navigationRef.navigate('Applet', { appId });
}

export function AppletLinkRouter(): null {
  useEffect(() => {
    let cancelled = false;

    // 冷启动：消费启动 url（若是本 scheme）
    void Linking.getInitialURL().then((url) => {
      if (cancelled) return;
      const id = parseAppletUrl(url);
      if (id) openApplet(id);
    });

    // 热启动 / 后台→前台：实时 url 事件
    const sub = Linking.addEventListener('url', ({ url }) => {
      const id = parseAppletUrl(url);
      if (id) openApplet(id);
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return null;
}
