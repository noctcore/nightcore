/** The Settings card for user-configured external MCP servers: list, editor modal, and remove. */
import {
  Button,
  CloseIcon,
  ConfirmDialog,
  Kbd,
  LayersIcon,
  Modal,
  PlusIcon,
  useLastPresent,
} from '@/components/ui';
import { PROVIDER_LABEL } from '@/lib/bridge';

import { McpServerEditor } from './McpServerEditor';
import { McpServerRow } from './McpServerRow';
import { useMcpServersCard } from './McpServersCard.hooks';
import type { McpServersCardProps } from './McpServersCard.types';

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
          <p className="mt-0.5 text-xs-plus leading-snug text-muted-foreground">
            Extra Model Context Protocol servers injected into agent sessions, on top
            of your native {PROVIDER_LABEL} config. Tools run under the session permission mode.
          </p>
        </div>
        <Button variant="secondary" onClick={openAdd} className="shrink-0">
          <PlusIcon size={14} />
          Add server
        </Button>
      </div>

      <div className="pt-1.5">
        {servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs-plus text-muted-foreground">
            No MCP servers configured. Add one to expose its tools to new sessions.
          </div>
        ) : (
          servers.map((entry, i) => (
            <McpServerRow
              key={entry.id}
              entry={entry}
              divider={i > 0}
              onToggle={toggleEnabled}
              onEdit={openEdit}
              onRemove={requestRemove}
            />
          ))
        )}
      </div>

      <Modal
        open={draft !== null}
        label={shownDraft?.id === null ? 'Add MCP server' : 'Edit MCP server'}
        onClose={closeEditor}
        overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
        panelClassName="w-[480px] max-w-full"
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

            <McpServerEditor draft={shownDraft} errors={validation} onPatch={setDraft} />

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
