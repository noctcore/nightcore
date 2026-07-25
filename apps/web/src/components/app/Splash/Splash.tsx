import { BrandMark, fadeRise, m, stagger } from '@/components/ui';

import type { SplashProps } from './Splash.types';

/** The boot splash shown on first mount — brand mark, animated loader bar, and a
 *  boot line. Faithful to the design's cosmic-dark splash. */
export function Splash({
  bootLine = 'initializing workspace…',
  version,
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
      {/* Staggered entrance: brand → wordmark → loader → boot line each fade+rise
          in sequence (was a single `nc-rise` on the whole block). */}
      <m.div
        variants={stagger}
        initial="initial"
        animate="animate"
        className="relative flex flex-col items-center gap-7"
      >
        <m.div variants={fadeRise}>
          <BrandMark size={96} />
        </m.div>
        <m.div variants={fadeRise} className="flex flex-col items-center gap-2.5">
          <div className="flex items-baseline text-[34px] font-semibold tracking-tight">
            nightcore<span className="text-primary">.</span>
          </div>
          <div className="font-mono text-2xs-plus uppercase tracking-[0.32em] text-muted-foreground">
            autonomous claude dev studio
          </div>
        </m.div>
        <m.div
          variants={fadeRise}
          className="relative mt-1.5 h-[3px] w-[208px] overflow-hidden rounded-full bg-white/[0.07]"
        >
          <div
            className="absolute inset-y-0 w-[42%] bg-gradient-to-r from-transparent via-primary to-transparent"
            style={{ animation: 'nc-bar 1.15s ease-in-out infinite' }}
          />
        </m.div>
        <m.div variants={fadeRise} className="font-mono text-2xs text-muted-foreground/80">
          {bootLine}
        </m.div>
      </m.div>
      {version !== undefined && version !== '' && (
        <div className="absolute bottom-6 font-mono text-3xs-plus tracking-[0.1em] text-muted-foreground/50">
          {version}
        </div>
      )}
    </div>
  );
}
