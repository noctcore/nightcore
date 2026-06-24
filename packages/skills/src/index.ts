/**
 * @nightcore/skills — Nightcore skill / subagent presets.
 *
 * A "skill" maps onto the SDK's `AgentDefinition` (own prompt, tools, model,
 * permission mode), invoked via the SDK's `Agent` tool. The engine reads
 * `nightcoreSkills` to offer subagents/presets.
 *
 * Imports `contracts` only — never the engine (dependency inversion). Tool
 * names are declared as `mcp__nightcore__<tool>` literals here so this package
 * stays SDK-free and dependency-light.
 */

/**
 * A Nightcore agent preset. The fields after `name` mirror the SDK's
 * `AgentDefinition` (description, prompt, optional tools/model) structurally —
 * re-declared here so this package stays SDK-free. The engine keys these by
 * `name` into `Options.agents: Record<string, AgentDefinition>`.
 */
export interface SkillDefinition {
  /** Agent name, used as the `Options.agents` record key and invoked via the
   *  SDK `Agent` tool. */
  name: string;
  /** Natural-language description of when to use this agent. */
  description: string;
  /** The agent's system prompt. */
  prompt: string;
  /** Optional tool allowlist; omitted = inherit all tools from the parent. */
  tools?: string[];
  /** Optional model alias/id override; omitted = inherit the main model. */
  model?: string;
}

/** Fully-qualified name of a Nightcore in-process tool, e.g. `mcp__nightcore__grep`. */
function nightcoreTool(name: string): string {
  return `mcp__nightcore__${name}`;
}

/**
 * Read-only investigator. Has every non-mutating capability (read, list, search,
 * git inspection) but no write/edit/exec — it can analyse a codebase and report
 * without changing anything. Pair with a strict permission mode upstream.
 */
const reviewerSkill: SkillDefinition = {
  name: 'reviewer',
  description: 'Read-only code reviewer: inspects and reports, never edits.',
  prompt: [
    'You are a meticulous code reviewer operating in read-only mode.',
    'Investigate the codebase using read_file, list_dir, glob, grep, git_status,',
    'and git_diff. You must NOT modify any file or run shell commands.',
    'Produce findings as a concise, prioritised report: correctness bugs first,',
    'then maintainability and reuse opportunities. Cite file paths and line',
    'numbers. If you are unsure, say so rather than guessing.',
  ].join(' '),
  tools: [
    nightcoreTool('read_file'),
    nightcoreTool('list_dir'),
    nightcoreTool('glob'),
    nightcoreTool('grep'),
    nightcoreTool('git_status'),
    nightcoreTool('git_diff'),
  ],
};

/**
 * Full-capability implementer. Adds the mutating tools (write, edit, run) on top
 * of the read/search surface so it can actually land changes. Mutating tools
 * remain gated by the engine's PermissionLayer at execution time.
 */
const builderSkill: SkillDefinition = {
  name: 'builder',
  description: 'Implements changes end-to-end: reads, edits, and verifies.',
  prompt: [
    'You are a focused implementation agent. Read and search the codebase to',
    'understand it, then make the smallest correct change to satisfy the task.',
    'Use write_file and edit_file to apply changes and run_command to verify',
    '(typecheck, tests). Follow existing conventions, avoid unrelated edits, and',
    'leave the working tree in a verifiable state. Report what you changed and',
    'how you confirmed it.',
  ].join(' '),
  tools: [
    nightcoreTool('read_file'),
    nightcoreTool('list_dir'),
    nightcoreTool('glob'),
    nightcoreTool('grep'),
    nightcoreTool('write_file'),
    nightcoreTool('edit_file'),
    nightcoreTool('git_status'),
    nightcoreTool('git_diff'),
    nightcoreTool('run_command'),
  ],
};

/** The registered skills the engine can offer as subagents. */
export const nightcoreSkills: SkillDefinition[] = [reviewerSkill, builderSkill];
