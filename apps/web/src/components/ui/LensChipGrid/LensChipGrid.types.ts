/** Props for {@link LensChipGrid} and {@link ScanConfigForm}. */
import type { ComponentType, ReactNode } from 'react';

/** One toggleable lens chip (category / dimension / lens). */
export interface LensChipDescriptor<K extends string = string> {
  key: K;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

export interface LensChipGridProps<K extends string = string> {
  /** Section heading, e.g. `Categories (4/8)` — the family owns the copy. */
  heading: string;
  /** The full chip vocabulary in canonical display order. */
  chips: readonly LensChipDescriptor<K>[];
  /** Membership test for the pressed state. */
  selected: ReadonlySet<K>;
  onToggle: (key: K) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}

export interface ScanConfigFormProps<K extends string = string>
  extends LensChipGridProps<K> {
  /** The model/effort picker, composed by the family so this shell stays a
   *  layout owner instead of a wire for the picker's four props. Each family
   *  renders its own `<ModelEffortPicker …/>` into this slot. */
  picker: ReactNode;
  /** Slot between the picker and the chip grid (e.g. Insight's scope radio). */
  beforeChips?: ReactNode;
  /** Whether the run action is currently permitted (≥1 chip, project open). */
  canRun: boolean;
  /** True while the optimistic-start IPC is in flight (busy CTA). */
  isStarting: boolean;
  onRun: () => void;
  /** The idle CTA icon (family-sized, e.g. `<InsightIcon size={15} />`). */
  ctaIcon: ReactNode;
  /** The busy CTA icon (defaults to a 15px spinner). */
  ctaBusyIcon?: ReactNode;
  /** The idle CTA label (`Analyze` / `Grade readiness` / `Scan`). */
  ctaLabel: string;
  /** CTA class override (default `w-full sm:w-auto`). */
  ctaClassName?: string;
  /** The cost/scope hint line under the CTA. */
  hint: ReactNode;
  /** Wrap the form in its own scroll container (default true; a family whose
   *  parent already scrolls passes false). */
  scrollable?: boolean;
}
