import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { BoltIcon } from '../icons';
import { Toggle } from '../Toggle';
import { ToolbarOption } from './ToolbarOption';
import * as stories from './ToolbarOption.stories';

const { Toggles, WithSettings } = composeStories(stories);

test('fires onToggle when the main section is clicked', async () => {
  await Toggles.run();
});

test('opens the settings popover when the gear is clicked', async () => {
  await WithSettings.run();
});

test('closes the settings popover on Escape and restores focus to the trigger', async () => {
  const screen = render(
    <ToolbarOption
      label="Escape feature"
      on={false}
      onToggle={vi.fn()}
      icon={<BoltIcon size={14} className="text-muted-foreground" />}
      settingsLabel="Escape feature options"
      settings={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs-plus font-semibold text-foreground">Sample option</span>
          <Toggle on={false} onChange={() => {}} label="Sample option" />
        </div>
      }
    />,
  );
  const trigger = screen.container.querySelector(
    'button[aria-label="Escape feature options"]',
  ) as HTMLButtonElement;
  await userEvent.click(trigger);
  expect(screen.container.querySelector('[role="group"]')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  expect(screen.container.querySelector('[role="group"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('closes the settings popover on outside click', async () => {
  const screen = render(
    <div>
      <ToolbarOption
        label="Outside feature"
        on={false}
        onToggle={vi.fn()}
        settingsLabel="Outside feature options"
        settings={<span>Inside</span>}
      />
      <button type="button">After control</button>
    </div>,
  );
  const trigger = screen.container.querySelector(
    'button[aria-label="Outside feature options"]',
  ) as HTMLButtonElement;
  await userEvent.click(trigger);
  expect(screen.container.querySelector('[role="group"]')).not.toBeNull();
  const after = [...screen.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'After control',
  ) as HTMLButtonElement;
  await userEvent.click(after);
  expect(screen.container.querySelector('[role="group"]')).toBeNull();
});

test('renders without a settings trigger when settings is omitted', async () => {
  const screen = render(
    <ToolbarOption label="Toggle only feature" on={false} onToggle={vi.fn()} />,
  );
  expect(screen.container.querySelector('button[aria-pressed]')).not.toBeNull();
  expect(screen.container.querySelector('button[aria-label$="options"]')).toBeNull();
});
