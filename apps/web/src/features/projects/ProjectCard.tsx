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
    <Card onClick={() => onOpen(project.id)} className="p-[18px]">
      <div className="flex items-start gap-3">
        <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-primary/[0.14] text-primary">
          📁
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[15.5px] font-semibold">
              {project.name}
            </div>
            {project.running && (
              <Badge tone="primary" className="text-warning">
                <StatusDot colorClass="bg-warning" pulse />
                live
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {project.path}
          </div>
        </div>
        {onMenu !== undefined && (
          <span
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <IconButton label="Project menu" onClick={() => onMenu(project.id)}>
              ⋯
            </IconButton>
          </span>
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
