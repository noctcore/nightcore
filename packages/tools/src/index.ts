import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { ToolDescriptor } from '@nightcore/contracts';
import { echoTool } from './echo.js';
import { readFileTool } from './read-file.js';
import { writeFileTool, editFileTool, listDirTool } from './fs.js';
import { globTool, grepTool } from './search.js';
import { gitStatusTool, gitDiffTool } from './git.js';
import { runCommandTool } from './shell.js';

export { echoTool } from './echo.js';
export { readFileTool } from './read-file.js';
export { writeFileTool, editFileTool, listDirTool, applyEdit } from './fs.js';
export { globTool, grepTool, globToRegExp, filterByGlob, grepNode } from './search.js';
export {
  gitStatusTool,
  gitDiffTool,
  parseGitStatus,
  describeStatus,
  type GitStatusEntry,
} from './git.js';
export { runCommandTool } from './shell.js';

/**
 * The name of the in-process SDK MCP server Nightcore registers. Tool names the
 * model sees are namespaced `mcp__<server>__<tool>`.
 */
export const NIGHTCORE_MCP_SERVER_NAME = 'nightcore';

/** Fully-qualified tool name as the model sees it. */
export function qualifiedToolName(toolName: string): string {
  return `mcp__${NIGHTCORE_MCP_SERVER_NAME}__${toolName}`;
}

/**
 * Every Nightcore-defined tool. The engine's ToolRegistry hands this array to
 * `createSdkMcpServer`. Capability packages export the raw definitions; they
 * never import the engine (dependency inversion).
 */
// The SDK's own `tools` field is typed `Array<SdkMcpToolDefinition<any>>`
// (sdk.d.ts) because the generic is invariant in its handler arg: each tool's
// handler accepts only its own narrow input shape, so a heterogeneous array of
// concretely-typed tools cannot unify under the default `AnyZodRawShape` (it
// collapses the arg to `{ [x: string]: never }`). `any` is the SDK-sanctioned
// erasure here; `ZodTypeAny`/`unknown` do not satisfy the `extends AnyZodRawShape`
// constraint. Kept eslint-disabled to match the SDK contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const nightcoreTools: Array<SdkMcpToolDefinition<any>> = [
  echoTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  gitStatusTool,
  gitDiffTool,
  runCommandTool,
];

/**
 * Static metadata for each tool, for surfaces that want to render the catalog.
 * `risk` drives the permission tier: `safe` (read-only) may auto-allow; `mutating`
 * (write/edit) is gated by mode + allow/deny; `dangerous` (shell exec) always
 * prompts unless explicitly allow-listed. `mutating` is kept in sync with `risk`
 * (`risk !== 'safe'`) for legacy readers.
 */
export const nightcoreToolDescriptors: ToolDescriptor[] = [
  {
    name: qualifiedToolName('echo'),
    description: 'Echo a message back to the caller.',
    source: 'nightcore',
    risk: 'safe',
    mutating: false,
  },
  {
    name: qualifiedToolName('read_file'),
    description: 'Read a UTF-8 text file from the local filesystem.',
    source: 'nightcore',
    risk: 'safe',
    mutating: false,
  },
  {
    name: qualifiedToolName('write_file'),
    description: 'Write (create or overwrite) a UTF-8 text file.',
    source: 'nightcore',
    risk: 'mutating',
    mutating: true,
  },
  {
    name: qualifiedToolName('edit_file'),
    description: 'Edit a text file by exact string replacement.',
    source: 'nightcore',
    risk: 'mutating',
    mutating: true,
  },
  {
    name: qualifiedToolName('list_dir'),
    description: 'List the entries of a directory.',
    source: 'nightcore',
    risk: 'safe',
    mutating: false,
  },
  {
    name: qualifiedToolName('glob'),
    description: 'Find files by glob pattern.',
    source: 'nightcore',
    risk: 'safe',
    mutating: false,
  },
  {
    name: qualifiedToolName('grep'),
    description: 'Search file contents by regex (ripgrep with Node fallback).',
    source: 'nightcore',
    risk: 'safe',
    mutating: false,
  },
  {
    name: qualifiedToolName('git_status'),
    description: 'Show the git working-tree status.',
    source: 'nightcore',
    risk: 'safe',
    mutating: false,
  },
  {
    name: qualifiedToolName('git_diff'),
    description: 'Show the git diff of the working tree.',
    source: 'nightcore',
    risk: 'safe',
    mutating: false,
  },
  {
    name: qualifiedToolName('run_command'),
    description: 'Run a shell command (dangerous; permission-gated).',
    source: 'nightcore',
    risk: 'dangerous',
    mutating: true,
  },
];
