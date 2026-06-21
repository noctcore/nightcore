import { Badge } from '@/components/ui';
import type { SettingsCardProps } from './SettingsCard.types';

/** A grouped settings card: header (icon + title + optional roadmap badge)
 *  followed by label/hint/control rows. */
export function SettingsCard({
  icon,
  title,
  subtitle,
  badge,
  rows,
}: SettingsCardProps) {
  return (
    <section className="mb-[18px] rounded-2xl border border-border bg-card px-[22px] pb-2 pt-[22px]">
      <div className="flex items-start gap-3.5 pb-1.5">
        <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
          {icon}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {badge !== undefined && <Badge tone="roadmap">{badge}</Badge>}
          </div>
          {subtitle !== undefined && (
            <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div>
        {rows.map((row, i) => (
          <div
            key={row.label}
            className={`flex items-center gap-4 py-3.5 ${i > 0 ? 'border-t border-border' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{row.label}</div>
              {row.hint !== undefined && (
                <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                  {row.hint}
                </div>
              )}
            </div>
            <div className="shrink-0">{row.control}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
