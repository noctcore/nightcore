import { useProjectPathLabel } from './ProjectPathLabel.hooks';
import type { ProjectPathLabelProps } from './ProjectPathLabel.types';

/** A compact project path with its full, display-safe value available on hover/focus. */
export function ProjectPathLabel({
  path,
  className = '',
  focusable = true,
}: ProjectPathLabelProps) {
  const { compactPath, friendlyPath, tooltipId } = useProjectPathLabel(path);

  return (
    <span className={`group/path relative inline-flex min-w-0 max-w-full ${className}`}>
      {focusable ? (
        <button
          type="button"
          aria-describedby={tooltipId}
          className="block max-w-full cursor-help truncate rounded-sm bg-transparent text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {compactPath}
        </button>
      ) : (
        <span className="block max-w-full truncate rounded-sm">{compactPath}</span>
      )}
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[min(34rem,calc(100vw-2rem))] break-all rounded-md border border-border bg-popover px-2.5 py-1.5 font-mono text-[11px] text-foreground opacity-0 shadow-xl transition-opacity duration-150 group-hover/path:opacity-100 group-focus-within/path:opacity-100 group-focus/path-trigger:opacity-100"
      >
        {friendlyPath}
      </span>
    </span>
  );
}
