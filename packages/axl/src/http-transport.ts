import { AxlError } from './errors.js';

/**
 * Guard the provider endpoints that Axl's built-in adapters send prompts and
 * credentials to. This intentionally classifies only the parsed URL host: it
 * never performs DNS resolution, so a hostname which happens to resolve to
 * loopback is not silently trusted.
 */
export function assertSafeProviderBaseUrl(
  baseUrl: string,
  surface: string,
  dangerouslyAllowInsecureHttp = false,
): void {
  assertSafeHttpEndpoint(baseUrl, surface, dangerouslyAllowInsecureHttp, 'prompts and credentials');
}

/**
 * Shared secure-default policy for SDK-owned HTTP transports. Callers provide
 * the data-at-risk wording so errors remain accurate at provider and MCP seams.
 */
export function assertSafeHttpEndpoint(
  endpoint: string,
  surface: string,
  dangerouslyAllowInsecureHttp = false,
  exposedData = 'sensitive data',
): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw unsafeTransportError(surface, 'a valid absolute HTTP(S) URL', exposedData);
  }

  if (url.protocol === 'https:') return;

  if (url.protocol !== 'http:') {
    throw unsafeTransportError(surface, 'an HTTPS URL', exposedData);
  }

  if (dangerouslyAllowInsecureHttp || isLiteralLoopbackHost(url.hostname)) return;

  throw unsafeTransportError(
    surface,
    'an HTTPS URL, or set dangerouslyAllowInsecureHttp: true only for a deliberately insecure endpoint',
    exposedData,
  );
}

function isLiteralLoopbackHost(hostname: string): boolean {
  // URL.hostname is normalized by the WHATWG parser: host casing is folded,
  // legacy IPv4 spellings become dotted decimal, and IPv6 remains bracketed.
  // This deliberately does not admit IPv4-mapped IPv6 addresses.
  return (
    hostname === 'localhost' ||
    hostname === 'localhost.' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '[::1]'
  );
}

function unsafeTransportError(surface: string, remediation: string, exposedData: string): AxlError {
  return new AxlError(
    'UNSAFE_TRANSPORT',
    `${surface} requires ${remediation}. Remote HTTP can expose ${exposedData} in transit.`,
  );
}
