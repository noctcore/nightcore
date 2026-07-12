/** The injection-surface scan card: run the deterministic prompt-injection sweep
 *  over the project's tracked files, review the flagged paths + reasons, and
 *  quarantine a path into `policy.denyReadPaths`. Rendered purely from the
 *  `useInjectionScan` view model. */
import { Button, LockIcon, SearchIcon, Spinner } from '@/components/ui';
import type { InjectionFlag } from '@/lib/bridge';

import type { InjectionScanVM } from './InjectionScanCard.hooks';
import { useInjectionScan } from './InjectionScanCard.hooks';
import type { InjectionScanCardProps } from './InjectionScanCard.types';

/** One flagged file row: the path, every detector reason, and the quarantine
 *  action (disabled + relabelled once the path is in denyReadPaths). */
function FlagRow({ flag, view }: { flag: InjectionFlag; view: InjectionScanVM }) {
  const quarantined = view.isQuarantined(flag.path);
  const pending = view.quarantiningPath === flag.path;
  return (
    <li className="flex items-start justify-between gap-3 rounded-[8px] border border-border bg-white/[0.02] px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-1">
        <code className="break-all font-mono text-xs-flat text-foreground">{flag.path}</code>
        <ul className="flex flex-col gap-0.5">
          {flag.reasons.map((reason) => (
            <li key={reason} className="text-2xs-plus text-warning">
              {reason}
            </li>
          ))}
        </ul>
      </div>
      <Button
        variant="secondary"
        disabled={quarantined || pending}
        onClick={() => view.quarantine(flag.path)}
      >
        {pending ? <Spinner size={13} /> : <LockIcon size={13} />}
        {quarantined ? 'Quarantined' : 'Quarantine'}
      </Button>
    </li>
  );
}

/** The results body: flags list, honest zero-flag state, or the pre-scan explainer. */
function Results({ view }: { view: InjectionScanVM }) {
  if (view.flags === null) {
    return (
      <p className="text-2xs-plus text-muted-foreground">
        Sweeps every git-tracked text file for injection-shaped content: invisible
        Unicode-tag payloads, zero-width runs, bidi overrides, and
        instruction-shaped phrases. Detection only — nothing is quarantined without
        your say-so.
      </p>
    );
  }
  if (view.flags.length === 0) {
    return (
      <p className="text-2xs-plus text-muted-foreground" role="status">
        No flagged files — nothing injection-shaped in the tracked text files.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {view.flags.map((flag) => (
        <FlagRow key={flag.path} flag={flag} view={view} />
      ))}
    </ul>
  );
}

/** The injection-scan card. Quarantining goes through the parent's policy
 *  update, so the row state always reflects the SAVED denyReadPaths. */
export function InjectionScanCard(props: InjectionScanCardProps) {
  const view = useInjectionScan(props);

  return (
    <section
      aria-label="Injection scan"
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-white/[0.015] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-xs-plus3 font-semibold text-foreground">Injection scan</h3>
          <p className="text-2xs-plus text-muted-foreground">
            Quarantining adds the path to the policy&apos;s denied read paths, so
            agents never ingest it.
          </p>
        </div>
        <Button variant="secondary" disabled={view.scanning} onClick={view.runScan}>
          {view.scanning ? <Spinner size={13} /> : <SearchIcon size={13} />}
          {view.flags === null ? 'Run scan' : 'Rescan'}
        </Button>
      </div>

      {view.scanError !== null && (
        <p className="rounded-md border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-2xs-plus text-destructive">
          Scan failed: {view.scanError}
        </p>
      )}

      <Results view={view} />
    </section>
  );
}
