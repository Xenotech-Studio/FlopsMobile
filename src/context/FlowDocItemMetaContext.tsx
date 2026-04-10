import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { fetchWithDebugLog } from '../utils/httpDebugLog';

export const FlowDocItemMetaContext = createContext<
  ((docId: string, conversationId?: string) => Promise<string | null>) | null
>(null);

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { name: string | null; t: number }>();

function cacheKey(docId: string, conversationId: string): string {
  return `${docId}\0${conversationId || ''}`;
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

type ProviderProps = {
  children: React.ReactNode;
  conversationId: string;
  serverBaseUrl: string;
  accessToken: string;
};

export function FlowDocItemMetaProvider({
  children,
  conversationId,
  serverBaseUrl,
  accessToken,
}: ProviderProps) {
  const fetchName = useCallback(
    async (docId: string, convId?: string) => {
      const id = String(docId || '').trim();
      if (!id) return null;
      const cid = String(convId ?? conversationId ?? '').trim();
      const key = cacheKey(id, cid);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.t < TTL_MS) return hit.name;

      const base = ensureSlash(serverBaseUrl);
      const q = cid ? `?conversation_id=${encodeURIComponent(cid)}` : '';
      const url = `${base}api/flowdoc/tree/item/${encodeURIComponent(id)}${q}`;
      try {
        const res = await fetchWithDebugLog(url, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          name?: string | null;
        };
        if (!data.success || data.name == null) {
          cache.set(key, { name: null, t: Date.now() });
          return null;
        }
        const n = String(data.name).trim();
        const resolved = n || null;
        cache.set(key, { name: resolved, t: Date.now() });
        return resolved;
      } catch {
        cache.set(key, { name: null, t: Date.now() });
        return null;
      }
    },
    [conversationId, serverBaseUrl, accessToken]
  );

  return (
    <FlowDocItemMetaContext.Provider value={fetchName}>{children}</FlowDocItemMetaContext.Provider>
  );
}

/**
 * 解析 FlowDoc 文档显示名（依赖上层 FlowDocItemMetaProvider）。
 */
export function useFlowDocItemTitle(docId: string, conversationId: string | undefined): string | null {
  const fetchName = useContext(FlowDocItemMetaContext);
  const id = typeof docId === 'string' ? docId.trim() : '';

  const [name, setName] = useState<string | null>(() => {
    if (!id) return null;
    const hit = cache.get(cacheKey(id, String(conversationId || '').trim()));
    return hit && Date.now() - hit.t < TTL_MS ? hit.name : null;
  });

  useEffect(() => {
    if (!id || typeof fetchName !== 'function') {
      setName(null);
      return;
    }
    const key = cacheKey(id, String(conversationId || '').trim());
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL_MS) {
      setName(hit.name);
      return;
    }
    let cancelled = false;
    fetchName(id, conversationId)
      .then((n) => {
        if (cancelled) return;
        const resolved = n && String(n).trim() ? String(n).trim() : null;
        cache.set(key, { name: resolved, t: Date.now() });
        setName(resolved);
      })
      .catch(() => {
        if (!cancelled) {
          cache.set(key, { name: null, t: Date.now() });
          setName(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, conversationId, fetchName]);

  return name;
}
