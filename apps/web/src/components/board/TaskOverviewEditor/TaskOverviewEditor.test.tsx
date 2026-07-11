import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { makeTask } from '../_fixtures.task';
import { TaskOverviewEditor } from './TaskOverviewEditor';

test('commits an edited title on blur, trimmed', async () => {
  const onChangeTitle = vi.fn();
  const task = makeTask({ id: 't-1', title: 'Old title' });
  const screen = render(
    <TaskOverviewEditor task={task} onChangeTitle={onChangeTitle} onChangeDescription={() => {}} />,
  );
  const input = screen.getByLabelText('Title');
  await userEvent.fill(input, '  New title  ');
  await userEvent.tab(); // blur
  expect(onChangeTitle).toHaveBeenCalledWith('t-1', 'New title');
});

test('does not commit a blank or unchanged title', async () => {
  const onChangeTitle = vi.fn();
  const task = makeTask({ id: 't-1', title: 'Keep me' });
  const screen = render(
    <TaskOverviewEditor task={task} onChangeTitle={onChangeTitle} onChangeDescription={() => {}} />,
  );
  const input = screen.getByLabelText('Title');
  await userEvent.fill(input, '   ');
  await userEvent.tab();
  expect(onChangeTitle).not.toHaveBeenCalled();
});

test('commits an edited description on blur (including clearing it)', async () => {
  const onChangeDescription = vi.fn();
  const task = makeTask({ id: 't-2', description: 'was here' });
  const screen = render(
    <TaskOverviewEditor task={task} onChangeTitle={() => {}} onChangeDescription={onChangeDescription} />,
  );
  const textarea = screen.getByLabelText('Description');
  await userEvent.fill(textarea, 'now this');
  await userEvent.tab();
  expect(onChangeDescription).toHaveBeenCalledWith('t-2', 'now this');
});
