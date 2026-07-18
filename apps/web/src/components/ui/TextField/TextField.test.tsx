import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { FIELD_INPUT_CLASS, FieldLabel, TextField } from './TextField';

test('TextField renders an input on the shared field chrome and forwards props', async () => {
  const onChange = vi.fn();
  const screen = render(
    <TextField aria-label="Name" placeholder="filesystem" onChange={onChange} />,
  );
  const input = screen.getByLabelText('Name').element();
  expect(input.tagName).toBe('INPUT');
  expect(input.className).toContain('focus:border-primary');
  expect(input.getAttribute('placeholder')).toBe('filesystem');
});

test('TextField appends a caller className onto the canonical class', async () => {
  const screen = render(<TextField aria-label="Command" className="font-mono" />);
  const input = screen.getByLabelText('Command').element();
  expect(input.className).toContain(FIELD_INPUT_CLASS);
  expect(input.className).toContain('font-mono');
});

test('FieldLabel binds to its input via htmlFor in the section-label style', async () => {
  const screen = render(<FieldLabel htmlFor="pr-title">Title</FieldLabel>);
  const label = screen.getByText('Title').element();
  expect(label.tagName).toBe('LABEL');
  expect(label.getAttribute('for')).toBe('pr-title');
  expect(label.className).toContain('font-mono');
  expect(label.className).toContain('uppercase');
});
