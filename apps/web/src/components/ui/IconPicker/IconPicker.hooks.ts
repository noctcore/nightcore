import { useMemo, useState } from 'react';

import { PROJECT_ICON_NAMES } from '../ProjectIcon/ProjectIcon.icons';

/** Search query state for {@link IconPicker}. */
export function useIconPicker() {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return PROJECT_ICON_NAMES;
    return PROJECT_ICON_NAMES.filter((name) => name.toLowerCase().includes(q));
  }, [query]);

  return { query, setQuery, filtered };
}
