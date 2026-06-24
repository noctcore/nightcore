import type { McpServerEntry, McpServerTransport } from '@/lib/bridge';

/** The transport tag the form draft is currently editing. */
export type McpTransport = McpServerTransport['transport'];

export interface McpServersCardProps {
  /** The MCP server list in effect for the current scope (global, or a project
   *  override). The card edits a COPY and emits the whole next list. */
  servers: McpServerEntry[];
  /** Persist the full next list (whole-list replace — add/edit/remove/toggle all
   *  resolve to "here is the new list"). Routed to the global block or the active
   *  project's override by the parent settings view, like every other control. */
  onChange: (next: McpServerEntry[]) => void;
}

/**
 * The editor draft — a flat, all-fields form the modal binds to. `args` and the
 * `env`/`headers` maps are edited as raw multiline text (one `KEY=value` or arg
 * per line) and parsed on save, so the draft stays a plain string bag the inputs
 * can drive directly. `id` is `null` for an add, the entry id for an edit.
 */
export interface McpServerDraft {
  /** `null` ⇒ adding a new entry; a string ⇒ editing the entry with that id. */
  id: string | null;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** stdio: the executable. */
  command: string;
  /** stdio: one argument per line. */
  argsText: string;
  /** stdio: `KEY=value` per line. Secret values are masked on edit (see hook). */
  envText: string;
  /** http/sse: the server URL. */
  url: string;
  /** http/sse: `Header: value` per line. Secret values are masked on edit. */
  headersText: string;
}

/** A field-level validation result for the draft. `ok` gates the save button. */
export interface McpDraftValidation {
  ok: boolean;
  /** Per-field error messages, shown under the offending input. */
  name?: string;
  command?: string;
  url?: string;
}
