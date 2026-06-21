import { useMemo } from 'react';
import type { Task } from '@/lib/bridge';
import type { ProjectSummary } from '../ProjectCard';
import type { ProjectsViewProps } from './ProjectsView.types';

/** Relative-time label from an ISO8601 timestamp, best-effort. */
function activityLabel(lastActiveAt: string | null): string {
  if (lastActiveAt === null) return 'never run';
  const then = Date.parse(lastActiveAt);
  if (Number.isNaN(then)) return 'recently';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return 'active just now';
  if (mins < 60) return `active ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `active ${hrs}h ago`;
  return `active ${Math.round(hrs / 24)}d ago`;
}

/** Stat tiles for a project. Counts are only known for the active project (its
 *  tasks are loaded); other projects show zeroes until activated. */
function statsFor(tasks: Task[]): ProjectSummary['stats'] {
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  return [
    { label: 'tasks', value: tasks.length, tone: 'neutral' },
    { label: 'done', value: done, tone: 'success' },
    { label: 'failed', value: failed, tone: 'warning' },
  ];
}

/** Map the registry + active-project tasks into the ProjectCard view-models. */
export function useProjectSummaries({
  projects,
  activeId,
  activeTasks,
  runningProjectIds,
}: Pick<
  ProjectsViewProps,
  'projects' | 'activeId' | 'activeTasks' | 'runningProjectIds'
>): ProjectSummary[] {
  return useMemo(
    () =>
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        running: runningProjectIds.includes(p.id),
        stats: statsFor(p.id === activeId ? activeTasks : []),
        activity: activityLabel(p.lastActiveAt),
      })),
    [projects, activeId, activeTasks, runningProjectIds],
  );
}
