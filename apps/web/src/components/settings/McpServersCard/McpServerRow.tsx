/** One configured MCP server: name, transport tag, target, enable toggle, edit/remove. */
import { EditIcon, TrashIcon } from '@/components/ui';
import type { McpServerEntry } from '@/lib/bridge';

/** A small toggle switch (shared visual with the settings Toggle). */
export function RowToggle({
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

/** A one-line summary of an entry's transport target (command or url). */
function describe(entry: McpServerEntry): string {
  return entry.config.transport === 'stdio'
    ? entry.config.command
    : entry.config.url;
}

/** A single server row in the card list. `divider` draws the top border for all
 *  but the first row. All actions bubble the whole entry back to the card. */
export function McpServerRow({
  entry,
  divider,
  onToggle,
  onEdit,
  onRemove,
}: {
  entry: McpServerEntry;
  divider: boolean;
  onToggle: (entry: McpServerEntry) => void;
  onEdit: (entry: McpServerEntry) => void;
  onRemove: (entry: McpServerEntry) => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 py-3 ${divider ? 'border-t border-border' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs-plus3 font-medium">{entry.name}</span>
          <span className="rounded bg-white/[0.06] px-1.5 py-px font-mono text-4xs-plus uppercase tracking-[0.06em] text-muted-foreground">
            {entry.config.transport}
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-2xs-plus text-muted-foreground">
          {describe(entry)}
        </div>
      </div>
      <RowToggle
        on={entry.enabled}
        onChange={() => onToggle(entry)}
        label={`${entry.enabled ? 'Disable' : 'Enable'} ${entry.name}`}
      />
      <button
        type="button"
        aria-label={`Edit ${entry.name}`}
        title="Edit"
        onClick={() => onEdit(entry)}
        className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
      >
        <EditIcon size={15} />
      </button>
      <button
        type="button"
        aria-label={`Remove ${entry.name}`}
        title="Remove"
        onClick={() => onRemove(entry)}
        className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
      >
        <TrashIcon size={15} />
      </button>
    </div>
  );
}
