/** Presentational sub-parts of the runtime-policy editor card: the enable switch,
 *  the per-tier list editor with its edit-time diagnostics, the clearable
 *  diff-budget limit input, and the loading skeleton. Lifted out of
 *  `PolicyEditor.tsx` so the card stays a thin shell under the size caps. */
import type { PolicyEntryDiagnostic } from '@nightcore/contracts';
import { Button, CloseIcon, PlusIcon, Skeleton } from '@/components/ui';

import type { PolicyEditorVM } from './PolicyEditor.hooks';
import type { PolicyListKey } from './PolicyEditor.types';
import type { PolicyListField } from './PolicyEditor.utils';

/** The shared field chrome for every policy input (mono, dense, focus-primary). */
export const FIELD_INPUT =
  'w-full rounded-[8px] border border-border bg-black/20 px-2.5 py-1.5 font-mono text-xs-plus text-foreground outline-none focus:border-primary';

/** The border a row wears once its entry is diagnosed — a dead rule reads as
 *  destructive, a suspicious one as a warning, so the author sees the difference
 *  between "this will never fire" and "check this". */
const ISSUE_BORDER: Record<PolicyEntryDiagnostic['severity'], string> = {
  error: 'border-destructive/70 focus:border-destructive',
  warning: 'border-warning/60 focus:border-warning',
};

const ISSUE_TEXT: Record<PolicyEntryDiagnostic['severity'], string> = {
  error: 'text-destructive',
  warning: 'text-warning',
};

/** The enable switch (shared visual with the settings toggles). */
export function EnabledSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Policy enabled"
      onClick={onToggle}
      className={`inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full px-0.5 transition-colors ${
        on ? 'bg-primary' : 'bg-white/[0.12]'
      }`}
    >
      <span
        className={`h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : ''}`}
      />
    </button>
  );
}

/** One editable row: the entry input, its remove button, and the inline
 *  diagnostic. The input is bound to the message via `aria-describedby` and marked
 *  `aria-invalid` only for a BLOCKING issue, so a warning never reads to a screen
 *  reader as a validation failure. */
function ListRow({
  field,
  index,
  value,
  issue,
  view,
}: {
  field: PolicyListField;
  index: number;
  value: string;
  issue: PolicyEntryDiagnostic | null;
  view: PolicyEditorVM;
}) {
  const issueId = `policy-${field.key}-${index}-issue`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          aria-label={`${field.label} entry ${index + 1}`}
          placeholder={field.placeholder}
          aria-invalid={issue?.severity === 'error'}
          aria-describedby={issue === null ? undefined : issueId}
          onChange={(e) => view.setListItem(field.key, index, e.target.value)}
          className={`${FIELD_INPUT} ${issue === null ? '' : ISSUE_BORDER[issue.severity]}`}
        />
        <button
          type="button"
          aria-label={`Remove ${field.label} entry ${index + 1}`}
          onClick={() => view.removeListItem(field.key, index)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
        >
          <CloseIcon size={13} />
        </button>
      </div>
      {issue !== null && (
        <p id={issueId} className={`pl-0.5 text-2xs leading-snug ${ISSUE_TEXT[issue.severity]}`}>
          {issue.message}
        </p>
      )}
    </div>
  );
}

/** An add/remove row editor for one string-list policy field. */
export function ListEditor({
  field,
  values,
  issues,
  view,
}: {
  field: PolicyListField;
  values: string[];
  issues: (PolicyEntryDiagnostic | null)[];
  view: PolicyEditorVM;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs-plus font-semibold text-muted-foreground">{field.label}</span>
        <span className="text-2xs text-muted-foreground/80">{field.hint}</span>
      </div>
      {values.length === 0 && (
        <p className="text-2xs-plus italic text-muted-foreground">No entries.</p>
      )}
      {values.map((value, index) => (
        // Index keys are correct here: rows are positional drafts with no
        // stable identity until saved.
        <ListRow
          key={index}
          field={field}
          index={index}
          value={value}
          issue={issues[index] ?? null}
          view={view}
        />
      ))}
      <div>
        <Button variant="ghost" onClick={() => view.addListItem(field.key)}>
          <PlusIcon size={13} />
          Add {field.label.toLowerCase().replace(/s$/, '')}
        </Button>
      </div>
    </div>
  );
}

/** One clearable diff-budget limit input. Empty = no limit. */
export function LimitField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-2xs-plus font-semibold text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        value={value}
        inputMode="numeric"
        placeholder="unlimited"
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? `${id}-error` : undefined}
        className={`${FIELD_INPUT} max-w-[140px]`}
      />
      {error !== null && (
        <p id={`${id}-error`} className="text-2xs text-warning">
          {error}
        </p>
      )}
    </div>
  );
}

export function EditorSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-3">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  );
}

/** The list-editor stack. Split from the card so `PolicyEditor.tsx` composes
 *  cards, not rows. */
export function PolicyListEditors({
  fields,
  view,
}: {
  fields: readonly PolicyListField[];
  view: PolicyEditorVM;
}) {
  return (
    <>
      {fields.map((field) => (
        <ListEditor
          key={field.key}
          field={field}
          values={view.draft === null ? [] : view.draft[field.key as PolicyListKey]}
          issues={view.entryIssues[field.key]}
          view={view}
        />
      ))}
    </>
  );
}
