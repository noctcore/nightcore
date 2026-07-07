/** The live-wired model picker: the pure `ui/ModelSelect` combobox bound to the
 *  real bridge seams. It owns the async catalog load (`list_models`) and the
 *  provider-capability probe (`get_capabilities`) so consuming surfaces just render
 *  `<ModelSelectField value onChange />` — no catalog threading, no per-surface
 *  fetch. The effort row is gated on the provider's `supportsEffort` capability. */
import { ModelSelect, useModelCatalog } from '../ModelSelect';
import {
  LIVE_MODEL_CATALOG_DATA,
  useProviderCapabilities,
} from './ModelSelectField.hooks';
import type { ModelSelectFieldProps } from './ModelSelectField.types';

/** Drop-in per-surface model + effort picker. Presentational logic lives in
 *  `ui/ModelSelect`; this shell only binds the live catalog + capability seams. The
 *  selection props (`value`/`onChange`/`disabled`/`ariaLabel`) pass straight through
 *  — this wrapper OWNS the catalog + effort-gate, it isn't a prop-drill. */
export function ModelSelectField(props: ModelSelectFieldProps) {
  const catalog = useModelCatalog(LIVE_MODEL_CATALOG_DATA);
  const capabilities = useProviderCapabilities();
  return (
    <ModelSelect
      {...props}
      catalog={catalog}
      // Fail-open: an unknown (still-loading / failed probe) descriptor keeps the
      // effort row so a control is never silently dropped.
      showEffort={capabilities?.supportsEffort ?? true}
    />
  );
}
