import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '../api';
import { DEFAULT_SERVER_URL, normalizeServerUrl } from '../config';
import { clearStoredKUser } from '../lib/kUserStorage';

const STORAGE_KEY_SESSION = '@FlopsMobile/session';

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
    setServerBaseUrlState(normalizeServerUrl(url));
  }, []);

  const loginSuccess = useCallback(async (s: Session) => {
    setSession(s);
    await AsyncStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(s));
    setServerBaseUrl(s.server_base_url);
  }, [setServerBaseUrl]);

  const logout = useCallback(async () => {
    setSession(null);
    await AsyncStorage.removeItem(STORAGE_KEY_SESSION);
    await clearStoredKUser();
  }, []);

  const restoreSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY_SESSION);
      if (stored) {
        const s = JSON.parse(stored) as Session;
        if (s.access_token && s.user_id && s.server_base_url) {
          setSession(s);
          setServerBaseUrlState(normalizeServerUrl(s.server_base_url));
          return;
        }
      }
      setServerBaseUrlState(DEFAULT_SERVER_URL);
    } catch {
      setServerBaseUrlState(DEFAULT_SERVER_URL);
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
