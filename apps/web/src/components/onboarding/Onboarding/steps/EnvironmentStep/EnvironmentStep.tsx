import {
  AlertIcon,
  Button,
  CheckIcon,
  ChecksIcon,
  GithubIcon,
  KeyIcon,
  RefreshIcon,
  Spinner,
  TerminalIcon,
} from '@/components/ui';

import { useEnvironmentStep } from './EnvironmentStep.hooks';
import type {
  EnvironmentRowIcon,
  EnvironmentRowModel,
  EnvironmentStepProps,
} from './EnvironmentStep.types';

export function EnvironmentStep({ view }: EnvironmentStepProps) {
  const { rows, animationDone, failedRequired, isCheckingRow } =
    useEnvironmentStep(view);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] font-semibold tracking-tight">Environment check</h1>
          <p className="mt-3 max-w-[620px] text-base-flat leading-7 text-muted-foreground">
            Nightcore drives the CLIs already on your machine. Nothing is installed
            for you.
          </p>
        </div>
        <Button
          variant="secondary"
          className="px-5 py-2.5 text-xs-plus2"
          onClick={view.rerunChecks}
          disabled={view.checksLoading || !animationDone}
        >
          {view.checksLoading ? <Spinner size={15} /> : <RefreshIcon size={15} />}
          Re-run all
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <EnvironmentRow
            key={row.id}
            row={row}
            checking={isCheckingRow(index)}
            onRecheck={view.rerunChecks}
          />
        ))}
      </div>
      {view.checksError !== null && (
        <Summary tone="warning" text={view.checksError} />
      )}
      {failedRequired ? (
        <Summary tone="warning" text="A required check failed. Fix it, then re-check." />
      ) : animationDone && view.envReady ? (
        <Summary tone="success" text="Local environment is ready." />
      ) : null}
    </div>
  );
}

function EnvironmentRow({
  row,
  checking,
  onRecheck,
}: {
  row: EnvironmentRowModel;
  checking: boolean;
  onRecheck: () => void;
}) {
  const failed = !checking && !row.ready;
  const rowClass = failed
    ? 'border-warning/45 bg-warning/[0.08]'
    : !checking && row.ready
      ? 'border-success/30 bg-success/[0.04]'
      : 'border-border bg-white/[0.025]';
  const detailClass = failed
    ? 'text-warning'
    : !checking && row.ready
      ? 'text-success'
      : 'text-muted-foreground';

  return (
    <div className={`rounded-[13px] border px-4 py-4 ${rowClass}`}>
      <div className="flex items-center gap-4">
        <div className={`flex size-7 shrink-0 items-center justify-center rounded-full ${
          checking ? 'bg-white/[0.06] text-muted-foreground' : row.ready ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning'
        }`}>
          {checking ? <Spinner size={15} /> : row.ready ? <CheckIcon size={15} /> : <AlertIcon size={15} />}
        </div>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-nc bg-white/[0.05] text-muted-foreground">
          <EnvironmentIcon icon={row.icon} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">{row.label}</span>
            {row.optional === true && (
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                optional
              </span>
            )}
          </div>
        </div>
        <span
          title={row.detail}
          className={`max-w-[460px] truncate font-mono text-xs-plus2 ${detailClass}`}
        >
          {checking ? 'Checking…' : row.detail}
        </span>
      </div>
      {failed && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-nc border border-warning/30 bg-black/25 px-4 py-3">
          <span className="min-w-[220px] flex-1 text-sm-flat leading-6 text-muted-foreground">
            {row.fixHint}
          </span>
          <code className="rounded-[8px] border border-border bg-white/[0.06] px-3 py-1.5 font-mono text-xs-plus2 text-foreground">
            {row.fixCommand}
          </code>
          <Button onClick={onRecheck}>
            <RefreshIcon size={14} />
            Re-check
          </Button>
        </div>
      )}
    </div>
  );
}

function EnvironmentIcon({ icon }: { icon: EnvironmentRowIcon }) {
  if (icon === 'terminal') return <TerminalIcon size={16} />;
  if (icon === 'key') return <KeyIcon size={16} />;
  if (icon === 'github') return <GithubIcon size={16} />;
  return <ChecksIcon size={16} />;
}

function Summary({ tone, text }: { tone: 'success' | 'warning'; text: string }) {
  const success = tone === 'success';
  return (
    <div
      className={`flex items-center gap-3 rounded-[12px] border px-4 py-3 text-[15px] ${
        success
          ? 'border-success/30 bg-success/[0.06] text-success'
          : 'border-warning/45 bg-warning/[0.10] text-warning'
      }`}
    >
      {success ? <CheckIcon size={16} /> : <AlertIcon size={16} />}
      {text}
    </div>
  );
}
