import type { ToolRisk } from '@nightcore/contracts';

/**
 * Static risk classification for the SDK's NATIVE tools — the only tool surface
 * Nightcore runs (Read/Write/Edit/Bash/Grep/Glob, the Claude-Code mental model).
 * Nightcore ships NO in-house custom tools; the agent uses the SDK's native
 * tools and a CLI-like permission model, so risk is keyed off native tool names
 * here rather than off any in-process MCP descriptor.
 *
 * The classes mirror the contract's `ToolRisk` enum and drive how tightly the
 * PermissionLayer gates each tool:
 *   - `safe`      — read-only inspection; auto-allowed in `ask`/`auto-accept`.
 *   - `mutating`  — writes/edits state; gated by mode + allow/deny.
 *   - `dangerous` — arbitrary effect (shell, network); always prompts unless
 *                   explicitly allow-listed, even under an auto-accepting mode.
 *
 * A tool absent from this map (including any external `mcp__*` tool) yields
 * `undefined`, which the PermissionLayer folds into the most-cautious class
 * (`dangerous`) — so an unknown tool is never silently auto-allowed.
 */
const NATIVE_TOOL_RISK: Readonly<Record<string, ToolRisk>> = {
  Read: 'safe',
  Glob: 'safe',
  Grep: 'safe',
  LS: 'safe',
  TodoWrite: 'safe',
  Write: 'mutating',
  Edit: 'mutating',
  NotebookEdit: 'mutating',
  Bash: 'dangerous',
  WebFetch: 'dangerous',
  WebSearch: 'dangerous',
};

/**
 * Risk lookup for the native SDK tool surface. Kept as a small focused class
 * because surfaces import it through the engine façade and the SessionRunner
 * wires `riskOf` into the PermissionLayer; the public shape (`riskOf`) stays
 * stable for those callers.
 */
export class ToolRegistry {
  /**
   * Look up a tool's risk class by the name the model uses. Native tools resolve
   * from the static map; everything else (unknown tools, external `mcp__*`
   * servers) returns `undefined`, which callers must treat as the most-cautious
   * class (`dangerous`).
   */
  riskOf(toolName: string): ToolRisk | undefined {
    return NATIVE_TOOL_RISK[toolName];
  }
}
