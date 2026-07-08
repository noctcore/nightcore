import { useEffect, useState } from 'react';

import { readProjectIcon } from '@/lib/bridge';

/** In-memory cache keyed by `projectId:customIconPath` so rail/dropdown re-renders
 *  don't re-fetch the same bytes. */
const cache = new Map<string, string>();

function cacheKey(projectId: string, customIconPath: string): string {
  return `${projectId}:${customIconPath}`;
}

/** Load (and cache) a custom project icon data URL. Returns `null` when the project
 *  has no custom image or the read fails. */
export function useProjectIconUrl(
  projectId: string | undefined,
  customIconPath: string | null | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    if (projectId === undefined || customIconPath === null || customIconPath === undefined) {
      return null;
    }
    return cache.get(cacheKey(projectId, customIconPath)) ?? null;
  });

  useEffect(() => {
    if (projectId === undefined || customIconPath === null || customIconPath === undefined) {
      setUrl(null);
      return;
    }
    const key = cacheKey(projectId, customIconPath);
    const hit = cache.get(key);
    if (hit !== undefined) {
      setUrl(hit);
      return;
    }
    let cancelled = false;
    void readProjectIcon(projectId)
      .then((data) => {
        if (cancelled) return;
        if (data !== null) cache.set(key, data);
        setUrl(data);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, customIconPath]);

  return url;
}

/** Drop cached URLs for a project (after icon change). */
export function invalidateProjectIconCache(projectId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${projectId}:`)) cache.delete(key);
  }
}
