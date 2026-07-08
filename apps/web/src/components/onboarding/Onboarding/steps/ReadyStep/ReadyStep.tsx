import { CheckIcon } from '@/components/ui';

import { useReadyStep } from './ReadyStep.hooks';

export function ReadyStep() {
  const rows = useReadyStep();
  return (
    <div className="flex flex-col items-start gap-3.5">
      <div className="flex size-11 items-center justify-center rounded-[12px] bg-success/[0.13] text-success">
        <CheckIcon size={22} />
      </div>
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">You are set.</h1>
        <p className="mt-1 max-w-[390px] text-[12.5px] leading-6 text-muted-foreground">
          Your first project is active. The board is ready for your first task.
        </p>
      </div>
      <div className="w-full overflow-hidden rounded-[11px] border border-white/[0.07]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-3 border-b border-white/[0.05] px-3 py-2.5 last:border-b-0"
          >
            <span className="w-28 shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              ready
            </span>
            <span className="flex-1 text-[12px] font-medium">{row.label}</span>
            <CheckIcon size={13} className="text-success" />
          </div>
        ))}
      </div>
    </div>
  );
}
