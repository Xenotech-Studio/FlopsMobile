/**
 * BroadcastLinkRouter —— URL scheme 深链 `flops://broadcast/stop` → 关闭播报模式。
 *
 * 来源：iOS 播报 Live Activity（灵动岛展开态 / 锁屏横幅）里的「停止」按钮是个 Link，点它把 app 拉起
 * 并投递该 url。这里收下后调 disableBroadcastMode()（本地断流 + 写本机 AsyncStorage 开关 + end 掉
 * Live Activity），与 BroadcastModeOverlay 底部横条的「退出」按钮同一条关闭路径。
 *
 * 与 [[AppletLinkRouter]] 同构：冷启动用 Linking.getInitialURL()、热启动用 addEventListener('url')。
 * 原生侧 iOS 走 SceneDelegate 的 RCTLinkingManager 转发（见 ios/FlopsMobile/SceneDelegate.swift）。
 * UI-less，挂在 SessionProvider 下即可（不依赖导航栈）。Android 无 Live Activity，此路由天然不会触发。
 */
import { useEffect } from 'react';
import { Linking } from 'react-native';
import { disableBroadcastMode } from '../audio/ttsRealtime';

/** 是否为「停止播报」深链：flops://broadcast/stop（容忍尾部 /、query、fragment）。 */
export function isBroadcastStopUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^flops:\/\/broadcast\/stop(?:[/?#]|$)/i.test(url.trim());
}

export function BroadcastLinkRouter(): null {
  useEffect(() => {
    let cancelled = false;

    // 冷启动：app 因该 url 被拉起时消费一次
    void Linking.getInitialURL().then((url) => {
      if (cancelled) return;
      if (isBroadcastStopUrl(url)) disableBroadcastMode();
    });

    // 热启动 / 后台→前台：实时 url 事件
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (isBroadcastStopUrl(url)) disableBroadcastMode();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return null;
}
