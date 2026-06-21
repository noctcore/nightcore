import { Badge, Card, IconButton, StatusDot } from '../../shared/ui';
import type { ProjectSummary } from './types';

const STAT_TONE: Record<ProjectSummary['stats'][number]['tone'], string> = {
  neutral: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
};

interface ProjectCardProps {
  project: ProjectSummary;
  onOpen: (id: string) => void;
  onMenu?: (id: string) => void;
}

/** A single project card on the Projects view — repo identity, live badge,
 *  stat tiles, and last activity. */
export function ProjectCard({ project, onOpen, onMenu }: ProjectCardProps) {
  return (
    <Card className="p-[18px]">
      <div className="flex items-start gap-3">
        {/* The identity block is the open affordance; the menu button is a
            sibling, never nested inside another button (invalid HTML). */}
        <button
          type="button"
          onClick={() => onOpen(project.id)}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-primary/[0.14] text-primary">
            📁
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[15.5px] font-semibold">
                {project.name}
              </span>
              {project.running && (
                <Badge tone="primary" className="text-warning">
                  <StatusDot colorClass="bg-warning" pulse />
                  live
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
              {project.path}
            </span>
          </span>
        </button>
        {onMenu !== undefined && (
          <IconButton label="Project menu" onClick={() => onMenu(project.id)}>
            ⋯
          </IconButton>
        )}
      </div>
      <div className="mt-4 flex gap-1.5">
        {project.stats.map((s) => (
          <div
            key={s.label}
            className="flex-1 rounded-[9px] bg-white/[0.025] px-1 py-2 text-center"
          >
            <div
              className={`font-mono text-base font-semibold tabular-nums ${STAT_TONE[s.tone]}`}
            >
              {s.value}
            </div>
            <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
              {s.label}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        🕑 <span>{project.activity}</span>
      </div>
    </Card>
  );
}
