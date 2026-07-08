import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { useOnboardingGate } from './useOnboardingGate.hooks';

type Gate = ReturnType<typeof useOnboardingGate>;

function Harness({ projectCount, sink }: { projectCount: number; sink: (gate: Gate) => void }) {
  const gate = useOnboardingGate(projectCount);
  useEffect(() => {
    sink(gate);
  });
  return null;
}

async function mountGate(projectCount: number): Promise<() => Gate> {
  let latest: Gate | undefined;
  render(<Harness projectCount={projectCount} sink={(gate) => (latest = gate)} />);
  await vi.waitFor(() => expect(latest).toBeDefined());
  return () => latest!;
}

test('restart opens onboarding even when projects already exist', async () => {
  window.localStorage.setItem('nightcore:onboarding-dismissed', 'true');
  const gate = await mountGate(1);
  expect(gate().show).toBe(false);

  gate().restart();
  await vi.waitFor(() => expect(gate().show).toBe(true));

  gate().dismiss();
  await vi.waitFor(() => expect(gate().show).toBe(false));
});
