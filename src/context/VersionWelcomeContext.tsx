import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { APP_VERSION } from '../appVersion';
import {
  getLastLaunchedVersion,
  setLastLaunchedVersion,
  compareVersions,
} from '../utils/versionStorage';

export type VersionWelcomeType = 'upgrade' | 'downgrade';

type VersionWelcomeContextValue = {
  /** 是否显示版本欢迎界面 */
  showWelcome: boolean;
  /** 升级 / 降级；仅在 showWelcome 为 true 时有意义 */
  welcomeType: VersionWelcomeType | null;
  /** 当前应用版本 */
  currentVersion: string;
  /** 上一次启动时的版本（未记录过则为 null） */
  previousVersion: string | null;
  /** 关闭欢迎界面 */
  dismissWelcome: () => void;
};

const VersionWelcomeContext = createContext<VersionWelcomeContextValue | null>(null);

export function VersionWelcomeProvider({ children }: { children: React.ReactNode }) {
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcomeType, setWelcomeType] = useState<VersionWelcomeType | null>(null);
  const [previousVersion, setPreviousVersion] = useState<string | null>(null);

  const dismissWelcome = useCallback(() => {
    setShowWelcome(false);
    setWelcomeType(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const last = await getLastLaunchedVersion();
      if (cancelled) return;
      const prev = last?.trim() || null;
      setPreviousVersion(prev);

      if (!prev) {
        // 首次安装或从未记录过：视为「升级」展示欢迎
        setWelcomeType('upgrade');
        setShowWelcome(true);
      } else if (prev !== APP_VERSION) {
        const cmp = compareVersions(APP_VERSION, prev);
        if (cmp > 0) {
          setWelcomeType('upgrade');
          setShowWelcome(true);
        } else if (cmp < 0) {
          setWelcomeType('downgrade');
          setShowWelcome(true);
        }
      }

      await setLastLaunchedVersion(APP_VERSION);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value: VersionWelcomeContextValue = {
    showWelcome,
    welcomeType,
    currentVersion: APP_VERSION,
    previousVersion,
    dismissWelcome,
  };

  return (
    <VersionWelcomeContext.Provider value={value}>
      {children}
    </VersionWelcomeContext.Provider>
  );
}

export function useVersionWelcome(): VersionWelcomeContextValue {
  const ctx = useContext(VersionWelcomeContext);
  if (!ctx) {
    throw new Error('useVersionWelcome must be used within VersionWelcomeProvider');
  }
  return ctx;
}
