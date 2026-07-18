/** The transport-aware editor body for the MCP server modal. */
import {
  FIELD_INPUT_CLASS,
  FieldLabel,
  SectionLabel,
  Segmented,
  TextField,
  Toggle,
} from '@/components/ui';

import type {
  McpDraftValidation,
  McpServerDraft,
  McpTransport,
} from './McpServersCard.types';

/** The selectable transports, as `[value, label]` pairs for the segmented control. */
const TRANSPORTS: [value: McpTransport, label: string][] = [
  ['stdio', 'stdio'],
  ['http', 'HTTP'],
  ['sse', 'SSE'],
];

/** Layout applied to each field's label — the shared mono-uppercase micro style
 *  (via `FieldLabel`/`SectionLabel`) plus the block + bottom-gap that stacks it over
 *  its input. */
const LABEL_LAYOUT = 'mb-1.5 block';
/** The shared field chrome composed with the mono/relaxed treatment the multi-line
 *  args/env/headers areas use. */
const FIELD_AREA_CLASS = `${FIELD_INPUT_CLASS} font-mono text-xs-plus leading-relaxed`;

/** The transport-aware editor body. stdio shows command/args/env; http+sse show
 *  url/headers. Secret-bearing fields (env/header values) are masked on edit. A
 *  blocking field error uses the destructive treatment (red) — amber is reserved for
 *  non-blocking cautions. */
export function McpServerEditor({
  draft,
  errors,
  onPatch,
}: {
  draft: McpServerDraft;
  errors: Pick<McpDraftValidation, 'name' | 'command' | 'url'>;
  onPatch: (patch: Partial<McpServerDraft>) => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-5">
      <div>
        <FieldLabel htmlFor="mcp-name" className={LABEL_LAYOUT}>
          Server name
        </FieldLabel>
        <TextField
          id="mcp-name"
          value={draft.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="filesystem"
          aria-invalid={errors.name !== undefined}
          aria-describedby={
            errors.name !== undefined ? 'mcp-name-help mcp-name-error' : 'mcp-name-help'
          }
        />
        <p id="mcp-name-help" className="mt-1 text-2xs text-muted-foreground">
          The tool prefix becomes <span className="font-mono">mcp__{draft.name || 'name'}__*</span>.
        </p>
        {errors.name !== undefined && (
          <p id="mcp-name-error" className="mt-1 text-2xs text-destructive">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <SectionLabel className={LABEL_LAYOUT}>Transport</SectionLabel>
        <Segmented
          ariaLabel="Transport"
          options={TRANSPORTS}
          value={draft.transport}
          onChange={(v) => onPatch({ transport: v as McpTransport })}
        />
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <div>
            <FieldLabel htmlFor="mcp-command" className={LABEL_LAYOUT}>
              Command
            </FieldLabel>
            <TextField
              id="mcp-command"
              value={draft.command}
              onChange={(e) => onPatch({ command: e.target.value })}
              placeholder="npx"
              className="font-mono"
              aria-invalid={errors.command !== undefined}
              aria-describedby={
                errors.command !== undefined ? 'mcp-command-error' : undefined
              }
            />
            {errors.command !== undefined && (
              <p id="mcp-command-error" className="mt-1 text-2xs text-destructive">
                {errors.command}
              </p>
            )}
          </div>
          <div>
            <FieldLabel htmlFor="mcp-args" className={LABEL_LAYOUT}>
              Arguments
            </FieldLabel>
            <textarea
              id="mcp-args"
              rows={3}
              value={draft.argsText}
              onChange={(e) => onPatch({ argsText: e.target.value })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
              className={FIELD_AREA_CLASS}
              aria-describedby="mcp-args-help"
            />
            <p id="mcp-args-help" className="mt-1 text-2xs text-muted-foreground">
              One argument per line.
            </p>
          </div>
          <div>
            <FieldLabel htmlFor="mcp-env" className={LABEL_LAYOUT}>
              Environment
            </FieldLabel>
            <textarea
              id="mcp-env"
              rows={2}
              value={draft.envText}
              onChange={(e) => onPatch({ envText: e.target.value })}
              placeholder="API_TOKEN=secret"
              className={FIELD_AREA_CLASS}
              aria-describedby="mcp-env-help"
            />
            <p id="mcp-env-help" className="mt-1 text-2xs text-muted-foreground">
              <span className="font-mono">KEY=value</span> per line. Existing values are
              masked. Retype to change one.
            </p>
          </div>
        </>
      ) : (
        <>
          <div>
            <FieldLabel htmlFor="mcp-url" className={LABEL_LAYOUT}>
              URL
            </FieldLabel>
            <TextField
              id="mcp-url"
              value={draft.url}
              onChange={(e) => onPatch({ url: e.target.value })}
              placeholder="https://example.com/mcp"
              className="font-mono"
              aria-invalid={errors.url !== undefined}
              aria-describedby={errors.url !== undefined ? 'mcp-url-error' : undefined}
            />
            {errors.url !== undefined && (
              <p id="mcp-url-error" className="mt-1 text-2xs text-destructive">
                {errors.url}
              </p>
            )}
          </div>
          <div>
            <FieldLabel htmlFor="mcp-headers" className={LABEL_LAYOUT}>
              Headers
            </FieldLabel>
            <textarea
              id="mcp-headers"
              rows={2}
              value={draft.headersText}
              onChange={(e) => onPatch({ headersText: e.target.value })}
              placeholder="Authorization: Bearer token"
              className={FIELD_AREA_CLASS}
              aria-describedby="mcp-headers-help"
            />
            <p id="mcp-headers-help" className="mt-1 text-2xs text-muted-foreground">
              <span className="font-mono">Header: value</span> per line. Existing values
              are masked. Retype to change one.
            </p>
          </div>
        </>
      )}

      {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- wraps a custom role=switch button (a labelable element that forwards label clicks); the switch carries its own accessible name */}
      <label className="flex items-center gap-2.5 text-xs-plus2 text-foreground">
        <Toggle
          on={draft.enabled}
          onChange={(next) => onPatch({ enabled: next })}
          label="Enable this server"
        />
        Inject into new sessions
      </label>
    </div>
  );
}
