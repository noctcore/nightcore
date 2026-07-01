/** The Board Background settings panel: a right-slide sheet to set a custom
 *  background image (or gif) for the Kanban board and tune card/column opacity,
 *  borders, glassmorphism, and scrollbar visibility. Presentational — the parent
 *  owns the appearance + persistence. */
import {
  Checkbox,
  CloseIcon,
  IconButton,
  ImageIcon,
  Modal,
  TrashIcon,
  UploadIcon,
} from '@/components/ui';
import type { BoardAppearance } from '@/lib/bridge';
import { BACKGROUND_ACCEPT, useBackgroundPicker } from './BoardBackgroundPanel.hooks';
import type { BoardBackgroundPanelProps } from './BoardBackgroundPanel.types';

/** Round a 0..1 opacity to a whole percentage for display. */
function pct(value: number): number {
  return Math.round(value * 100);
}

/** A labeled 0–100% opacity slider row (the value is stored as a 0..1 fraction). */
function OpacityRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">
          {pct(value)}%
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={100}
        value={pct(value)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-full accent-primary"
      />
    </div>
  );
}

export function BoardBackgroundPanel({
  appearance,
  backgroundUrl,
  onChangeAppearance,
  onPickImage,
  onClearImage,
  onClose,
}: BoardBackgroundPanelProps) {
  const picker = useBackgroundPicker(onPickImage);

  /** Merge one knob change and persist the COMPLETE next appearance. */
  const set = (patch: Partial<BoardAppearance>) => onChangeAppearance({ ...appearance, ...patch });

  return (
    <Modal
      label="Board background settings"
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      panelClassName="flex h-full w-full max-w-md flex-col overflow-hidden border-l border-border bg-popover shadow-2xl"
      panelStyle={{ animation: 'nc-sheet-in .28s cubic-bezier(.22,1,.36,1)' }}
    >
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
          <ImageIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Board Background Settings</h2>
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
            Set a custom background image for your Kanban board and adjust card/column opacity.
          </p>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        {/* --- Background image --- */}
        <section className="flex flex-col gap-2.5">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Background Image
          </h3>
          <input
            ref={picker.inputRef}
            type="file"
            accept={BACKGROUND_ACCEPT}
            hidden
            onChange={picker.onInputChange}
          />
          <div className="overflow-hidden rounded-[12px] border border-border bg-white/[0.02]">
            {backgroundUrl !== null ? (
              <img
                src={backgroundUrl}
                alt="Current board background"
                className="h-40 w-full object-cover"
              />
            ) : (
              <div className="flex h-40 w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
                <ImageIcon size={22} className="opacity-50" />
                <span className="text-[12px]">No custom background</span>
              </div>
            )}
            <div className="flex gap-2 border-t border-border p-2.5">
              <button
                type="button"
                disabled={picker.busy}
                onClick={picker.openPicker}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[12.5px] font-semibold text-foreground transition-colors hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <UploadIcon size={14} className="text-muted-foreground" />
                {picker.busy ? 'Loading…' : backgroundUrl !== null ? 'Change Image' : 'Choose Image'}
              </button>
              {backgroundUrl !== null && (
                <button
                  type="button"
                  disabled={picker.busy}
                  onClick={() => void onClearImage()}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/[0.14] px-3 py-2 text-[12.5px] font-semibold text-destructive transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <TrashIcon size={14} />
                  Clear
                </button>
              )}
            </div>
          </div>
          {picker.error !== null && (
            <span role="alert" className="text-[11.5px] text-destructive">
              {picker.error}
            </span>
          )}
          <p className="text-[10.5px] leading-snug text-muted-foreground/70">
            PNG, JPEG, WebP, or GIF · ≤ 15 MB. Lower the opacities below to let it show through.
          </p>
        </section>

        {/* --- Opacity + toggles --- */}
        <div className="flex flex-col gap-4">
          <OpacityRow
            label="Card Opacity"
            value={appearance.cardOpacity}
            onChange={(v) => set({ cardOpacity: v })}
          />
          <OpacityRow
            label="Column Opacity"
            value={appearance.columnOpacity}
            onChange={(v) => set({ columnOpacity: v })}
          />
          <Checkbox
            label="Show Column Borders"
            checked={appearance.showColumnBorders}
            onChange={(v) => set({ showColumnBorders: v })}
          />
          <Checkbox
            label="Card Glassmorphism (blur effect)"
            checked={appearance.cardGlassmorphism}
            onChange={(v) => set({ cardGlassmorphism: v })}
          />
          <Checkbox
            label="Show Card Borders"
            checked={appearance.showCardBorders}
            onChange={(v) => set({ showCardBorders: v })}
          />
          <OpacityRow
            label="Card Border Opacity"
            value={appearance.cardBorderOpacity}
            onChange={(v) => set({ cardBorderOpacity: v })}
          />
          <Checkbox
            label="Hide Board Scrollbar"
            checked={appearance.hideBoardScrollbar}
            onChange={(v) => set({ hideBoardScrollbar: v })}
          />
        </div>
      </div>
    </Modal>
  );
}
