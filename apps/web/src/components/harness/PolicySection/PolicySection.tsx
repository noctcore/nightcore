/** The Policy body section of the harness results screen: the runtime-policy
 *  editor over `.nightcore/harness.json` plus the injection-surface scan with
 *  per-path quarantine. Both cards share ONE authoritative policy owned by
 *  `usePolicySection`, so a quarantine immediately reflects in the editor's
 *  denied-read list and vice versa. */
import { InjectionScanCard } from '../InjectionScanCard';
import { PolicyEditor } from '../PolicyEditor';
import { usePolicySection } from './PolicySection.hooks';

export function PolicySection() {
  const view = usePolicySection();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-6 py-5">
        {view.loadError !== null && (
          <p className="rounded-md border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-2xs-plus text-destructive">
            Could not read the policy: {view.loadError}
          </p>
        )}
        <PolicyEditor
          policy={view.policy}
          saving={view.saving}
          saveError={view.saveError}
          onSave={view.save}
        />
        <InjectionScanCard
          denyReadPaths={view.policy?.denyReadPaths ?? []}
          onQuarantine={view.quarantine}
        />
      </div>
    </div>
  );
}
