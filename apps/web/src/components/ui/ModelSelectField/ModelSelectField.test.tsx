import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ModelSelection } from '../ModelSelect';
import { ModelSelectField } from './ModelSelectField';

/** A controlled harness — the field is fully controlled, so the test drives state
 *  the way a real surface does. Outside Tauri the `list_models` / `get_capabilities`
 *  bridge seams degrade to the curated static catalog + Claude capabilities. */
function Harness({ onChange }: { onChange?: (next: ModelSelection) => void }) {
  const [value, setValue] = useState<ModelSelection>({ model: null, effort: null });
  return (
    <ModelSelectField
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

test('resolves the live catalog and renders the combobox + effort row', async () => {
  const screen = render(<Harness />);
  // The async catalog seam transitions loading → ready; the combobox appears once
  // the (mocked) catalog resolves.
  await expect.element(screen.getByRole('combobox', { name: /model/i })).toBeInTheDocument();
  // Claude capabilities report `supportsEffort`, so the reasoning row is shown.
  await expect
    .element(screen.getByRole('radiogroup', { name: /reasoning effort/i }))
    .toBeInTheDocument();
});

test('picking a model fires onChange with the model + resolved provider', async () => {
  const onChange = vi.fn();
  const screen = render(<Harness onChange={onChange} />);
  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /sonnet/i }).click();
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-sonnet-4-6', providerId: 'claude' }),
  );
});
