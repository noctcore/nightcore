import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  AgentsIcon,
  AlertIcon,
  BellIcon,
  BoardIcon,
  BoltIcon,
  BookIcon,
  BrainIcon,
  BranchIcon,
  BugIcon,
  BuildIcon,
  CheckIcon,
  ChecksIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  CommitIcon,
  DecomposeIcon,
  DepsIcon,
  DesignIcon,
  DotsIcon,
  EditIcon,
  ExternalLinkIcon,
  FolderIcon,
  GearIcon,
  GithubIcon,
  HistoryIcon,
  ImageIcon,
  InsightIcon,
  LayersIcon,
  LockIcon,
  LogsIcon,
  MergeIcon,
  MoveIcon,
  PaperclipIcon,
  PerfIcon,
  PlayIcon,
  PlusIcon,
  QuestionIcon,
  RefactorIcon,
  RefineIcon,
  RefreshIcon,
  ResearchIcon,
  RetryIcon,
  SearchIcon,
  SlidersIcon,
  SparkIcon,
  StopIcon,
  TagIcon,
  TerminalIcon,
  TrashIcon,
  UploadIcon,
  VerifiedIcon,
} from './icons';

const GLYPHS: { name: string; Icon: typeof CheckIcon }[] = [
  { name: 'Agents', Icon: AgentsIcon },
  { name: 'Alert', Icon: AlertIcon },
  { name: 'Bell', Icon: BellIcon },
  { name: 'Board', Icon: BoardIcon },
  { name: 'Bolt', Icon: BoltIcon },
  { name: 'Book', Icon: BookIcon },
  { name: 'Brain', Icon: BrainIcon },
  { name: 'Branch', Icon: BranchIcon },
  { name: 'Bug', Icon: BugIcon },
  { name: 'Build', Icon: BuildIcon },
  { name: 'Check', Icon: CheckIcon },
  { name: 'Checks', Icon: ChecksIcon },
  { name: 'ChevronDown', Icon: ChevronDownIcon },
  { name: 'ChevronLeft', Icon: ChevronLeftIcon },
  { name: 'ChevronRight', Icon: ChevronRightIcon },
  { name: 'Clock', Icon: ClockIcon },
  { name: 'Close', Icon: CloseIcon },
  { name: 'Commit', Icon: CommitIcon },
  { name: 'Decompose', Icon: DecomposeIcon },
  { name: 'Deps', Icon: DepsIcon },
  { name: 'Design', Icon: DesignIcon },
  { name: 'Dots', Icon: DotsIcon },
  { name: 'Edit', Icon: EditIcon },
  { name: 'ExternalLink', Icon: ExternalLinkIcon },
  { name: 'Folder', Icon: FolderIcon },
  { name: 'Gear', Icon: GearIcon },
  { name: 'Github', Icon: GithubIcon },
  { name: 'History', Icon: HistoryIcon },
  { name: 'Image', Icon: ImageIcon },
  { name: 'Insight', Icon: InsightIcon },
  { name: 'Layers', Icon: LayersIcon },
  { name: 'Lock', Icon: LockIcon },
  { name: 'Logs', Icon: LogsIcon },
  { name: 'Merge', Icon: MergeIcon },
  { name: 'Move', Icon: MoveIcon },
  { name: 'Paperclip', Icon: PaperclipIcon },
  { name: 'Perf', Icon: PerfIcon },
  { name: 'Play', Icon: PlayIcon },
  { name: 'Plus', Icon: PlusIcon },
  { name: 'Question', Icon: QuestionIcon },
  { name: 'Refactor', Icon: RefactorIcon },
  { name: 'Refine', Icon: RefineIcon },
  { name: 'Refresh', Icon: RefreshIcon },
  { name: 'Research', Icon: ResearchIcon },
  { name: 'Retry', Icon: RetryIcon },
  { name: 'Search', Icon: SearchIcon },
  { name: 'Sliders', Icon: SlidersIcon },
  { name: 'Spark', Icon: SparkIcon },
  { name: 'Stop', Icon: StopIcon },
  { name: 'Tag', Icon: TagIcon },
  { name: 'Terminal', Icon: TerminalIcon },
  { name: 'Trash', Icon: TrashIcon },
  { name: 'Upload', Icon: UploadIcon },
  { name: 'Verified', Icon: VerifiedIcon },
];

const meta = {
  title: 'UI/icons',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every Nightcore icon at 18px — the shared import surface for feature code. */
export const Gallery: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
        gap: 16,
        color: 'var(--foreground, #e6e6f0)',
      }}
    >
      {GLYPHS.map(({ name, Icon }) => (
        <div
          key={name}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            color: 'var(--muted-foreground, #888)',
          }}
        >
          <Icon size={18} />
          <span>{name}</span>
        </div>
      ))}
    </div>
  ),
};
