import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { StaleChip } from './StaleChip';

test('renders a Stale chip', async () => {
  const screen = render(<StaleChip title="The issue changed on GitHub" />);
  await expect.element(screen.getByText('Stale')).toBeInTheDocument();
});
