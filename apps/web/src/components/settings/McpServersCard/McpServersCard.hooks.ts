/** Draft state, secret masking, validation, and CRUD for the MCP servers card. */
import { useCallback, useMemo, useState } from 'react';

import type { McpServerEntry, McpServerTransport } from '@/lib/bridge';

import type {
  McpDraftValidation,
  McpServerDraft,
} from './McpServersCard.types';

/**
 * The mask token shown in place of a stored secret value (env/header values) when
 * editing an existing entry, so the form never echoes the plaintext secret back.
 * On save, a value still equal to this token is restored from the original stored
 * value (the user didn't change it); any other value is taken as a fresh write.
 * Decision: secrets are MASKED IN UI, PLAINTEXT AT REST.
 */
const SECRET_MASK = '••••••••';

/** A safe SDK server key / `mcp__<name>__*` tool prefix: letters, digits, `_`/`-`.
 *  The SDK keys the `mcpServers` record on this, so it must be unique + safe. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Split a textarea into trimmed, non-empty lines (args / env / headers editors). */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Render a `Record<string,string>` as masked `KEY=•••` lines for the env editor.
 *  Keys are shown; values are masked so the plaintext secret is never echoed. */
function maskEnvText(env: Record<string, string>): string {
  return Object.keys(env)
    .map((k) => `${k}=${SECRET_MASK}`)
    .join('\n');
}

/** Render headers as masked `Header: •••` lines for the headers editor. */
function maskHeadersText(headers: Record<string, string>): string {
  return Object.keys(headers)
    .map((k) => `${k}: ${SECRET_MASK}`)
    .join('\n');
}

/** Parse `KEY=value` lines into a map, restoring an unchanged masked value from
 *  `original` (so editing an entry without retyping a secret keeps it). A masked
 *  value with no original (a brand-new key the user left masked) is dropped. */
function parseEnv(
  text: string,
  original: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines(text)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no key, or `=value` — skip
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length === 0) continue;
    if (value === SECRET_MASK) {
      if (original[key] !== undefined) out[key] = original[key];
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Parse `Header: value` lines into a map, restoring unchanged masked values. */
function parseHeaders(
  text: string,
  original: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines(text)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;
    if (value === SECRET_MASK) {
      if (original[key] !== undefined) out[key] = original[key];
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** A fresh, empty draft for the "add server" path (stdio by default). */
function emptyDraft(): McpServerDraft {
  return {
    id: null,
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
  };
}

/** Hydrate the editor draft from an existing entry, masking secret values. */
function draftFromEntry(entry: McpServerEntry): McpServerDraft {
  const base: McpServerDraft = { ...emptyDraft(), id: entry.id, name: entry.name, enabled: entry.enabled };
  const { config } = entry;
  if (config.transport === 'stdio') {
    return {
      ...base,
      transport: 'stdio',
      command: config.command,
      argsText: config.args.join('\n'),
      envText: maskEnvText(config.env),
    };
  }
  return {
    ...base,
    transport: config.transport,
    url: config.url,
    headersText: maskHeadersText(config.headers),
  };
}

/** The original secret maps for the entry being edited, so an unchanged masked
 *  value can be restored on save. Empty for an add. */
function originalSecrets(
  entry: McpServerEntry | undefined,
): { env: Record<string, string>; headers: Record<string, string> } {
  if (entry === undefined) return { env: {}, headers: {} };
  const { config } = entry;
  if (config.transport === 'stdio') return { env: config.env, headers: {} };
  return { env: {}, headers: config.headers };
}

/** Build the persisted `McpServerEntry` from the current draft + the original
 *  secrets (for masked-value restoration) + a generated id for an add. */
function entryFromDraft(
  draft: McpServerDraft,
  original: { env: Record<string, string>; headers: Record<string, string> },
  id: string,
): McpServerEntry {
  const name = draft.name.trim();
  let config: McpServerTransport;
  if (draft.transport === 'stdio') {
    config = {
      transport: 'stdio',
      command: draft.command.trim(),
      args: lines(draft.argsText),
      env: parseEnv(draft.envText, original.env),
    };
  } else {
    config = {
      transport: draft.transport,
      url: draft.url.trim(),
      headers: parseHeaders(draft.headersText, original.headers),
    };
  }
  return { id, name, enabled: draft.enabled, config };
}

/** Validate the draft: a unique, safe name and the transport's required field. */
function validate(draft: McpServerDraft, servers: McpServerEntry[]): McpDraftValidation {
  const result: McpDraftValidation = { ok: true };
  const name = draft.name.trim();
  if (name.length === 0) {
    result.name = 'A server name is required.';
  } else if (!NAME_PATTERN.test(name)) {
    result.name = 'Use letters, digits, hyphens, or underscores only.';
  } else if (
    servers.some((s) => s.name === name && s.id !== draft.id)
  ) {
    result.name = 'Another server already uses this name.';
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim().length === 0) {
      result.command = 'A command is required for a stdio server.';
    }
  } else {
    const url = draft.url.trim();
    if (url.length === 0) {
      result.url = 'A URL is required.';
    } else if (!/^https?:\/\/.+/i.test(url)) {
      result.url = 'Enter an http(s) URL.';
    }
  }
  result.ok =
    result.name === undefined &&
    result.command === undefined &&
    result.url === undefined;
  return result;
}

/** Generate a stable entry id. `crypto.randomUUID` is available in the webview and
 *  the test environment; the fallback keeps it defined in any other runtime. */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The state and CRUD actions the MCP servers card binds to. */
export interface McpServersCardState {
  /** The draft currently open in the editor modal, or `null` when closed. */
  draft: McpServerDraft | null;
  /** Live validation of the open draft (no draft ⇒ a closed/ok sentinel). */
  validation: McpDraftValidation;
  /** The entry queued for removal (confirm dialog), or `null`. */
  pendingRemove: McpServerEntry | null;
  /** Open the editor with a blank draft (add). */
  openAdd: () => void;
  /** Open the editor seeded from an existing entry (edit). */
  openEdit: (entry: McpServerEntry) => void;
  /** Mutate the open draft. */
  setDraft: (patch: Partial<McpServerDraft>) => void;
  /** Close the editor without saving. */
  closeEditor: () => void;
  /** Persist the open draft (add or replace) and close. No-op if invalid. */
  saveDraft: () => void;
  /** Flip an entry's `enabled` and persist (whole-list replace). */
  toggleEnabled: (entry: McpServerEntry) => void;
  /** Queue an entry for removal (opens the confirm dialog). */
  requestRemove: (entry: McpServerEntry) => void;
  /** Dismiss the remove confirm dialog. */
  cancelRemove: () => void;
  /** Confirm removal: drop the entry and persist. */
  confirmRemove: () => void;
}

/**
 * Owns the MCP card's local UI state (the editor draft, the remove confirmation)
 * and the CRUD operations, each of which resolves to "here is the whole next
 * list" and calls `onChange`. The component shell stays presentation-only.
 */
export function useMcpServersCard(
  servers: McpServerEntry[],
  onChange: (next: McpServerEntry[]) => void,
): McpServersCardState {
  const [draft, setDraftState] = useState<McpServerDraft | null>(null);
  const [pendingRemove, setPendingRemove] = useState<McpServerEntry | null>(null);

  const validation = useMemo<McpDraftValidation>(
    () => (draft === null ? { ok: false } : validate(draft, servers)),
    [draft, servers],
  );

  const openAdd = useCallback(() => setDraftState(emptyDraft()), []);
  const openEdit = useCallback(
    (entry: McpServerEntry) => setDraftState(draftFromEntry(entry)),
    [],
  );
  const closeEditor = useCallback(() => setDraftState(null), []);

  const setDraft = useCallback((patch: Partial<McpServerDraft>) => {
    setDraftState((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }, []);

  const saveDraft = useCallback(() => {
    if (draft === null || !validate(draft, servers).ok) return;
    const existing =
      draft.id === null ? undefined : servers.find((s) => s.id === draft.id);
    const id = existing?.id ?? newId();
    const next = entryFromDraft(draft, originalSecrets(existing), id);
    const list =
      existing === undefined
        ? [...servers, next]
        : servers.map((s) => (s.id === id ? next : s));
    setDraftState(null);
    onChange(list);
  }, [draft, servers, onChange]);

  const toggleEnabled = useCallback(
    (entry: McpServerEntry) => {
      onChange(
        servers.map((s) =>
          s.id === entry.id ? { ...s, enabled: !s.enabled } : s,
        ),
      );
    },
    [servers, onChange],
  );

  const requestRemove = useCallback(
    (entry: McpServerEntry) => setPendingRemove(entry),
    [],
  );
  const cancelRemove = useCallback(() => setPendingRemove(null), []);
  const confirmRemove = useCallback(() => {
    if (pendingRemove !== null) {
      onChange(servers.filter((s) => s.id !== pendingRemove.id));
    }
    setPendingRemove(null);
  }, [pendingRemove, servers, onChange]);

  return {
    draft,
    validation,
    pendingRemove,
    openAdd,
    openEdit,
    setDraft,
    closeEditor,
    saveDraft,
    toggleEnabled,
    requestRemove,
    cancelRemove,
    confirmRemove,
  };
}
