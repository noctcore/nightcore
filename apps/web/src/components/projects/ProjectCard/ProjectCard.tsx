/** @file ProjectCard — a single project card plus its inline rename dialog. */
import {
  Badge,
  Button,
  Card,
  ClockIcon,
  ConfirmDialog,
  DotsIcon,
  EditIcon,
  FolderIcon,
  IconButton,
  IconTile,
  Kbd,
  Menu,
  Modal,
  StatusDot,
  TrashIcon,
} from '@/components/ui';

import { useProjectCard } from './ProjectCard.hooks';
import type { ProjectCardProps, ProjectSummary } from './ProjectCard.types';

const STAT_TONE: Record<ProjectSummary['stats'][number]['tone'], string> = {
  neutral: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
};

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

/** A single project card on the Projects view — repo identity, live badge,
 *  stat tiles, and last activity. The kebab opens a menu (Rename / Remove);
 *  Remove is guarded by a confirmation that clarifies files on disk are kept. */
export function ProjectCard({ project, onOpen, onRename, onDelete }: ProjectCardProps) {
  const card = useProjectCard({ project, onRename, onDelete });
  const hasMenu = onRename !== undefined || onDelete !== undefined;

  return (
    <Card className="p-[18px]">
      <div className="flex items-start gap-3">
        {/* The identity block is the open affordance; the menu button is a
            sibling, never nested inside another button (invalid HTML). */}
        <button
          type="button"
          onClick={() => onOpen(project.id)}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <IconTile size="sm" className="h-[38px] w-[38px] rounded-[10px]">
            <FolderIcon size={18} />
          </IconTile>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[15.5px] font-semibold">
                {project.name}
              </span>
              {project.running && (
                <Badge tone="primary" className="text-warning">
                  <StatusDot colorClass="bg-warning" pulse />
                  live
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
              {project.path}
            </span>
          </span>
        </button>
        {hasMenu && (
          <Menu
            label="Project menu"
            trigger={
              <IconButton label="Project menu">
                <DotsIcon size={16} />
              </IconButton>
            }
            items={[
              ...(onRename !== undefined
                ? [{ label: 'Rename', icon: <EditIcon size={14} />, onClick: card.openRename }]
                : []),
              ...(onDelete !== undefined
                ? [
                    {
                      label: 'Remove',
                      icon: <TrashIcon size={14} />,
                      onClick: card.openRemove,
                      destructive: true,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </div>
      <div className="mt-4 flex gap-1.5">
        {project.stats.map((s) => (
          <div
            key={s.label}
            className="flex-1 rounded-[9px] bg-white/[0.025] px-1 py-2 text-center"
          >
            <div
              className={`font-mono text-base font-semibold tabular-nums ${STAT_TONE[s.tone]}`}
            >
              {s.value}
            </div>
            <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              {s.label}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <ClockIcon size={12} />
        <span>{project.activity}</span>
      </div>

      <RenameDialog
        open={card.overlay === 'rename'}
        value={card.draftName}
        canSubmit={card.canRename}
        onChange={card.setDraftName}
        onSubmit={card.submitRename}
        onCancel={card.closeOverlay}
      />

      <ConfirmDialog
        open={card.overlay === 'confirm-remove'}
        title="Remove project?"
        message={
          <>
            <span className="font-medium text-foreground">{project.name}</span> will be
            removed from Nightcore. This does not delete the repository or any files on
            disk — only its entry here.
          </>
        }
        confirmLabel="Remove"
        destructive
        onConfirm={card.confirmRemove}
        onCancel={card.closeOverlay}
      />
    </Card>
  );
}

interface RenameDialogProps {
  open: boolean;
  value: string;
  canSubmit: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** A small centered dialog to edit a project's display name. Built on the shared
 *  `<Modal>` primitive (focus trap + restore-to-opener); Esc / click-outside
 *  cancel; ↵ submits when the name is valid. Mirrors the app's dialog chrome. */
function RenameDialog({ open, value, canSubmit, onChange, onSubmit, onCancel }: RenameDialogProps) {
  return (
    <Modal
      open={open}
      label="Rename project"
      onClose={onCancel}
      onEnter={canSubmit ? onSubmit : undefined}
    >
      <div className="flex flex-col gap-3 px-5 pb-4 pt-5">
        <h2 className="text-base font-semibold text-foreground">Rename project</h2>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Project name"
          aria-label="Project name"
          className={INPUT_CLASS}
        />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>↵</Kbd> to save
        </span>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={!canSubmit}>
          Save
        </Button>
      </div>
    </Modal>
  );
}
