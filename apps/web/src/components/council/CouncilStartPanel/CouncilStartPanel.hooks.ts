/** Local draft state for the {@link import('./CouncilStartPanel').CouncilStartPanel}
 *  form — the objective the council debates, the chosen preset, and the in-flight /
 *  error status of the convene dispatch. The convene DEFERS the parent's phase change
 *  until the dispatch resolves, so a failed start keeps the draft + shows the reason
 *  inline (GOV-5); the pattern mirrors the ConvergeGavel's busy/error dispatch. */
import { useCallback, useState } from 'react';

import type { CouncilPresetId } from '@/lib/bridge';

import { DEFAULT_COUNCIL_PRESET } from '../council-presets';
import type { CouncilStartPanelProps } from './CouncilStartPanel.types';

export interface CouncilStartPanelModel {
  objective: string;
  setObjective: (value: string) => void;
  /** The chosen preset id — passed through to `start_council`. */
  presetId: CouncilPresetId;
  selectPreset: (id: CouncilPresetId) => void;
  /** True once the objective has non-whitespace content — gates the Convene button. */
  canStart: boolean;
  /** True while the convene dispatch is in flight (drives the button's busy state). */
  starting: boolean;
  /** The last convene failure, surfaced inline so the draft survives a failed start. */
  startError: string | null;
  /** Convene: dispatch the chosen preset over the objective. A no-op when not ready or
   *  already starting; on failure the draft is preserved and the error surfaces inline. */
  submit: () => void;
}

export function useCouncilStartPanel(
  onStart: CouncilStartPanelProps['onStart'],
  disabled: boolean,
): CouncilStartPanelModel {
  const [objective, setObjective] = useState('');
  const [presetId, setPresetId] = useState<CouncilPresetId>(DEFAULT_COUNCIL_PRESET);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const submit = useCallback(() => {
    const trimmed = objective.trim();
    if (trimmed.length === 0 || disabled || starting) return;
    setStarting(true);
    setStartError(null);
    // On success the parent flips to `running` and unmounts the panel, so `starting` is
    // intentionally left set through the transition (like the gavel's busy flag).
    void onStart(trimmed, presetId).catch((error: unknown) => {
      setStarting(false);
      setStartError(
        error instanceof Error ? error.message : 'Could not start the council.',
      );
    });
  }, [objective, presetId, disabled, starting, onStart]);

  return {
    objective,
    setObjective,
    presetId,
    selectPreset: setPresetId,
    canStart: objective.trim().length > 0,
    starting,
    startError,
    submit,
  };
}
