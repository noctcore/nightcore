/** The runtime-policy editor card: the `policy` block of `.nightcore/harness.json`
 *  (enable switch, path/pattern/tool lists, diff budget) with edit-time pattern
 *  diagnostics and explicit dirty-state save. Rendered purely from the
 *  `usePolicyEditor` view model. */
import { Button, Spinner } from '@/components/ui';

import { usePolicyEditor } from './PolicyEditor.hooks';
import {
  EditorSkeleton,
  EnabledSwitch,
  LimitField,
  PolicyListEditors,
} from './PolicyEditor.parts';
import type { PolicyEditorProps } from './PolicyEditor.types';
import { POLICY_LIST_FIELDS } from './PolicyEditor.utils';

/** The policy editor card. The section owns load/save; this card owns the draft. */
export function PolicyEditor(props: PolicyEditorProps) {
  const view = usePolicyEditor(props);

  return (
    <section
      aria-label="Runtime policy"
      className="flex flex-col gap-4 rounded-nc border border-border bg-white/[0.015] p-5"
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

          <PolicyListEditors fields={POLICY_LIST_FIELDS} view={view} />

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
            {view.deadRuleCount > 0 && (
              <span className="text-2xs-plus text-destructive" role="status">
                {view.deadRuleCount} rule{view.deadRuleCount === 1 ? '' : 's'} can never match — fix
                before saving
              </span>
            )}
            {view.dirty && view.deadRuleCount === 0 && (
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
