/**
 * The Nightcore icon set. Each glyph re-exports a lucide-react icon under a
 * Nightcore name; this module is the single import surface for them so feature
 * code never reaches into `lucide-react` directly (and the one brand glyph
 * lucide 1.x dropped — GitHub — is provided here).
 *
 * Icons inherit `currentColor`; tint them with a text color at the call site
 * (`text-primary`, `text-muted-foreground`, …).
 */
import type { SVGProps } from 'react';

export {
  Users as AgentsIcon,
  AlertTriangle as AlertIcon,
  Bell as BellIcon,
  LayoutGrid as BoardIcon,
  Zap as BoltIcon,
  BookOpen as BookIcon,
  Brain as BrainIcon,
  GitBranch as BranchIcon,
  Bug as BugIcon,
  Hammer as BuildIcon,
  Check as CheckIcon,
  ListChecks as ChecksIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Clock as ClockIcon,
  X as CloseIcon,
  Columns2 as Columns2Icon,
  GitCommitHorizontal as CommitIcon,
  GitFork as DecomposeIcon,
  Package as DepsIcon,
  Palette as DesignIcon,
  MoreVertical as DotsIcon,
  Pencil as EditIcon,
  ExternalLink as ExternalLinkIcon,
  Folder as FolderIcon,
  Settings as GearIcon,
  History as HistoryIcon,
  Image as ImageIcon,
  Lightbulb as InsightIcon,
  Layers as LayersIcon,
  Lock as LockIcon,
  FileText as LogsIcon,
  GitMerge as MergeIcon,
  ArrowRightLeft as MoveIcon,
  PanelLeftClose as PanelLeftCloseIcon,
  PanelLeft as PanelLeftIcon,
  Paperclip as PaperclipIcon,
  Gauge as PerfIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  MessageCircleQuestion as QuestionIcon,
  Wrench as RefactorIcon,
  Sparkles as RefineIcon,
  RefreshCw as RefreshIcon,
  Microscope as ResearchIcon,
  RotateCcw as RetryIcon,
  Search as SearchIcon,
  SlidersHorizontal as SlidersIcon,
  Sparkles as SparkIcon,
  Square as StopIcon,
  Tag as TagIcon,
  Terminal as TerminalIcon,
  Trash2 as TrashIcon,
  Upload as UploadIcon,
  ShieldCheck as VerifiedIcon,
} from 'lucide-react';

/** The GitHub brand mark — removed from lucide 1.x, so it ships here. Shares the
 *  lucide stroke conventions so it sits inline with the rest of the set. */
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
