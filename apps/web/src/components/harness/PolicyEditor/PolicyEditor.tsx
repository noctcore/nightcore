/** The runtime-policy editor card: the `policy` block of `.nightcore/harness.json`
 *  (enable switch, path/pattern/tool lists, diff budget) with explicit dirty-state
 *  save. Rendered purely from the `usePolicyEditor` view model. */
import { Button, CloseIcon, PlusIcon, Skeleton, Spinner } from '@/components/ui';

import type { PolicyEditorVM } from './PolicyEditor.hooks';
import { usePolicyEditor } from './PolicyEditor.hooks';
import type { PolicyEditorProps, PolicyListKey } from './PolicyEditor.types';

const FIELD_INPUT =
  'w-full rounded-[8px] border border-border bg-black/20 px-2.5 py-1.5 font-mono text-xs-plus text-foreground outline-none focus:border-primary';

/** One list field's per-row metadata: the visible label and its one-line meaning. */
const LIST_FIELDS: { key: PolicyListKey; label: string; hint: string; placeholder: string }[] = [
  {
    key: 'protectedPaths',
    label: 'Protected paths',
    hint: 'Globs agents may never write.',
    placeholder: 'migrations/**',
  },
  {
    key: 'denyBashPatterns',
    label: 'Denied bash patterns',
    hint: 'Bash commands containing any of these substrings are blocked.',
    placeholder: '--no-verify',
  },
  {
    key: 'denyReadPaths',
    label: 'Denied read paths',
    hint: 'Globs agents may never read — the quarantine list for injection-flagged files.',
    placeholder: '.env*',
  },
  {
    key: 'disallowedTools',
    label: 'Disallowed tools',
    hint: 'Tool names removed from the agent entirely.',
    placeholder: 'WebSearch',
  },
  {
    key: 'askTools',
    label: 'Ask-first tools',
    hint: 'Tool names that require your interactive approval on every call, even in bypass mode.',
    placeholder: 'WebFetch',
  },
  {
    key: 'allowTools',
    label: 'Auto-allowed rules',
    hint: 'SDK permission rules approved without prompting (never overrides a deny).',
    placeholder: 'Bash(git status:*)',
  },
];

/** The enable switch (shared visual with the settings toggles). */
function EnabledSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
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

/** An add/remove row editor for one string-list policy field. */
function ListEditor({
  field,
  values,
  view,
}: {
  field: (typeof LIST_FIELDS)[number];
  values: string[];
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
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={value}
            aria-label={`${field.label} entry ${index + 1}`}
            placeholder={field.placeholder}
            onChange={(e) => view.setListItem(field.key, index, e.target.value)}
            className={FIELD_INPUT}
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
function LimitField({
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

function EditorSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-3">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  );
}

/** The policy editor card. The section owns load/save; this card owns the draft. */
export function PolicyEditor(props: PolicyEditorProps) {
  const view = usePolicyEditor(props);

  return (
    <section
      aria-label="Runtime policy"
      className="flex flex-col gap-4 rounded-[10px] border border-border bg-white/[0.015] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-xs-plus3 font-semibold text-foreground">Runtime policy</h3>
          <p className="text-2xs-plus text-muted-foreground">
            Enforced on every agent session in this project via{' '}
            <code className="rounded border border-border bg-white/[0.04] px-1 font-mono text-2xs">
              .nightcore/harness.json
            </code>
            {' '}— it holds even under bypass permissions.
          </p>
        </div>
        {view.ready && view.draft !== null && (
          <div className="flex items-center gap-2">
            <span className="text-2xs-plus text-muted-foreground">
              {view.draft.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <EnabledSwitch on={view.draft.enabled} onToggle={view.toggleEnabled} />
          </div>
        )}
      </div>

      {!view.ready || view.draft === null ? (
        <EditorSkeleton />
      ) : (
        <>
          {!view.manifestExists && (
            <p className="rounded-md border border-border bg-white/[0.02] px-3 py-2 text-2xs-plus text-muted-foreground">
              This project has no manifest yet — saving creates{' '}
              <code className="font-mono">.nightcore/harness.json</code> with this policy.
            </p>
          )}

          {LIST_FIELDS.map((field) => (
            <ListEditor
              key={field.key}
              field={field}
              values={view.draft === null ? [] : view.draft[field.key]}
              view={view}
            />
          ))}

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xs-plus font-semibold text-muted-foreground">
                Diff budget
              </span>
              <span className="text-2xs text-muted-foreground/80">
                Fail verification when a run changes more than this. Empty = no limit.
              </span>
            </div>
            <div className="flex gap-4">
              <LimitField
                id="policy-max-lines"
                label="Max changed lines"
                value={view.draft.maxChangedLines}
                error={view.limitErrors.maxChangedLines}
                onChange={(v) => view.setLimit('maxChangedLines', v)}
              />
              <LimitField
                id="policy-max-files"
                label="Max changed files"
                value={view.draft.maxChangedFiles}
                error={view.limitErrors.maxChangedFiles}
                onChange={(v) => view.setLimit('maxChangedFiles', v)}
              />
            </div>
          </div>

          {view.saveError !== null && (
            <p className="rounded-md border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-2xs-plus text-destructive">
              {view.saveError}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-border pt-3">
            {view.dirty && (
              <span className="text-2xs-plus text-warning" role="status">
                Unsaved changes
              </span>
            )}
            <Button variant="primary" disabled={!view.canSave} onClick={view.save}>
              {view.saving && <Spinner size={13} />}
              {view.manifestExists ? 'Save policy' : 'Create manifest'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
