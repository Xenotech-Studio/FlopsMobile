import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Appearance, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkColors, lightColors, type AppColors } from '../theme/appColors';

const STORAGE_KEY = '@FlopsMobile/themePreference';

export type ThemePreference = 'system' | 'light' | 'dark';

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => Promise<void>;
  /** 解析后的亮/暗（已考虑用户选择与系统） */
  isDark: boolean;
  colors: AppColors;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveDark(pref: ThemePreference, system: string | null | undefined): boolean {
  if (pref === 'light') return false;
  if (pref === 'dark') return true;
  return system === 'dark';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPrefState] = useState<ThemePreference>('system');
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (cancelled) return;
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        setPrefState(raw);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [systemOverride, setSystemOverride] = useState<string | null | undefined>(systemScheme);
  useEffect(() => {
    setSystemOverride(systemScheme);
  }, [systemScheme]);

  useEffect(() => {
    if (preference !== 'system') return;
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemOverride(colorScheme);
    });
    return () => sub.remove();
  }, [preference]);

  const isDark = useMemo(
    () => resolveDark(preference, systemOverride),
    [preference, systemOverride]
  );

  const colors = useMemo(() => (isDark ? darkColors : lightColors), [isDark]);

  const setPreference = useCallback(async (p: ThemePreference) => {
    setPrefState(p);
    await AsyncStorage.setItem(STORAGE_KEY, p);
  }, []);

  const value = useMemo(
    () => ({
      preference,
      setPreference,
      isDark,
      colors,
    }),
    [preference, setPreference, isDark, colors]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useAppTheme must be used within ThemeProvider');
  }
  return ctx;
}

export const themePreferenceLabels: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};
