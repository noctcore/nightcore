/** A project view-model for the Projects surface. Projects are an M2 concept
 *  (multi-repo, worktree isolation); this shape backs the design's project
 *  cards ahead of the Rust-side registry landing. */
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  running: boolean;
  stats: { label: string; value: number; tone: 'neutral' | 'success' | 'warning' }[];
  activity: string;
}
