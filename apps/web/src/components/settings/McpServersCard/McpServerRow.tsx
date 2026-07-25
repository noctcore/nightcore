/** One configured MCP server: name, transport tag, target, enable toggle, edit/remove. */
import { EditIcon, IconButton, Toggle, TrashIcon } from '@/components/ui';
import type { McpServerEntry } from '@/lib/bridge';

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
      <Toggle
        on={entry.enabled}
        onChange={() => onToggle(entry)}
        label={`${entry.enabled ? 'Disable' : 'Enable'} ${entry.name}`}
      />
      <IconButton label={`Edit ${entry.name}`} onClick={() => onEdit(entry)}>
        <EditIcon size={15} />
      </IconButton>
      <IconButton
        label={`Remove ${entry.name}`}
        onClick={() => onRemove(entry)}
        className="enabled:hover:bg-destructive/15 enabled:hover:text-destructive"
      >
        <TrashIcon size={15} />
      </IconButton>
    </div>
  );
}
