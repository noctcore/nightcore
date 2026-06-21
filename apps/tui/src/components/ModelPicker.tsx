import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SelectOption } from '@opentui/core';
import type { EffortLevel, ModelDescriptor } from '@nightcore/contracts';

interface ModelPickerProps {
  models: ModelDescriptor[];
  currentModel: string;
  /** Commit the choice. `effort` is null when the model has no effort levels,
   *  or the operator chose adaptive. App closes the overlay afterwards; App also
   *  owns Esc-to-dismiss while this overlay is open. */
  onSelect: (model: string, effort: EffortLevel | null) => void;
}

/** Sentinel value for the "adaptive (let the model decide)" effort option. */
const ADAPTIVE = '__adaptive__';

type Phase =
  | { step: 'model' }
  | { step: 'effort'; model: ModelDescriptor };

/**
 * Two-step `/model` picker. Step 1 lists models from the engine's dynamic
 * `listModels()`. If the chosen model `supportsEffort`, step 2 offers ONLY its
 * `supportedEffortLevels` (plus adaptive). Effort has no live SDK setter, so the
 * footer is honest that the effort choice applies to the NEXT session.
 *
 * While this overlay is open `App` routes Esc here and blurs the input; arrow
 * keys + Enter (or number keys) drive the `<select>`.
 */
export function ModelPicker({
  models,
  currentModel,
  onSelect,
}: ModelPickerProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ step: 'model' });

  const modelOptions = useMemo<SelectOption[]>(
    () =>
      models.map((m) => ({
        name: m.value === currentModel ? `${m.displayName} (current)` : m.displayName,
        description: m.supportsEffort
          ? `${m.description} · effort: ${m.supportedEffortLevels.join(', ')}`
          : m.description,
        value: m,
      })),
    [models, currentModel],
  );

  const effortOptions = useMemo<SelectOption[]>(() => {
    if (phase.step !== 'effort') return [];
    return [
      { name: 'adaptive', description: 'let the model decide', value: ADAPTIVE },
      ...phase.model.supportedEffortLevels.map((level) => ({
        name: level,
        description: `reasoning effort: ${level}`,
        value: level,
      })),
    ];
  }, [phase]);

  const onModelChosen = useCallback(
    (_index: number, option: SelectOption | null) => {
      const model = option?.value as ModelDescriptor | undefined;
      if (model === undefined) return;
      if (model.supportsEffort && model.supportedEffortLevels.length > 0) {
        setPhase({ step: 'effort', model });
      } else {
        onSelect(model.value, null);
      }
    },
    [onSelect],
  );

  const onEffortChosen = useCallback(
    (_index: number, option: SelectOption | null) => {
      if (phase.step !== 'effort') return;
      const value = option?.value as EffortLevel | typeof ADAPTIVE | undefined;
      if (value === undefined) return;
      onSelect(phase.model.value, value === ADAPTIVE ? null : value);
    },
    [phase, onSelect],
  );

  if (models.length === 0) {
    return (
      <box
        title="/model"
        style={{
          border: true,
          borderColor: '#5fafff',
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'column',
        }}
      >
        <text fg="#d7af00">No models reported by the engine.</text>
        <text fg="#666666">esc to close</text>
      </box>
    );
  }

  if (phase.step === 'effort') {
    return (
      <box
        title={`effort for ${phase.model.displayName}`}
        style={{
          border: true,
          borderColor: '#5fafff',
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'column',
          height: Math.min(effortOptions.length + 4, 12),
        }}
      >
        <select
          focused
          options={effortOptions}
          onSelect={onEffortChosen}
          showDescription
        />
        <text fg="#777777">
          ↑↓ select · enter confirm · esc cancel — effort applies to the NEXT
          session
        </text>
      </box>
    );
  }

  return (
    <box
      title="/model — pick a model"
      style={{
        border: true,
        borderColor: '#5fafff',
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
        height: Math.min(modelOptions.length + 4, 14),
      }}
    >
      <select
        focused
        options={modelOptions}
        onSelect={onModelChosen}
        showDescription
      />
      <text fg="#777777">↑↓ select · enter confirm · esc cancel</text>
    </box>
  );
}

export type { ModelPickerProps };
export { ADAPTIVE };
