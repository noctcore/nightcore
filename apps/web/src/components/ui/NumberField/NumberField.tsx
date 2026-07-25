/** A numeric input bound to an optional ceiling setting (SDK guardrails). */
import type { ReactNode } from 'react';

import { parseNumericCommit } from '@/lib/numeric-field';

import type { NumberFieldProps } from './NumberField.types';

/** A numeric input bound to an optional ceiling setting (SDK guardrails). Empty
 *  ⇒ the field inherits (the placeholder shows the inherited/default value). A
 *  committed value is sent via `onCommit`; an empty/blank or unchanged value is a
 *  no-op (the Rust side cannot clear an `Option` ceiling back to inherit, so the
 *  control only ever SETS a value — matching the model/effort override contract). */
export function NumberField({
  value,
  placeholder,
  onCommit,
  step,
  min,
  ariaLabel,
  prefix,
}: NumberFieldProps): ReactNode {
  const commit = (raw: string) => {
    const parsed = parseNumericCommit(raw, value, min ?? 0);
    if (parsed !== null) onCommit(parsed);
  };
  return (
    <div className="nc-focus-ring-host inline-flex items-center gap-1.5 rounded-lg border border-border bg-black/20 px-2.5 py-1.5 focus-within:border-primary">
      {prefix !== undefined && (
        <span className="font-mono text-xs-flat text-muted-foreground">{prefix}</span>
      )}
      <input
        type="number"
        inputMode="numeric"
        step={step}
        min={min}
        aria-label={ariaLabel}
        defaultValue={value ?? ''}
        key={value ?? 'empty'}
        placeholder={placeholder}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-[88px] bg-transparent text-right font-mono text-xs-plus text-foreground outline-none placeholder:text-muted-foreground/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  );
}
