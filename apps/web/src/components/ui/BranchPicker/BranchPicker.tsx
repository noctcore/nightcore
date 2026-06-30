/** A presentational branch combobox: type to filter, arrow/Enter to pick, with an
 *  optional "create" affordance for branches that don't exist yet. */
import { BranchIcon, PlusIcon } from '../icons';
import { useBranchPicker } from './BranchPicker.hooks';
import { BranchOptionRow, SectionLabel } from './BranchPicker.parts';
import type { BranchPickerProps } from './BranchPicker.types';

/** Choose or name a git branch. The current branch name is fully controlled and
 *  doubles as the filter query: as you type, the dropdown lists branches whose
 *  name contains the text (case-insensitive), grouped local vs remote, with the
 *  checked-out branch marked and ahead/behind tracking shown. When the text
 *  matches no branch (and `allowCreate`), a "Create "<text>"" row keeps the typed
 *  value — the branch itself is created server-side. Pure presentational: the
 *  parent supplies the branch list and persists the chosen value. */
export function BranchPicker({
  value,
  onChange,
  branches,
  allowCreate = true,
  placeholder,
  disabled = false,
  ariaLabel,
}: BranchPickerProps) {
  const v = useBranchPicker({ value, onChange, branches, allowCreate, disabled });
  const label = ariaLabel ?? 'Branch';
  const createRow = v.createRow;

  return (
    <div className="relative" onBlur={v.onContainerBlur}>
      <div
        className={`flex items-center gap-2 rounded-[10px] border bg-black/20 px-3 transition-colors focus-within:border-primary ${
          disabled ? 'border-border opacity-60' : 'border-border'
        }`}
      >
        <BranchIcon size={14} className="shrink-0 text-muted-foreground" />
        <input
          type="text"
          role="combobox"
          aria-expanded={v.open}
          aria-controls={v.listboxId}
          aria-autocomplete="list"
          aria-activedescendant={v.activeOptionId}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={v.onInputChange}
          onFocus={v.onInputFocus}
          onKeyDown={v.onKeyDown}
          className="w-full bg-transparent py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
        />
      </div>

      {v.open && (
        <div
          role="listbox"
          id={v.listboxId}
          aria-label={label}
          className="absolute top-full z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-[10px] border border-border bg-popover p-1 shadow-2xl"
          style={{ animation: 'nc-rise .14s cubic-bezier(.22,1,.36,1)' }}
        >
          {v.localRows.length > 0 && (
            <div role="group" aria-label="Local branches">
              <SectionLabel>Local</SectionLabel>
              {v.localRows.map((row) => (
                <BranchOptionRow
                  key={row.branch.name}
                  row={row}
                  highlighted={row.index === v.highlight}
                  onHighlight={v.onHighlight}
                  onSelect={v.selectBranch}
                />
              ))}
            </div>
          )}

          {v.remoteRows.length > 0 && (
            <div role="group" aria-label="Remote branches">
              <SectionLabel>Remote</SectionLabel>
              {v.remoteRows.map((row) => (
                <BranchOptionRow
                  key={row.branch.name}
                  row={row}
                  highlighted={row.index === v.highlight}
                  onHighlight={v.onHighlight}
                  onSelect={v.selectBranch}
                />
              ))}
            </div>
          )}

          {!v.hasMatches && (
            <div role="presentation" className="px-2 py-2 text-[12.5px] text-muted-foreground">
              No matching branches
            </div>
          )}

          {createRow !== null && (
            <button
              id={createRow.id}
              type="button"
              role="option"
              aria-selected={createRow.index === v.highlight}
              onMouseEnter={() => v.onHighlight(createRow.index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={v.selectCreate}
              className={`mt-0.5 flex w-full items-center gap-1.5 rounded-[8px] border-t border-border/60 px-2 py-1.5 text-left transition-colors ${
                createRow.index === v.highlight ? 'bg-primary/[0.12]' : 'hover:bg-white/[0.04]'
              }`}
            >
              <PlusIcon size={13} className="shrink-0 text-primary" aria-hidden />
              <span className="truncate text-[13px] text-foreground">
                Create &ldquo;<span className="font-medium text-primary">{createRow.value}</span>&rdquo;
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
