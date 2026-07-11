/** Settings content for the Auto Mode toolbar option — the auto-commit row plus the
 *  usage-throttle threshold slider, shown inside the ToolbarOption settings popover. */
import type { AutoModeOptionsProps } from './AutoModeOptions.types';

/** Clamp a raw range value to the throttle's 50..=100 window (mirrors the Rust
 *  patch-merge clamp) so a stray keyboard step can never persist out of range. */
const clampThreshold = (n: number): number => Math.min(100, Math.max(50, Math.round(n)));

export function AutoModeOptions({
  autoCommitOnVerified,
  onAutoCommitChange,
  autoPauseUsageThreshold,
  onThresholdChange,
  usageMeterEnabled,
}: AutoModeOptionsProps) {
  return (
    // The ToolbarOption popover already wraps this in a labelled `role="group"`.
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={autoCommitOnVerified}
        aria-label="Auto-commit on verified"
        onClick={() => onAutoCommitChange(!autoCommitOnVerified)}
        className="flex w-full items-start gap-3 rounded-lg border border-border bg-white/[0.02] p-2.5 text-left transition-colors hover:border-white/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-semibold text-foreground">
            Auto-commit on verified
          </span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
            While Auto Mode runs, each task is committed automatically the moment
            it's verified — before the next one starts. In a shared (main)
            checkout, run one task at a time so per-task commits stay clean.
          </span>
        </span>
        <span
          aria-hidden
          className={`relative mt-0.5 h-[17px] w-[30px] shrink-0 rounded-full transition-colors ${
            autoCommitOnVerified ? 'bg-primary' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`absolute top-0.5 h-[13px] w-[13px] rounded-full bg-white transition-transform ${
              autoCommitOnVerified ? 'left-[14px]' : 'left-0.5'
            }`}
          />
        </span>
      </button>

      <div className="rounded-lg border border-border bg-white/[0.02] p-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <label
            htmlFor="auto-pause-usage-threshold"
            className="text-[12.5px] font-semibold text-foreground"
          >
            Pause Auto Mode at usage
          </label>
          <span className="font-mono text-[12px] font-semibold tabular-nums text-foreground">
            {autoPauseUsageThreshold}%
          </span>
        </div>
        <input
          id="auto-pause-usage-threshold"
          type="range"
          aria-label="Pause Auto Mode at usage threshold"
          min={50}
          max={100}
          value={autoPauseUsageThreshold}
          disabled={!usageMeterEnabled}
          onChange={(e) => onThresholdChange(clampThreshold(Number(e.target.value)))}
          className="mt-2 w-full accent-primary disabled:cursor-not-allowed disabled:opacity-40"
        />
        <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
          {usageMeterEnabled
            ? 'When any Claude rate-limit window reaches this level, Auto Mode stops picking up new runs. In-flight runs finish, and it resumes automatically once usage cools.'
            : 'Enable the usage meter to use this.'}
        </p>
      </div>
    </div>
  );
}
