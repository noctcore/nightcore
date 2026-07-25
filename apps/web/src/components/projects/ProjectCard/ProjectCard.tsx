/** @file ProjectCard — a single project card on the Projects surface. */
import {
  Badge,
  Card,
  ClockIcon,
  DotsIcon,
  EditIcon,
  IconButton,
  Menu,
  ProjectIcon,
  ProjectPathLabel,
  StatusDot,
  TrashIcon,
} from '@/components/ui';
import { useProjectIconProps } from '@/components/ui/ProjectIcon/ProjectIcon.hooks';

import { useProjectCard } from './ProjectCard.hooks';
import type { ProjectCardProps, ProjectSummary } from './ProjectCard.types';

const STAT_TONE: Record<ProjectSummary['stats'][number]['tone'], string> = {
  neutral: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
};

/** A single project card on the Projects view — repo identity, live badge,
 *  stat tiles, and last activity. The kebab opens Edit / Remove. */
export function ProjectCard({ project, onOpen, onEdit, onDelete }: ProjectCardProps) {
  const card = useProjectCard({ project, onDelete });
  const iconProps = useProjectIconProps(project);
  const hasMenu = onEdit !== undefined || onDelete !== undefined;

  return (
    <Card className="p-[18px]">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => onOpen(project.id)}
          className="group/path-trigger flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-nc border border-border bg-white/[0.03]">
            <ProjectIcon {...iconProps} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[15.5px] font-semibold">{project.name}</span>
              {project.running && (
                <Badge tone="primary" className="text-warning">
                  <StatusDot colorClass="bg-warning" pulse />
                  live
                </Badge>
              )}
            </span>
            <ProjectPathLabel
              path={project.path}
              focusable={false}
              className="mt-0.5 font-mono text-2xs text-muted-foreground"
            />
          </span>
        </button>
        {hasMenu && (
          <Menu
            label="Project menu"
            trigger={
              <IconButton label="Project menu">
                <DotsIcon size={16} />
              </IconButton>
            }
            items={[
              ...(onEdit !== undefined
                ? [{ label: 'Edit project', icon: <EditIcon size={14} />, onClick: () => onEdit(project.id) }]
                : []),
              ...(onDelete !== undefined
                ? [
                    {
                      label: 'Remove',
                      icon: <TrashIcon size={14} />,
                      onClick: card.requestRemove,
                      destructive: true,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </div>
      <div className="mt-4 flex gap-1.5">
        {project.stats.map((s) => (
          <div
            key={s.label}
            className="flex-1 rounded-nc bg-white/[0.025] px-1 py-2 text-center"
          >
            <div
              className={`font-mono text-base font-semibold tabular-nums ${s.value === null ? 'text-muted-foreground' : STAT_TONE[s.tone]}`}
            >
              {s.value === null ? '–' : s.value}
            </div>
            <div className="mt-0.5 text-4xs-plus uppercase tracking-[0.08em] text-muted-foreground">
              {s.label}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 flex items-center gap-1.5 text-2xs-plus text-muted-foreground">
        <ClockIcon size={12} />
        <span>{project.activity}</span>
      </div>

    </Card>
  );
}
