import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '../api';
import { DEFAULT_SERVER_URL, normalizeServerUrl } from '../config';

const STORAGE_KEY_SESSION = '@FlopsMobile/session';
const STORAGE_KEY_SERVER = '@FlopsMobile/serverUrl';

type SessionContextValue = {
  session: Session | null;
  serverBaseUrl: string;
  setServerBaseUrl: (url: string) => void;
  loginSuccess: (session: Session) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<void>;
  isLoading: boolean;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [serverBaseUrl, setServerBaseUrlState] = useState(DEFAULT_SERVER_URL);
  const [isLoading, setIsLoading] = useState(true);

  const setServerBaseUrl = useCallback((url: string) => {
    const normalized = normalizeServerUrl(url);
    setServerBaseUrlState(normalized);
    AsyncStorage.setItem(STORAGE_KEY_SERVER, normalized);
  }, []);

  const loginSuccess = useCallback(async (s: Session) => {
    setSession(s);
    await AsyncStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(s));
    setServerBaseUrl(s.server_base_url);
  }, [setServerBaseUrl]);

  const logout = useCallback(async () => {
    setSession(null);
    await AsyncStorage.removeItem(STORAGE_KEY_SESSION);
  }, []);

  const restoreSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const [stored, serverUrl] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY_SESSION),
        AsyncStorage.getItem(STORAGE_KEY_SERVER),
      ]);
      if (serverUrl) setServerBaseUrlState(normalizeServerUrl(serverUrl));
      if (stored) {
        const s = JSON.parse(stored) as Session;
        if (s.access_token && s.user_id && s.server_base_url) setSession(s);
      }
    } catch {
      // 忽略解析错误
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  const value: SessionContextValue = {
    session,
    serverBaseUrl,
    setServerBaseUrl,
    loginSuccess,
    logout,
    restoreSession,
    isLoading,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
