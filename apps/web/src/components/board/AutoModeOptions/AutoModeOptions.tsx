/** A gear button beside the Auto Mode toggle that opens a small popover of loop
 *  options. Currently one option — auto-commit on verified — but it's the home for
 *  future Auto Mode knobs. Thin shell: open/close state lives in the colocated
 *  hook; the persisted option value + setter come from the shell via props. */
import { GearIcon } from '@/components/ui';
import { useAutoModeOptions } from './AutoModeOptions.hooks';
import type { AutoModeOptionsProps } from './AutoModeOptions.types';

export function AutoModeOptions({
  autoCommitOnVerified,
  onAutoCommitChange,
}: AutoModeOptionsProps) {
  const { open, toggle, rootRef, triggerRef } = useAutoModeOptions();

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label="Auto Mode options"
        aria-expanded={open}
        title="Auto Mode options"
        className={`flex items-center justify-center rounded-[9px] border p-2 text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          open
            ? 'border-white/20 bg-white/[0.04]'
            : 'border-border bg-white/[0.02] hover:border-white/20'
        }`}
      >
        <GearIcon size={15} className="text-muted-foreground" />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Auto Mode options"
          className="absolute right-0 top-full z-20 mt-1.5 w-72 rounded-[10px] border border-border bg-popover p-3 shadow-2xl"
          style={{ animation: 'nc-rise .14s cubic-bezier(.22,1,.36,1)' }}
        >
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
        </div>
      )}
    </div>
  );
}
