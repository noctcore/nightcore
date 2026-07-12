/** A shared folder-picker dialog (ported from AutoMaker's file browser, restyled to
 *  Nightcore): breadcrumb navigation over a one-level directory listing, a search
 *  filter, a recent-folders quick-jump, a home default, and loading/empty/error
 *  states. Single-click a folder to descend; double-click it (or use the footer
 *  button / Cmd+Enter) to choose it. Bare Enter never confirms (house dialog rule).
 *
 *  Presentational shell over {@link useFolderBrowser}, which owns navigation state,
 *  the localStorage-backed recents, and the click/double-click discriminator. */
import { pathLeaf } from '@/lib/path-display';

import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import {
  BranchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  FolderIcon,
  HomeIcon,
  SearchIcon,
} from '../icons';
import { Kbd } from '../Kbd';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';
import { useFolderBrowser } from './FolderBrowserDialog.hooks';
import {
  type Breadcrumb,
  DEFAULT_RECENTS_KEY,
  type FolderBrowserDialogProps,
} from './FolderBrowserDialog.types';

/** macOS uses ⌘, everything else Ctrl — computed once for the accelerator hint. */
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function BreadcrumbBar({
  crumbs,
  parentPath,
  disabled,
  onNavigate,
}: {
  crumbs: Breadcrumb[];
  parentPath: string | null;
  disabled: boolean;
  onNavigate: (path: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onNavigate(null)}
        disabled={disabled}
        title="Home"
        aria-label="Go to home directory"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border/70 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
      >
        <HomeIcon size={14} />
      </button>
      <button
        type="button"
        onClick={() => parentPath !== null && onNavigate(parentPath)}
        disabled={disabled || parentPath === null}
        title="Up one level"
        aria-label="Go up one level"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border/70 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-40"
      >
        <ChevronLeftIcon size={14} />
      </button>
      <nav
        aria-label="Current path"
        className="scrollbar-styled flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-[8px] border border-border/60 bg-black/20 px-2 py-1"
      >
        {crumbs.map((crumb, i) => (
          <span key={crumb.path} className="flex items-center gap-0.5">
            {i > 0 && (
              <ChevronRightIcon size={12} className="shrink-0 text-muted-foreground/50" aria-hidden />
            )}
            <button
              type="button"
              onClick={() => onNavigate(crumb.path)}
              disabled={disabled}
              className="rounded px-1 py-0.5 text-xs-flat text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-60"
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>
    </div>
  );
}

function RecentChips({
  recents,
  disabled,
  onPick,
  onRemove,
}: {
  recents: string[];
  disabled: boolean;
  onPick: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 flex items-center gap-1 text-2xs text-muted-foreground">
        <ClockIcon size={12} />
        Recent
      </span>
      {recents.map((folder) => (
        <span
          key={folder}
          className="group flex items-center gap-1 rounded-[7px] border border-border/70 bg-black/10 pl-2 pr-1 text-2xs"
        >
          <button
            type="button"
            onClick={() => onPick(folder)}
            disabled={disabled}
            title={folder}
            className="flex items-center gap-1 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            <FolderIcon size={11} className="shrink-0 text-primary/80" />
            <span className="max-w-[140px] truncate">{pathLeaf(folder)}</span>
          </button>
          <button
            type="button"
            onClick={() => onRemove(folder)}
            title="Remove from recent"
            aria-label={`Remove ${pathLeaf(folder)} from recent`}
            className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          >
            <CloseIcon size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

function FolderRow({
  name,
  isGitRepo,
  disabled,
  onClick,
  onDoubleClick,
}: {
  name: string;
  isGitRepo: boolean;
  disabled: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className="group flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/30 disabled:opacity-60"
    >
      {isGitRepo ? (
        <BranchIcon size={15} className="shrink-0 text-primary/80" aria-label="git repository" />
      ) : (
        <FolderIcon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-xs-plus2 text-foreground">{name}</span>
      <ChevronRightIcon
        size={14}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
    </button>
  );
}

export function FolderBrowserDialog({
  open,
  onClose,
  onSelect,
  title = 'Choose a folder',
  description = 'Navigate to a folder, or double-click to pick it.',
  initialPath = null,
  recentsKey = DEFAULT_RECENTS_KEY,
  selectLabel = 'Select this folder',
}: FolderBrowserDialogProps) {
  const v = useFolderBrowser({ open, initialPath, recentsKey, onSelect, onClose });
  const currentLeaf = v.currentPath === '' ? '' : pathLeaf(v.currentPath);

  return (
    <Modal
      open={open}
      label={title}
      initialFocus="[data-folder-search]"
      panelClassName="flex max-h-[85vh] w-full max-w-2xl flex-col"
      onClose={onClose}
    >
      <div className="flex flex-col gap-1 px-5 pb-3 pt-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <FolderIcon size={16} className="text-primary" />
          {title}
        </h2>
        <p className="text-xs-flat text-muted-foreground">{description}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-5">
        <BreadcrumbBar
          crumbs={v.breadcrumbs}
          parentPath={v.parentPath}
          disabled={v.loading}
          onNavigate={v.navigate}
        />

        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[9px] border border-border bg-black/20 px-3 focus-within:border-primary">
            <SearchIcon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            <input
              data-folder-search
              type="text"
              value={v.query}
              onChange={(e) => v.setQuery(e.target.value)}
              placeholder="Filter folders…"
              aria-label="Filter folders in this directory"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-transparent py-2 text-xs-plus2 text-foreground outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          <Checkbox checked={v.showHidden} onChange={v.toggleHidden} label="Hidden" />
        </div>

        {v.recents.length > 0 && (
          <RecentChips
            recents={v.recents}
            disabled={v.loading}
            onPick={v.navigate}
            onRemove={v.removeRecent}
          />
        )}

        <div className="scrollbar-styled min-h-[240px] flex-1 overflow-y-auto rounded-[10px] border border-border">
          {v.loading ? (
            <div className="flex h-full items-center justify-center gap-2 py-8 text-xs-flat text-muted-foreground">
              <Spinner size={14} />
              Loading folders…
            </div>
          ) : v.error !== null ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-8 text-center">
              <span className="text-xs-plus2 text-destructive">{v.error}</span>
              <span className="text-2xs text-muted-foreground">
                Pick another folder from the breadcrumb or recents above.
              </span>
            </div>
          ) : v.entries.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4 py-8 text-xs-flat text-muted-foreground">
              {v.query.trim() === ''
                ? 'No sub-folders here.'
                : `No folders match “${v.query.trim()}”.`}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {v.entries.map((entry) => (
                <FolderRow
                  key={entry.path}
                  name={entry.name}
                  isGitRepo={entry.isGitRepo}
                  disabled={v.loading}
                  onClick={() => v.onRowClick(entry)}
                  onDoubleClick={() => v.onRowDoubleClick(entry)}
                />
              ))}
            </div>
          )}
        </div>

        <p className="text-3xs text-muted-foreground">
          Click a folder to open it; double-click to pick it.
        </p>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <span className="mr-auto min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {currentLeaf}
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => v.currentPath !== '' && v.choose(v.currentPath)}
          disabled={v.currentPath === '' || v.loading}
          title="Select the current folder (⌘/Ctrl+Enter)"
        >
          {selectLabel}
          <span className="ml-1.5 inline-flex items-center gap-0.5">
            <Kbd>{IS_MAC ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </Button>
      </div>
    </Modal>
  );
}
