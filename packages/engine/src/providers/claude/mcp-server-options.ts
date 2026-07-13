/**
 * Translates the user-configured external MCP server entries (the `transport`-tagged
 * contract shape) into the Claude Agent SDK's `Options.mcpServers` map. Kept in its
 * own module so the translation is unit-testable in isolation, without spinning a
 * `query()` or importing the rest of the option-composition surface.
 */
import type { McpServerEntry } from '@nightcore/contracts';

import type { McpServerConfig } from './sdk-adapter.js';

/**
 * Translate the user-configured external MCP server entries (the `transport`-tagged
 * contract shape) into the SDK's `Options.mcpServers` map (`Record<name,
 * McpServerConfig>`). Pure, so it is unit-testable without spinning a query.
 *
 * Three translations matter:
 *  - filter to `enabled` entries (the Rust core already does this, but re-filtering
 *    here keeps the helper correct on any caller);
 *  - the entry `name` becomes the record KEY (the SDK keys on it, and it is the
 *    `mcp__<name>__*` tool prefix) — a later duplicate name wins (last write);
 *  - `transport` → the SDK's `type`: OMITTED for stdio (the SDK's `type?: 'stdio'`
 *    defaults to stdio), SET to `'http'`/`'sse'` for the remote transports.
 *
 * Returns `undefined` when no enabled entry survives, so the caller can omit the
 * `mcpServers` key entirely (byte-identical to the pre-feature options).
 */
export function toSdkMcpServers(
  entries: McpServerEntry[] | undefined,
): Record<string, McpServerConfig> | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const servers: Record<string, McpServerConfig> = {};
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const { config } = entry;
    if (config.transport === 'stdio') {
      // stdio: OMIT `type` (the SDK defaults it). Only set `env` when non-empty so
      // the options stay minimal.
      servers[entry.name] = {
        command: config.command,
        args: config.args,
        ...(Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      };
    } else {
      // http / sse: SET `type` to the transport; only set `headers` when non-empty.
      servers[entry.name] = {
        type: config.transport,
        url: config.url,
        ...(Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : {}),
      };
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}
