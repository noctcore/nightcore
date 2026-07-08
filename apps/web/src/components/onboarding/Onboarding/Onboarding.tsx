import { BoltIcon, Button, Spinner } from '@/components/ui';

import { useOnboarding } from './Onboarding.hooks';
import { StepRail } from './Onboarding.rail';
import type { OnboardingProps } from './Onboarding.types';
import { EnvironmentStep } from './steps/EnvironmentStep';
import { ProjectStep } from './steps/ProjectStep';
import { ReadyStep } from './steps/ReadyStep';
import { WelcomeStep } from './steps/WelcomeStep';

export function Onboarding(props: OnboardingProps) {
  const view = useOnboarding(props);
  const last = view.step === 'ready';
  const showBack = view.step !== 'welcome' && !last;
  const showSkip = view.step === 'environment' || view.step === 'project';

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-background p-7 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_85%_at_50%_115%,oklch(20%_.08_300/.8)_0%,oklch(11%_.045_288/.5)_40%,transparent_68%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(1px_1px_at_12%_22%,oklch(100%_0_0/.5)_50%,transparent_51%),radial-gradient(1px_1px_at_28%_64%,oklch(100%_0_0/.3)_50%,transparent_51%),radial-gradient(1.5px_1.5px_at_44%_12%,oklch(100%_0_0/.45)_50%,transparent_51%),radial-gradient(1px_1px_at_62%_38%,oklch(100%_0_0/.3)_50%,transparent_51%),radial-gradient(1.5px_1.5px_at_78%_18%,oklch(100%_0_0/.5)_50%,transparent_51%),radial-gradient(1px_1px_at_88%_56%,oklch(100%_0_0/.35)_50%,transparent_51%)]" />
      <section className="relative z-10 flex h-full w-full overflow-hidden rounded-[22px] border border-white/[0.09] bg-[oklch(13%_.035_286/.82)] backdrop-blur-xl">
        <StepRail step={view.step} version={view.appVersion} />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-12 py-10 max-sm:px-6">
            <div className="w-full max-w-[940px]">
              {view.step === 'welcome' && <WelcomeStep />}
              {view.step === 'environment' && <EnvironmentStep view={view} />}
              {view.step === 'project' && <ProjectStep props={props} view={view} />}
              {view.step === 'ready' && <ReadyStep />}
            </div>
          </main>
          <footer className="flex items-center gap-5 border-t border-white/[0.07] px-12 py-6 max-sm:px-6">
            {showBack && (
              <Button variant="secondary" onClick={view.goBack}>
                Back
              </Button>
            )}
            {showSkip && (
              <button
                type="button"
                onClick={props.onSkip}
                className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Skip for now
              </button>
            )}
            <PrimaryAction last={last} props={props} view={view} />
          </footer>
        </div>
      </section>
    </div>
  );
}

function PrimaryAction({
  last,
  props,
  view,
}: {
  last: boolean;
  props: OnboardingProps;
  view: ReturnType<typeof useOnboarding>;
}) {
  if (view.step === 'project') {
    return (
      <Button
        className="ml-auto"
        onClick={view.createProject}
        disabled={!view.canCreateProject}
        aria-busy={view.creating}
      >
        {view.creating ? <Spinner size={13} /> : <BoltIcon size={14} />}
        Create project
      </Button>
    );
  }

  if (last) {
    return (
      <Button className="ml-auto" onClick={props.onComplete}>
        <BoltIcon size={14} />
        Launch Nightcore
      </Button>
    );
  }

  return (
    <Button className="ml-auto" onClick={view.goNext} disabled={!view.canContinue}>
      Continue
    </Button>
  );
}
