/** A presentational grouped settings card: header plus label/hint/control rows. */
import { AlertIcon } from '@/components/ui';

import { ScopeBadge } from './SettingsCard.parts';
import type { SettingsCardProps } from './SettingsCard.types';

export function SettingsCard({
  icon,
  title,
  subtitle,
  rows,
  note,
  scopeSurface,
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
          </div>
          {subtitle !== undefined && (
            <p className="mt-0.5 text-xs-plus leading-snug text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div>
        {rows.map((row, i) => {
          // The scope badge renders only where the page HAS a per-project choice; a
          // page that is global end to end says so once, in its header.
          const badge =
            scopeSurface !== undefined && row.field !== undefined ? (
              <ScopeBadge field={row.field} surface={scopeSurface} />
            ) : null;
          return (
            <div
              key={row.label}
              className={`py-3.5 ${i > 0 ? 'border-t border-border' : ''} ${
                row.stacked ? 'flex flex-col gap-4' : 'flex items-center gap-4'
              } ${row.hazardActive === true ? '-mx-2.5 rounded-lg bg-warning/[0.07] px-2.5' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div
                  className={`text-xs-plus3 font-medium ${
                    row.hazard === true ? 'flex items-center gap-1.5 text-warning' : ''
                  }`}
                >
                  {row.hazard === true && <AlertIcon size={13} className="shrink-0" aria-hidden />}
                  {row.label}
                </div>
                {(badge !== null || row.hint !== undefined) && (
                  <div className="mt-0.5 text-2xs-plus leading-snug text-muted-foreground">
                    {badge}
                    {row.hint}
                  </div>
                )}
              </div>
              <div className={row.stacked ? 'w-full' : 'shrink-0'}>{row.control}</div>
            </div>
          );
        })}
      </div>
      {note !== undefined && (
        <p className="pb-2.5 pt-1 text-2xs-plus leading-snug text-muted-foreground">
          {note}
        </p>
      )}
    </section>
  );
}
