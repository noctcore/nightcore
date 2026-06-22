/**
 * The Nightcore icon set. Every glyph in the design maps 1:1 to a lucide-react
 * icon; this module is the single import surface for them so feature code never
 * reaches into `lucide-react` directly (and the one brand glyph lucide 1.x
 * dropped — GitHub — is provided here with the design's exact path).
 *
 * Icons inherit `currentColor`; tint them with a text color at the call site
 * (`text-primary`, `text-muted-foreground`, …) exactly as the design does.
 */
import type { SVGProps } from 'react';

export {
  Play as PlayIcon,
  Square as StopIcon,
  Pencil as EditIcon,
  Trash2 as TrashIcon,
  FileText as LogsIcon,
  Sparkles as RefineIcon,
  Sparkles as SparkIcon,
  GitCommitHorizontal as CommitIcon,
  Check as CheckIcon,
  RotateCcw as RetryIcon,
  Search as SearchIcon,
  Plus as PlusIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Folder as FolderIcon,
  LayoutGrid as BoardIcon,
  Zap as BoltIcon,
  GitBranch as BranchIcon,
  Terminal as TerminalIcon,
  BookOpen as BookIcon,
  Layers as LayersIcon,
  X as CloseIcon,
  Clock as ClockIcon,
  Settings as GearIcon,
  SlidersHorizontal as SlidersIcon,
  Users as AgentsIcon,
  Lock as LockIcon,
  AlertTriangle as AlertIcon,
  MoreVertical as DotsIcon,
  Bug as BugIcon,
  Bell as BellIcon,
  Microscope as ResearchIcon,
  ShieldCheck as VerifiedIcon,
  Hammer as BuildIcon,
  ListChecks as ChecksIcon,
  GitFork as DecomposeIcon,
  ArrowRightLeft as MoveIcon,
} from 'lucide-react';

/** The GitHub brand mark — removed from lucide 1.x, so we ship the design's
 *  exact path. Shares the lucide stroke conventions so it sits inline with the
 *  rest of the set. */
export function GithubIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: 'block' }}
      {...props}
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}
