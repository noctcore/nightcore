/** Data seam, load lifecycle, transcript/rename state, and pure formatting helpers
 *  for the session-history list. */
import { useCallback, useEffect, useState } from 'react';
import {
  getTaskSessionMessages as bridgeLoadMessages,
  listTaskSessions as bridgeLoadSessions,
  type SessionInfo,
  type SessionMessage,
} from '@/lib/bridge';
import type { SessionHistoryData } from './SessionHistory.types';

/** The live data seam — the real bridge. Stories/tests pass an in-memory override
 *  so the component renders without Tauri. */
export const LIVE_SESSION_DATA: SessionHistoryData = {
  loadSessions: bridgeLoadSessions,
  loadMessages: bridgeLoadMessages,
};

/** A session's display title: the user's custom title, else the auto-summary, else
 *  the first prompt, else a short id fallback. Pure. */
export function sessionTitle(session: SessionInfo): string {
  const candidate = session.customTitle ?? session.summary ?? session.firstPrompt ?? '';
  const trimmed = candidate.trim();
  if (trimmed.length > 0) return trimmed;
  return `Session ${session.sdkSessionId.slice(0, 8)}`;
}

/** Format a ms-epoch timestamp as a compact local date-time. Returns an empty
 *  string for a missing/invalid timestamp so the row can omit it. Pure. */
export function formatTimestamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Extract readable text from one transcript message's raw Anthropic `message`
 *  JSON (`{ role, content }`, where `content` is a string or an array of blocks).
 *  Joins every text block; returns an empty string when there is no text (e.g. a
 *  pure tool-use turn), so the caller can fall back to a type label. Pure. */
export function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n\n');
}

/** The load lifecycle for a task's session history. Fetches on mount (and whenever
 *  the task changes) through the injected data seam, degrading to an empty list on
 *  error (the bridge already returns `[]` outside Tauri). `reload` re-fetches after
 *  a rename/tag so the list reflects the change. */
export function useSessionHistory(
  taskId: string,
  data: SessionHistoryData,
): {
  sessions: SessionInfo[];
  loading: boolean;
  reload: () => void;
} {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void data
      .loadSessions(taskId)
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, data, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { sessions, loading, reload };
}

/** Lazy-load one session's transcript when its row expands. Caches per UUID so a
 *  re-expand doesn't re-fetch. Returns the messages for the currently-expanded row
 *  plus the per-row loading flag and the expand toggle. */
export function useSessionTranscript(
  taskId: string,
  data: SessionHistoryData,
): {
  expandedId: string | null;
  messages: SessionMessage[];
  loading: boolean;
  toggle: (sdkSessionId: string) => void;
} {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, SessionMessage[]>>({});
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(
    (sdkSessionId: string) => {
      setExpandedId((cur) => (cur === sdkSessionId ? null : sdkSessionId));
      if (cache[sdkSessionId] !== undefined) return;
      setLoading(true);
      void data
        .loadMessages(taskId, sdkSessionId)
        .then((msgs) => setCache((prev) => ({ ...prev, [sdkSessionId]: msgs })))
        .catch(() => setCache((prev) => ({ ...prev, [sdkSessionId]: [] })))
        .finally(() => setLoading(false));
    },
    [taskId, data, cache],
  );

  const messages = expandedId !== null ? (cache[expandedId] ?? []) : [];
  return { expandedId, messages, loading, toggle };
}

/** Which session row (if any) currently has its rename editor open, plus the draft
 *  title. Only one row edits at a time. The component reads `editingId`/`draft` and
 *  drives `open`/`change`/`close`. */
export function useRenameEditor(): {
  editingId: string | null;
  draft: string;
  open: (sdkSessionId: string, initial: string) => void;
  change: (value: string) => void;
  close: () => void;
} {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const open = useCallback((sdkSessionId: string, initial: string) => {
    setEditingId(sdkSessionId);
    setDraft(initial);
  }, []);
  const change = useCallback((value: string) => setDraft(value), []);
  const close = useCallback(() => setEditingId(null), []);
  return { editingId, draft, open, change, close };
}
