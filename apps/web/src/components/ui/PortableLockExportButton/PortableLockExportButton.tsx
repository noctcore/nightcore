/** The "Export portable lock" trigger + its preview/confirm dialog — a self-contained
 *  sibling of `IssueMapExportButton` on the Enforce results bar. It stages a portable
 *  Structure-Lock bundle (a `schemaVersion`-stamped manifest copy + a `nightcore-lock.yml`
 *  CI workflow + a README) under `.nightcore/export/portable-lock/`, then shows the
 *  workflow YAML with a copy button and the ONE manual step: copy it into
 *  `.github/workflows/` yourself and commit it (that CI sink is human-committed by
 *  design — the exporter never writes there). A null `projectPath` disables the trigger.
 *  All state lives in the hook, so this is a thin shell. */
import { Button } from '../Button';
import { CodeBlock } from '../CodeBlock';
import { IconButton } from '../IconButton';
import { CheckIcon, CloseIcon, LockIcon } from '../icons';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';
import { usePortableLockExportButton } from './PortableLockExportButton.hooks';
import type { PortableLockExportButtonProps } from './PortableLockExportButton.types';

/** The three staged files + what each is for — shown in the preview before the write. */
const STAGED_FILES: { name: string; desc: string }[] = [
  { name: 'harness.json', desc: 'a schemaVersion-stamped copy of your checks + policy' },
  { name: 'nightcore-lock.yml', desc: 'a ready-to-commit GitHub Actions workflow' },
  { name: 'README.md', desc: 'install + commit instructions' },
];

export function PortableLockExportButton({ projectPath }: PortableLockExportButtonProps) {
  const v = usePortableLockExportButton(projectPath);
  const done = v.result !== null;

  return (
    <>
      <Button variant="ghost" onClick={v.openDialog} disabled={projectPath === null}>
        <LockIcon size={15} />
        Export portable lock
      </Button>

      <Modal
        open={v.open}
        label="Export portable lock"
        panelClassName="w-full max-w-lg"
        onClose={v.closeDialog}
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <LockIcon size={16} />
              Export portable lock
            </h2>
            <p className="text-xs-plus2 text-muted-foreground">
              Enforce this repo&apos;s Structure-Lock in CI — no Nightcore, no account.
            </p>
          </div>
          <IconButton label="Close" onClick={v.closeDialog} className="-mr-1 shrink-0">
            <CloseIcon size={16} />
          </IconButton>
        </div>

        <div className="flex max-h-[64vh] flex-col gap-3 overflow-y-auto px-5 pb-2">
          {v.error !== null && (
            <p className="rounded-md border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-xs-plus text-destructive">
              {v.error}
            </p>
          )}

          {!done ? (
            <>
              <p className="text-xs-plus text-muted-foreground">
                Stages a bundle under{' '}
                <code className="text-foreground">.nightcore/export/portable-lock/</code>:
              </p>
              <ul className="flex flex-col gap-1.5">
                {STAGED_FILES.map((f) => (
                  <li key={f.name} className="text-xs-plus text-muted-foreground">
                    <code className="text-foreground">{f.name}</code> — {f.desc}
                  </li>
                ))}
              </ul>
              <p className="text-xs-plus2 text-muted-foreground">
                The workflow is staged for you to review — it is never auto-written into{' '}
                <code className="text-foreground">.github/workflows/</code>. You copy it in and
                commit it (the one manual step).
              </p>
            </>
          ) : (
            <>
              <p className="text-xs-plus text-foreground">
                Staged {v.result?.filesWritten.length} files to:
              </p>
              <code className="block break-all rounded-md border border-border bg-white/[0.02] px-3 py-2 text-3xs text-muted-foreground">
                {v.result?.stagingDir}
              </code>

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-xs-plus font-semibold text-foreground">
                  nightcore-lock.yml
                </span>
                <Button variant="ghost" onClick={v.copyWorkflow}>
                  {v.copied ? <CheckIcon size={14} /> : null}
                  {v.copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <CodeBlock code={v.result?.workflowYaml ?? ''} language="yaml" />

              <p className="text-xs-plus2 text-muted-foreground">
                Copy <code className="text-foreground">nightcore-lock.yml</code> into{' '}
                <code className="text-foreground">.github/workflows/</code> and commit it. CI then
                runs{' '}
                <code className="text-foreground">
                  npx @noctcore/harness@{v.result?.runnerVersion} check
                </code>{' '}
                on every push and pull request.
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-3">
          {!done ? (
            <>
              <Button variant="ghost" onClick={v.closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" onClick={v.runExport} disabled={v.running}>
                {v.running ? <Spinner size={14} /> : <LockIcon size={14} />}
                {v.running ? 'Exporting…' : 'Export bundle'}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={v.closeDialog}>
              Done
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}
