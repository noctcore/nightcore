import { BoltIcon, BrandMark } from '@/components/ui';

import { useWelcomeStep } from './WelcomeStep.hooks';

export function WelcomeStep() {
  const rows = useWelcomeStep();
  return (
    <div className="flex flex-col gap-4">
      <BrandMark size={56} />
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">
          Welcome to nightcore<span className="text-primary">.</span>
        </h1>
        <p className="mt-1.5 max-w-[420px] text-xs-plus2 leading-6 text-muted-foreground">
          An autonomous Claude dev studio for shipping changes from local repos with
          visible checks, review gates, and project-scoped boards.
        </p>
      </div>
      <div className="mt-0.5 flex flex-col gap-2">
        {rows.map((row) => (
          <div
            key={row.title}
            className="flex items-center gap-3 rounded-nc border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-primary/15 text-primary">
              <BoltIcon size={14} />
            </div>
            <div>
              <div className="text-xs-plus font-semibold">{row.title}</div>
              <div className="text-2xs-plus text-muted-foreground">{row.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
