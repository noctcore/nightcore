/** Manual + optional startup update checker for Settings → About. */
import { Button, Pill } from '@/components/ui';

import { useUpdateChecker } from './UpdateChecker.hooks';
import type { UpdateCheckerProps } from './UpdateChecker.types';

/** The About-page update control: check, install when idle, relaunch on success. */
export function UpdateChecker(props: UpdateCheckerProps) {
  const { status, update, progressPct, error, isTauriRuntime, check, install, dismiss } =
    useUpdateChecker(props);

  if (!isTauriRuntime) {
    return (
      <span className="text-xs-plus text-muted-foreground">
        Updates are available in the desktop app.
      </span>
    );
  }

  if (status === 'checking') {
    return (
      <span role="status" aria-busy="true" className="text-xs-plus text-muted-foreground">
        Checking for updates…
      </span>
    );
  }

  if (status === 'installing') {
    return (
      <div className="flex flex-col items-end gap-1">
        <span role="status" aria-busy="true" className="text-xs-plus text-muted-foreground">
          Downloading update…
          {progressPct !== null ? ` ${progressPct}%` : ''}
        </span>
      </div>
    );
  }

  if (status === 'available' && update) {
    return (
      <div className="flex flex-col items-end gap-2">
        <Pill>v{update.version} available</Pill>
        {update.body && (
          <p className="max-w-[280px] text-right text-xs-flat text-muted-foreground">{update.body}</p>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={dismiss}>
            Later
          </Button>
          <Button onClick={() => void install()}>Install &amp; restart</Button>
        </div>
      </div>
    );
  }

  if (status === 'deferred' && update) {
    return (
      <div className="flex flex-col items-end gap-2">
        <Pill>v{update.version} ready</Pill>
        <p className="max-w-[280px] text-right text-xs-flat text-muted-foreground">
          Finish active runs before installing.
        </p>
        <Button disabled>Install &amp; restart</Button>
      </div>
    );
  }

  if (status === 'up-to-date') {
    return (
      <div className="flex flex-col items-end gap-2">
        <span className="text-xs-plus text-muted-foreground">You&apos;re up to date.</span>
        <Button variant="secondary" onClick={() => void check()}>
          Check again
        </Button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-end gap-2">
        <p className="max-w-[280px] text-right text-xs-plus text-destructive">{error}</p>
        <Button variant="secondary" onClick={() => void check()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Button variant="secondary" onClick={() => void check()}>
      Check for updates
    </Button>
  );
}