/** Board custom-appearance hooks (Custom Background feature): the appearance
 *  loader. Split out of `Board.hooks.ts` to keep each hooks file focused (and
 *  under the per-file hook cap). The background-panel disclosure moved to
 *  `BoardHeader.hooks.ts` with the header extraction. */
import { useEffect, useMemo, useState } from 'react';

import { type BoardAppearance,readBoardBackground } from '@/lib/bridge';

import { type AppearanceView,appearanceView, normalizeAppearance } from '../appearance';

/** Load + expose the active project's board appearance: normalizes the raw override
 *  to a complete/clamped appearance, derives the CSS variables / data attributes, and
 *  (re)reads the background image as a `data:` URL whenever the project or its
 *  background `version` changes — so a same-format replacement still busts the cached
 *  image. `appearanceOverride` is the project's raw `boardAppearance` (or `null`) and
 *  `backgroundVersion` its `boardBackground.version` (or `null` when none is set). */
export function useBoardAppearance(
  projectId: string,
  appearanceOverride: BoardAppearance | null,
  backgroundVersion: number | null,
): { appearance: BoardAppearance; view: AppearanceView; backgroundUrl: string | null } {
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);

  useEffect(() => {
    if (backgroundVersion === null) {
      setBackgroundUrl(null);
      return;
    }
    let cancelled = false;
    void readBoardBackground(projectId)
      .then((url) => {
        if (!cancelled) setBackgroundUrl(url);
      })
      .catch(() => {
        if (!cancelled) setBackgroundUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, backgroundVersion]);

  const appearance = useMemo(() => normalizeAppearance(appearanceOverride), [appearanceOverride]);
  const hasBackground = backgroundVersion !== null;
  const view = useMemo(() => appearanceView(appearance, hasBackground), [appearance, hasBackground]);
  return { appearance, view, backgroundUrl };
}
