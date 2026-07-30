import { CloseIcon, IconButton, Kbd, Modal } from '@/components/ui';

import { useShortcutGroups } from './ShortcutSheet.hooks';
import type { ShortcutGroup, ShortcutSheetProps } from './ShortcutSheet.types';

/** One block of shortcuts: a mono heading, an optional caveat, then key/action rows. */
function ShortcutBlock({ group }: { group: ShortcutGroup }) {
  return (
    <section>
      <h3 className="font-mono text-4xs-plus uppercase tracking-[0.18em] text-muted-foreground">
        {group.label}
      </h3>
      {group.note !== undefined && (
        <p className="mt-1 text-2xs leading-snug text-muted-foreground/70">{group.note}</p>
      )}
      <dl className="mt-2 flex flex-col">
        {group.rows.map((row) => (
          <div
            key={`${group.label}-${row.label}`}
            className="flex items-baseline gap-3 border-b border-border/50 py-1.5 last:border-b-0"
          >
            <dt className="flex shrink-0 items-center gap-1">
              {row.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
              <span className="text-xs-flat text-foreground">{row.label}</span>
              {row.context !== undefined && (
                <span className="text-2xs text-muted-foreground/70">{row.context}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The `?` cheatsheet: every keyboard affordance the app advertises, in one place.
 *
 *  The Kbd chips in the sidebar were the only place these keys were documented, and
 *  nothing said the board layer or the dialog confirm rule existed at all (issue
 *  #404). The "Go to" block is derived from the live nav rows so it cannot fall out of
 *  date, and each of those rows names the stage its destination belongs to.
 *
 *  A11y comes from the shared `Modal`: focus moves in on open, Tab is trapped, Esc
 *  closes, and focus is restored to the opener — the same contract every sibling
 *  dialog has. */
export function ShortcutSheet({ open, nav, onClose }: ShortcutSheetProps) {
  const groups = useShortcutGroups(nav);

  return (
    <Modal
      open={open}
      label="Keyboard shortcuts"
      panelClassName="flex max-h-[80vh] w-full max-w-[560px] flex-col"
      onClose={onClose}
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Keyboard shortcuts</h2>
          <p className="mt-1 text-xs-plus2 text-muted-foreground">
            Work moves Intake → Understand → Harden → Enforce → Verify. These keys jump
            straight to any stage.
          </p>
        </div>
        <IconButton label="Close" onClick={onClose} className="-mr-1 shrink-0">
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-5">
        {groups.map((group) => (
          <ShortcutBlock key={group.label} group={group} />
        ))}
      </div>
    </Modal>
  );
}
