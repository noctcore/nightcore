/** Public types for the ModelSelectField — the live-wired ModelSelect wrapper. */
import type { ModelSelection } from '../ModelSelect';

/** Props for {@link ModelSelectField}. Mirrors the presentational ModelSelect's
 *  selection contract (one value object + one `onChange`) but owns the live catalog
 *  + capability seams internally, so a consuming surface never threads the catalog. */
export interface ModelSelectFieldProps {
  /** The current selection (model + effort + optional provider). Controlled. */
  value: ModelSelection;
  /** Fired with the next selection whenever the model or effort changes. */
  onChange: (next: ModelSelection) => void;
  /** Disable the whole control (e.g. once a task/run has started). */
  disabled?: boolean;
  /** Accessible name for the combobox. Defaults to "Model". */
  ariaLabel?: string;
}
