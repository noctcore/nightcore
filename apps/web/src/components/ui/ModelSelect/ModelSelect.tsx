/** A provider-grouped model combobox with an inline, model-aware reasoning-effort
 *  row. Hand-rolled on the BranchPicker combobox idiom (role=combobox + a grouped
 *  listbox, arrow/enter/esc keys, aria-expanded/controls/activedescendant). */
import { ChevronDownIcon, SparkIcon } from '../icons';
import { ProviderIcon } from '../ProviderIcon';
import { useModelSelect } from './ModelSelect.hooks';
import {
  CatalogError,
  CatalogStatus,
  EffortRow,
  LABEL,
  ModelOptionRow,
  ProviderGroupLabel,
} from './ModelSelect.parts';
import type { ModelSelectProps } from './ModelSelect.types';

/** Pick a model and its reasoning effort. The model row is a select-only combobox:
 *  the trigger summarizes the current selection (provider glyph + label + one-line
 *  description) and opens a listbox of the catalog models grouped by provider, with
 *  the chosen model checked and full keyboard navigation. The effort row is an
 *  inline, model-aware radiogroup — it surfaces only the levels the selected model
 *  supports and hints when the model reasons adaptively; switching to a model that
 *  can't honor the pinned effort resets it to Inherit. Pure presentational: the
 *  parent owns the selection value object (one `onChange`) and the catalog state. */
export function ModelSelect({
  value,
  onChange,
  catalog,
  disabled = false,
  ariaLabel,
  showEffort = true,
}: ModelSelectProps) {
  const v = useModelSelect({ value, onChange, catalog, disabled });
  const label = ariaLabel ?? 'Model';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>{label}</span>

        {catalog.status === 'loading' && <CatalogStatus />}
        {catalog.status === 'error' && (
          <CatalogError message={catalog.message} onRetry={catalog.retry} />
        )}
        {catalog.status === 'ready' && (
          <div className="relative" onBlur={v.onContainerBlur}>
            <button
              type="button"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={v.open}
              aria-controls={v.listboxId}
              aria-activedescendant={v.activeOptionId}
              aria-label={label}
              disabled={disabled}
              onClick={v.onTriggerClick}
              onKeyDown={v.onTriggerKeyDown}
              className="flex w-full items-center gap-2 rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-left transition-colors focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {v.selected.provider !== null ? (
                <ProviderIcon
                  provider={v.selected.provider}
                  size={15}
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <SparkIcon size={15} className="shrink-0 text-muted-foreground" />
              )}
              <span className="text-sm font-medium text-foreground">{v.selected.label}</span>
              <span className="ml-auto truncate pl-2 text-2xs text-muted-foreground" aria-hidden>
                {v.selected.description}
              </span>
              <ChevronDownIcon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            </button>

            {v.open && (
              <div
                role="listbox"
                id={v.listboxId}
                aria-label={label}
                className="absolute top-full z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-[10px] border border-border bg-popover p-1 shadow-2xl"
                style={{ animation: 'nc-rise .14s cubic-bezier(.22,1,.36,1)' }}
              >
                <ModelOptionRow
                  row={v.inheritRow}
                  highlighted={v.highlight === v.inheritRow.index}
                  current={v.selectedValue === null}
                  disabled={disabled}
                  onHighlight={v.onHighlight}
                  onSelect={v.selectModel}
                />
                {v.groups.map((group) => (
                  <div key={group.label} role="group" aria-label={group.label}>
                    <ProviderGroupLabel provider={group.provider} label={group.label} />
                    {group.rows.map((row) => (
                      <ModelOptionRow
                        key={row.value ?? row.id}
                        row={row}
                        highlighted={v.highlight === row.index}
                        current={v.selectedValue === row.value}
                        disabled={disabled}
                        onHighlight={v.onHighlight}
                        onSelect={v.selectModel}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {showEffort && <EffortRow effort={v.effort} disabled={disabled} onPick={v.selectEffort} />}
    </div>
  );
}
