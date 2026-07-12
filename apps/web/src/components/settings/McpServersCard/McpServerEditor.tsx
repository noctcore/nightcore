/** The transport-aware editor body for the MCP server modal. */
import { RowToggle } from './McpServerRow';
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

/** Shared Tailwind classes for the editor's labels and inputs/textareas. */
const FIELD_LABEL = 'mb-1.5 block text-2xs-plus font-semibold text-muted-foreground';
const FIELD_INPUT =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary';
const FIELD_AREA = `${FIELD_INPUT} font-mono text-xs-plus leading-relaxed`;

/** The transport-aware editor body. stdio shows command/args/env; http+sse show
 *  url/headers. Secret-bearing fields (env/header values) are masked on edit. */
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
        <label className={FIELD_LABEL} htmlFor="mcp-name">
          Server name
        </label>
        <input
          id="mcp-name"
          value={draft.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="filesystem"
          className={FIELD_INPUT}
          aria-invalid={errors.name !== undefined}
          aria-describedby={
            errors.name !== undefined ? 'mcp-name-help mcp-name-error' : 'mcp-name-help'
          }
        />
        <p id="mcp-name-help" className="mt-1 text-2xs text-muted-foreground">
          The tool prefix becomes <span className="font-mono">mcp__{draft.name || 'name'}__*</span>.
        </p>
        {errors.name !== undefined && (
          <p id="mcp-name-error" className="mt-1 text-2xs text-warning">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <span className={FIELD_LABEL}>Transport</span>
        <div className="inline-flex rounded-lg border border-border bg-black/20 p-0.5">
          {TRANSPORTS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => onPatch({ transport: v })}
              className={`rounded-md px-3 py-1 text-xs-flat font-medium transition-colors ${
                v === draft.transport
                  ? 'bg-primary/[0.18] text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-command">
              Command
            </label>
            <input
              id="mcp-command"
              value={draft.command}
              onChange={(e) => onPatch({ command: e.target.value })}
              placeholder="npx"
              className={`${FIELD_INPUT} font-mono`}
              aria-invalid={errors.command !== undefined}
              aria-describedby={
                errors.command !== undefined ? 'mcp-command-error' : undefined
              }
            />
            {errors.command !== undefined && (
              <p id="mcp-command-error" className="mt-1 text-2xs text-warning">
                {errors.command}
              </p>
            )}
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-args">
              Arguments
            </label>
            <textarea
              id="mcp-args"
              rows={3}
              value={draft.argsText}
              onChange={(e) => onPatch({ argsText: e.target.value })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
              className={FIELD_AREA}
              aria-describedby="mcp-args-help"
            />
            <p id="mcp-args-help" className="mt-1 text-2xs text-muted-foreground">
              One argument per line.
            </p>
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-env">
              Environment
            </label>
            <textarea
              id="mcp-env"
              rows={2}
              value={draft.envText}
              onChange={(e) => onPatch({ envText: e.target.value })}
              placeholder="API_TOKEN=secret"
              className={FIELD_AREA}
              aria-describedby="mcp-env-help"
            />
            <p id="mcp-env-help" className="mt-1 text-2xs text-muted-foreground">
              <span className="font-mono">KEY=value</span> per line. Existing values are
              masked — retype to change.
            </p>
          </div>
        </>
      ) : (
        <>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-url">
              URL
            </label>
            <input
              id="mcp-url"
              value={draft.url}
              onChange={(e) => onPatch({ url: e.target.value })}
              placeholder="https://example.com/mcp"
              className={`${FIELD_INPUT} font-mono`}
              aria-invalid={errors.url !== undefined}
              aria-describedby={errors.url !== undefined ? 'mcp-url-error' : undefined}
            />
            {errors.url !== undefined && (
              <p id="mcp-url-error" className="mt-1 text-2xs text-warning">
                {errors.url}
              </p>
            )}
          </div>
          <div>
            <label className={FIELD_LABEL} htmlFor="mcp-headers">
              Headers
            </label>
            <textarea
              id="mcp-headers"
              rows={2}
              value={draft.headersText}
              onChange={(e) => onPatch({ headersText: e.target.value })}
              placeholder="Authorization: Bearer token"
              className={FIELD_AREA}
              aria-describedby="mcp-headers-help"
            />
            <p id="mcp-headers-help" className="mt-1 text-2xs text-muted-foreground">
              <span className="font-mono">Header: value</span> per line. Existing values
              are masked — retype to change.
            </p>
          </div>
        </>
      )}

      {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- wraps a custom role=switch button (a labelable element that forwards label clicks); the switch carries its own accessible name */}
      <label className="flex items-center gap-2.5 text-xs-plus2 text-foreground">
        <RowToggle
          on={draft.enabled}
          onChange={() => onPatch({ enabled: !draft.enabled })}
          label="Enable this server"
        />
        Inject into new sessions
      </label>
    </div>
  );
}
