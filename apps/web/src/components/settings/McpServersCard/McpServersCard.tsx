/** The Settings card for user-configured external MCP servers: list, editor modal, and remove. */
import {
  Button,
  CloseIcon,
  ConfirmDialog,
  EditIcon,
  Kbd,
  LayersIcon,
  Modal,
  PlusIcon,
  TrashIcon,
  useLastPresent,
} from '@/components/ui';
import type { McpServerEntry } from '@/lib/bridge';

import { useMcpServersCard } from './McpServersCard.hooks';
import type {
  McpServerDraft,
  McpServersCardProps,
  McpTransport,
} from './McpServersCard.types';

/** The selectable transports, as `[value, label]` pairs for the segmented control. */
const TRANSPORTS: [value: McpTransport, label: string][] = [
  ['stdio', 'stdio'],
  ['http', 'HTTP'],
  ['sse', 'SSE'],
];

/** Shared Tailwind classes for the editor's labels and inputs/textareas. */
const FIELD_LABEL = 'mb-1.5 block text-[11.5px] font-semibold text-muted-foreground';
const FIELD_INPUT =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary';
const FIELD_AREA = `${FIELD_INPUT} font-mono text-[12.5px] leading-relaxed`;

/** A one-line summary of an entry's transport target (command or url). */
function describe(entry: McpServerEntry): string {
  return entry.config.transport === 'stdio'
    ? entry.config.command
    : entry.config.url;
}

/** A small toggle switch (shared visual with the settings Toggle). */
function RowToggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={`inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full px-0.5 transition-colors ${on ? 'bg-primary' : 'bg-white/[0.12]'}`}
    >
      <span
        className={`h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : ''}`}
      />
    </button>
  );
}

/** The transport-aware editor body. stdio shows command/args/env; http+sse show
 *  url/headers. Secret-bearing fields (env/header values) are masked on edit. */
function Editor({
  draft,
  errors,
  onPatch,
}: {
  draft: McpServerDraft;
  errors: { name?: string; command?: string; url?: string };
  onPatch: (patch: Partial<McpServerDraft>) => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-5">
      <div>
        <label className={FIELD_LABEL} htmlFor="mcp-name">
          Server name
        </label>
        <input
          id="mcp-name"
          value={draft.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="filesystem"
          className={FIELD_INPUT}
          aria-invalid={errors.name !== undefined}
          aria-describedby={
            errors.name !== undefined ? 'mcp-name-help mcp-name-error' : 'mcp-name-help'
          }
        />
        <p id="mcp-name-help" className="mt-1 text-[11px] text-muted-foreground">
          The tool prefix becomes <span className="font-mono">mcp__{draft.name || 'name'}__*</span>.
        </p>
        {errors.name !== undefined && (
          <p id="mcp-name-error" className="mt-1 text-[11px] text-warning">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <span className={FIELD_LABEL}>Transport</span>
        <div className="inline-flex rounded-lg border border-border bg-black/20 p-0.5">
          {TRANSPORTS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => onPatch({ transport: v })}
              className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
                v === draft.transport
                  ? 'bg-primary/[0.18] text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-command">
              Command
            </label>
            <input
              id="mcp-command"
              value={draft.command}
              onChange={(e) => onPatch({ command: e.target.value })}
              placeholder="npx"
              className={`${FIELD_INPUT} font-mono`}
              aria-invalid={errors.command !== undefined}
              aria-describedby={
                errors.command !== undefined ? 'mcp-command-error' : undefined
              }
            />
            {errors.command !== undefined && (
              <p id="mcp-command-error" className="mt-1 text-[11px] text-warning">
                {errors.command}
              </p>
            )}
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-args">
              Arguments
            </label>
            <textarea
              id="mcp-args"
              rows={3}
              value={draft.argsText}
              onChange={(e) => onPatch({ argsText: e.target.value })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
              className={FIELD_AREA}
              aria-describedby="mcp-args-help"
            />
            <p id="mcp-args-help" className="mt-1 text-[11px] text-muted-foreground">
              One argument per line.
            </p>
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-env">
              Environment
            </label>
            <textarea
              id="mcp-env"
              rows={2}
              value={draft.envText}
              onChange={(e) => onPatch({ envText: e.target.value })}
              placeholder="API_TOKEN=secret"
              className={FIELD_AREA}
              aria-describedby="mcp-env-help"
            />
            <p id="mcp-env-help" className="mt-1 text-[11px] text-muted-foreground">
              <span className="font-mono">KEY=value</span> per line. Existing values are
              masked — retype to change.
            </p>
          </div>
        </>
      ) : (
        <>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-url">
              URL
            </label>
            <input
              id="mcp-url"
              value={draft.url}
              onChange={(e) => onPatch({ url: e.target.value })}
              placeholder="https://example.com/mcp"
              className={`${FIELD_INPUT} font-mono`}
              aria-invalid={errors.url !== undefined}
              aria-describedby={errors.url !== undefined ? 'mcp-url-error' : undefined}
            />
            {errors.url !== undefined && (
              <p id="mcp-url-error" className="mt-1 text-[11px] text-warning">
                {errors.url}
              </p>
            )}
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-headers">
              Headers
            </label>
            <textarea
              id="mcp-headers"
              rows={2}
              value={draft.headersText}
              onChange={(e) => onPatch({ headersText: e.target.value })}
              placeholder="Authorization: Bearer token"
              className={FIELD_AREA}
              aria-describedby="mcp-headers-help"
            />
            <p id="mcp-headers-help" className="mt-1 text-[11px] text-muted-foreground">
              <span className="font-mono">Header: value</span> per line. Existing values
              are masked — retype to change.
            </p>
          </div>
        </>
      )}

      {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- wraps a custom role=switch button (a labelable element that forwards label clicks); the switch carries its own accessible name */}
      <label className="flex items-center gap-2.5 text-[13px] text-foreground">
        <RowToggle
          on={draft.enabled}
          onChange={() => onPatch({ enabled: !draft.enabled })}
          label="Enable this server"
        />
        Inject into new sessions
      </label>
    </div>
  );
}

/**
 * The Settings card for user-configured external MCP servers: a list of entries
 * (name, transport, target, an enable toggle, edit/remove) plus an Add action and
 * a transport-aware editor modal. All edits emit the WHOLE next list via `onChange`
 * (whole-list replace), routed global or per-project by the parent scope.
 */
export function McpServersCard({ servers, onChange }: McpServersCardProps) {
  const {
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
  } = useMcpServersCard(servers, onChange);
  // Retain the editor draft across the exit animation so the modal keeps its
  // fields while it slides out (the parent clears `draft` to null on close).
  const shownDraft = useLastPresent(draft);

  return (
    <section className="mb-[18px] rounded-2xl border border-border bg-card px-[22px] pb-2 pt-[22px]">
      <div className="flex items-start gap-3.5 pb-1.5">
        <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
          <LayersIcon size={18} />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="text-lg font-semibold tracking-tight">External MCP servers</h2>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
            Extra Model Context Protocol servers injected into agent sessions, on top
            of your native Claude config. Tools run under the session permission mode.
          </p>
        </div>
        <Button variant="secondary" onClick={openAdd} className="shrink-0">
          <PlusIcon size={14} />
          Add server
        </Button>
      </div>

      <div className="pt-1.5">
        {servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-muted-foreground">
            No MCP servers configured. Add one to expose its tools to new sessions.
          </div>
        ) : (
          servers.map((entry, i) => (
            <div
              key={entry.id}
              className={`flex items-center gap-3 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{entry.name}</span>
                  <span className="rounded bg-white/[0.06] px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-muted-foreground">
                    {entry.config.transport}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
                  {describe(entry)}
                </div>
              </div>
              <RowToggle
                on={entry.enabled}
                onChange={() => toggleEnabled(entry)}
                label={`${entry.enabled ? 'Disable' : 'Enable'} ${entry.name}`}
              />
              <button
                type="button"
                aria-label={`Edit ${entry.name}`}
                title="Edit"
                onClick={() => openEdit(entry)}
                className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
              >
                <EditIcon size={15} />
              </button>
              <button
                type="button"
                aria-label={`Remove ${entry.name}`}
                title="Remove"
                onClick={() => requestRemove(entry)}
                className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
              >
                <TrashIcon size={15} />
              </button>
            </div>
          ))
        )}
      </div>

      <Modal
        open={draft !== null}
        label={shownDraft?.id === null ? 'Add MCP server' : 'Edit MCP server'}
        onClose={closeEditor}
        overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
        panelClassName="w-[480px] max-w-full overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
      >
        {shownDraft !== null && (
          <>
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-primary/[0.12] text-primary">
                <LayersIcon size={16} />
              </div>
              <div className="flex-1">
                <div className="text-base font-semibold">
                  {shownDraft.id === null ? 'Add MCP server' : 'Edit MCP server'}
                </div>
                <div className="text-xs text-muted-foreground">
                  Configure an external Model Context Protocol server.
                </div>
              </div>
              <button
                type="button"
                aria-label="Close dialog"
                title="Close"
                onClick={closeEditor}
                className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
              >
                <CloseIcon size={16} />
              </button>
            </div>

            <Editor draft={shownDraft} errors={validation} onPatch={setDraft} />

            <div className="flex items-center justify-end gap-2.5 border-t border-border bg-black/15 px-5 py-3.5">
              <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
                <Kbd>Esc</Kbd> to cancel
              </span>
              <Button variant="secondary" onClick={closeEditor}>
                Cancel
              </Button>
              <Button onClick={saveDraft} disabled={!validation.ok}>
                {shownDraft.id === null ? 'Add' : 'Save changes'}
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove MCP server"
        message={
          pendingRemove !== null ? (
            <>
              Remove <span className="font-semibold">{pendingRemove.name}</span>? New
              sessions will no longer inject its tools.
            </>
          ) : null
        }
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
        onCancel={cancelRemove}
      />
    </section>
  );
}
