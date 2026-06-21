import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { Project, Task } from '@/lib/bridge';
import { ProjectsView } from './ProjectsView';

const projects: Project[] = [
  {
    id: 'nightcore',
    name: 'nightcore',
    path: '~/dev/nightcore',
    branch: 'main',
    createdAt: '2026-06-21T00:00:00Z',
    lastActiveAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  },
  {
    id: 'automaker',
    name: 'automaker (legacy)',
    path: '~/dev/automaker',
    branch: 'main',
    createdAt: '2026-06-20T00:00:00Z',
    lastActiveAt: null,
  },
];

const tasks: Task[] = [
  {
    id: 't1',
    title: 'a',
    description: '',
    status: 'done',
    dependencies: [],
    model: null,
    branch: null,
    createdAt: 0,
    updatedAt: 0,
    sessionId: null,
    summary: null,
    error: null,
    costUsd: null,
    plan: null,
    committed: false,
    merged: false,
    conflict: false,
    kind: 'build',
    verified: false,
    review: null,
    fixAttempts: 0,
  },
  {
    id: 't2',
    title: 'b',
    description: '',
    status: 'failed',
    dependencies: [],
    model: null,
    branch: null,
    createdAt: 0,
    updatedAt: 0,
    sessionId: null,
    summary: null,
    error: null,
    costUsd: null,
    plan: null,
    committed: false,
    merged: false,
    conflict: false,
    kind: 'build',
    verified: false,
    review: null,
    fixAttempts: 0,
  },
];

const meta = {
  title: 'Projects/ProjectsView',
  component: ProjectsView,
  parameters: { layout: 'fullscreen' },
  args: {
    projects,
    activeId: 'nightcore',
    activeTasks: tasks,
    runningProjectIds: ['nightcore'],
    onOpen: fn(),
    onDelete: fn(),
    onNewProject: fn(),
  },
} satisfies Meta<typeof ProjectsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  args: { projects: [], activeId: null, activeTasks: [], runningProjectIds: [] },
};
