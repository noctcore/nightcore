import { BrandMark } from '@/components/ui';
import type { SplashProps } from './Splash.types';

/** The boot splash shown on first mount — brand mark, animated loader bar, and a
 *  boot line. Faithful to the design's cosmic-dark splash. */
export function Splash({
  bootLine = 'initializing workspace…',
  version = 'v0.1.0',
}: SplashProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading Nightcore"
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center overflow-hidden bg-background"
    >
      <div
        className="absolute h-[560px] w-[560px] rounded-full bg-primary/[0.14] blur-2xl"
        style={{ animation: 'nc-glow 4s ease-in-out infinite' }}
      />
      <div
        className="relative flex flex-col items-center gap-7"
        style={{ animation: 'nc-rise .7s cubic-bezier(.22,1,.36,1)' }}
      >
        <BrandMark size={96} />
        <div className="flex flex-col items-center gap-2.5">
          <div className="flex items-baseline text-[34px] font-semibold tracking-tight">
            nightcore<span className="text-primary">.</span>
          </div>
          <div className="font-mono text-[11.5px] uppercase tracking-[0.32em] text-muted-foreground">
            autonomous claude dev studio
          </div>
        </div>
        <div className="relative mt-1.5 h-[3px] w-[208px] overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className="absolute inset-y-0 w-[42%] bg-gradient-to-r from-transparent via-primary to-transparent"
            style={{ animation: 'nc-bar 1.15s ease-in-out infinite' }}
          />
        </div>
        <div className="font-mono text-[11px] text-muted-foreground/80">{bootLine}</div>
      </div>
      <div className="absolute bottom-6 font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground/50">
        {version} · rewrite of automaker
      </div>
    </div>
  );
}
