/**
 * A ~100-line W3C WebDriver client over `fetch`, for E2E ladder ring 2 (#406).
 *
 * Deliberately hand-rolled instead of pulling in `webdriverio`: this ring needs five
 * endpoints (new session / execute sync / execute async / title / delete session), and
 * the alternative is ~100 transitive packages on the critical path of a security-
 * sensitive repo, in a job whose entire value proposition is "cheap and does not
 * flake". The same taste as `scripts/verify-drift-guard.ts` and `scripts/audit.ts`.
 *
 * Protocol notes that matter here:
 *  - every W3C response wraps its payload in `{ "value": … }`, and an ERROR response
 *    is also `{ "value": { error, message, stacktrace } }` with a non-2xx status —
 *    so a failed command must be detected from the status, not from a missing field;
 *  - `execute/async` passes an injected callback as the LAST argument to the script;
 *  - `tauri-driver` speaks this protocol verbatim and forwards to the platform driver
 *    (`WebKitWebDriver` on Linux), so nothing here is Tauri-specific except the
 *    `tauri:options` capability the caller passes in.
 */

export interface WebDriverSessionOptions {
  /** Base URL of the WebDriver server (tauri-driver's own port). */
  url: string;
  /** Absolute path of the built application binary to launch. */
  application: string;
  /** Arguments forwarded to the application. */
  args?: string[];
  /** Ceiling for a single `execute/async` script, in ms. */
  scriptTimeoutMs?: number;
}

/** A failed WebDriver command, carrying the server's own error name + message. */
export class WebDriverError extends Error {
  constructor(
    readonly command: string,
    readonly status: number,
    body: string,
  ) {
    super(`webdriver ${command} failed (HTTP ${status}): ${body}`);
    this.name = 'WebDriverError';
  }
}

export class WebDriverSession {
  private constructor(
    private readonly url: string,
    readonly sessionId: string,
  ) {}

  /** Open a session against a running `tauri-driver`, launching `application`. */
  static async open(options: WebDriverSessionOptions): Promise<WebDriverSession> {
    const body = {
      capabilities: {
        alwaysMatch: {
          'tauri:options': {
            application: options.application,
            ...(options.args ? { args: options.args } : {}),
          },
          timeouts: { script: options.scriptTimeoutMs ?? 30_000 },
        },
        firstMatch: [{}],
      },
    };
    const value = (await request(options.url, 'POST', '/session', body)) as {
      sessionId?: string;
    };
    const sessionId = value.sessionId;
    if (typeof sessionId !== 'string') {
      throw new Error(
        `webdriver new session returned no sessionId: ${JSON.stringify(value)}`,
      );
    }
    return new WebDriverSession(options.url, sessionId);
  }

  /** Run a synchronous script in the page and return its value. */
  execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return request(this.url, 'POST', `/session/${this.sessionId}/execute/sync`, {
      script,
      args,
    }) as Promise<T>;
  }

  /** Run an async script; the script MUST call its last argument to resolve. */
  executeAsync<T>(script: string, args: unknown[] = []): Promise<T> {
    return request(this.url, 'POST', `/session/${this.sessionId}/execute/async`, {
      script,
      args,
    }) as Promise<T>;
  }

  title(): Promise<string> {
    return request(this.url, 'GET', `/session/${this.sessionId}/title`) as Promise<string>;
  }

  async close(): Promise<void> {
    try {
      await request(this.url, 'DELETE', `/session/${this.sessionId}`);
    } catch {
      // A session that already died with the app is not an error worth reding a ring
      // over — the battery's own results decide pass/fail.
    }
  }
}

async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new WebDriverError(`${method} ${route}`, response.status, text);
  const parsed = JSON.parse(text) as { value?: unknown };
  return parsed.value;
}

/** Poll `url` until the WebDriver server answers, or throw after `timeoutMs`. */
export async function waitForDriver(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never attempted';
  while (Date.now() < deadline) {
    try {
      // `/status` is the one endpoint every W3C server answers before a session
      // exists. tauri-driver replies as soon as it is listening.
      const response = await fetch(`${url}/status`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`webdriver server at ${url} never came up (${lastError})`);
}
