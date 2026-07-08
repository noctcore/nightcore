import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { CheckIcon, GithubIcon, SearchIcon } from './icons';

test('lucide re-export renders svg', () => {
  const screen = render(<SearchIcon size={16} />);
  expect(screen.container.querySelector('svg')).not.toBeNull();
});

test('custom GithubIcon renders', () => {
  const screen = render(<GithubIcon size={16} />);
  expect(screen.container.querySelector('svg')).not.toBeNull();
});

test('CheckIcon renders', () => {
  const screen = render(<CheckIcon size={12} />);
  expect(screen.container.querySelector('svg')).not.toBeNull();
});
