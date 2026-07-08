import { BrandMark, CheckIcon } from '@/components/ui';

import type { OnboardingStep } from './Onboarding.types';

const STEP_META: Array<{ id: OnboardingStep; label: string; sub: string }> = [
  { id: 'welcome', label: 'Welcome', sub: 'studio primer' },
  { id: 'environment', label: 'Environment', sub: 'local CLIs' },
  { id: 'project', label: 'Project', sub: 'first repo' },
  { id: 'ready', label: 'Ready', sub: 'launch' },
];

const STEP_INDEX = new Map(STEP_META.map((step, index) => [step.id, index]));

export function StepRail({
  step,
  version,
}: {
  step: OnboardingStep;
  version: string | null;
}) {
  const current = STEP_INDEX.get(step) ?? 0;
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-white/[0.07] bg-black/20 px-7 py-8 max-md:w-[250px] max-sm:hidden">
      <div className="mb-10 flex items-center gap-3">
        <BrandMark size={30} />
        <span className="text-lg font-semibold">
          nightcore<span className="text-primary">.</span>
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {STEP_META.map((item, index) => {
          const active = index === current;
          const complete = index < current;
          return (
            <div key={item.id} className="flex min-h-[72px] gap-4">
              <div className="flex shrink-0 flex-col items-center">
                <div
                  className={`flex size-7 items-center justify-center rounded-full text-[13px] font-bold ${
                    complete || active
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border text-muted-foreground'
                  }`}
                >
                  {complete ? <CheckIcon size={15} /> : index + 1}
                </div>
                {index < STEP_META.length - 1 && (
                  <div
                    className={`h-[34px] w-px ${complete ? 'bg-primary/60' : 'bg-border'}`}
                  />
                )}
              </div>
              <div className="pt-1">
                <div
                  className={`text-[15px] font-semibold ${
                    active ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {item.label}
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {item.sub}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-auto font-mono text-[11px] text-muted-foreground/70">
        {version === null ? 'setup' : `v${version} setup`}
      </div>
    </aside>
  );
}
