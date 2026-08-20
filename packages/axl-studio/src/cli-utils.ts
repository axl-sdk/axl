/**
 * CLI utilities for `axl-studio`.
 *
 * Loader / glob / config-detection helpers now live in `@axlsdk/axl`'s
 * `cli-internals` (shared with `@axlsdk/eval` so fixes apply atomically);
 * this file holds the studio-specific arg parser and re-exports what
 * dependent modules consume.
 */

export { CONFIG_CANDIDATES, findConfig, needsTsxLoader, importModule } from '@axlsdk/axl';

/** Standalone Studio is an unauthenticated local-development surface. */
export const STUDIO_CLI_HOST = '127.0.0.1';

type StandaloneFetch = (request: Request) => Response | Promise<Response>;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === 'localhost.' || hostname === '127.0.0.1';
}

/** Reject DNS-rebinding Host values before standalone Studio serves admin data. */
export function isAllowedStandaloneHost(host: string | undefined): boolean {
  if (!host) return false;

  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }

  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  return isLoopbackHostname(url.hostname);
}

/**
 * Browser WebSocket handshakes carry an Origin header even though they are not
 * governed by CORS. Standalone Studio accepts only local browser origins; CLI
 * and other non-browser clients may omit Origin.
 */
export function isAllowedStandaloneOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;

  return isLoopbackHostname(url.hostname);
}

/** Standalone Studio accepts only loopback authorities and local/absent origins. */
export function isAllowedStandaloneRequest(
  host: string | undefined,
  origin: string | undefined,
): boolean {
  return isAllowedStandaloneHost(host) && isAllowedStandaloneOrigin(origin);
}

/**
 * Guard the standalone HTTP boundary before Hono routing. This blocks hostile
 * simple POSTs as well as DNS-rebinding reads, and is intentionally separate
 * from CORS response headers.
 */
export function withStandaloneRequestGuard(fetch: StandaloneFetch): StandaloneFetch {
  return (request) => {
    const host = request.headers.get('host') ?? undefined;
    const origin = request.headers.get('origin') ?? undefined;
    if (!isAllowedStandaloneRequest(host, origin)) {
      return Response.json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN_HOST_ORIGIN',
            message: 'Standalone Studio accepts requests only through a local host and origin',
          },
        },
        { status: 403 },
      );
    }
    return fetch(request);
  };
}

// ── Parse CLI args ──────────────────────────────────────────────────

export interface CliArgs {
  port: number;
  host: string;
  config?: string;
  open: boolean;
  conditions: string[];
  readOnly: boolean;
  help: boolean;
  portError?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let port = 4400;
  let host = STUDIO_CLI_HOST;
  let config: string | undefined;
  let open = false;
  let help = false;
  let conditions: string[] = [];
  let readOnly = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--dangerously-bind' && argv[i + 1]) {
      host = argv[i + 1];
      i++;
    } else if (arg === '--config' && argv[i + 1]) {
      config = argv[i + 1];
      i++;
    } else if (arg === '--conditions' && argv[i + 1]) {
      conditions = argv[i + 1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      i++;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '--read-only' || arg === '--readonly') {
      readOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    }
  }

  const result: CliArgs = { port, host, config, open, help, conditions, readOnly };

  if (isNaN(port) || port < 1 || port > 65535) {
    result.portError = `Invalid port: ${port}. Must be between 1 and 65535.`;
  }

  return result;
}
