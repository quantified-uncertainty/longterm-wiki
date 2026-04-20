/**
 * Shared HTTP utilities for T1 importers.
 *
 * Extracts the previously-duplicated User-Agent constant, fetch resolver,
 * and header builder so all three importers share one definition.
 */

/**
 * User-Agent sent on outbound requests.
 *
 * SEC requires accurate identification per
 * https://www.sec.gov/os/accessing-edgar-data — they enforce 403 on missing
 * UA. We use the org bot address to keep personal contact info out of
 * outbound requests + git history.
 */
export const USER_AGENT = "longterm-wiki <bot@quantifieduncertainty.org>";

export interface HttpOptions {
  /** Override the global fetch — used by tests to inject responses. */
  fetchImpl?: typeof fetch;
  /** Override the User-Agent. Stripped of CR/LF to prevent header injection. */
  userAgent?: string;
}

export function getFetch(opts: HttpOptions): typeof fetch {
  return opts.fetchImpl ?? globalThis.fetch;
}

/**
 * Sanitize a header value: strip CR/LF + leading/trailing whitespace.
 * Header injection via interpolated user values is the failure mode this
 * guards. The User-Agent is the only header in our hot path that can be
 * caller-overridden today; this keeps the door closed.
 */
export function sanitizeHeaderValue(v: string): string {
  return v.replace(/[\r\n]/g, "").trim();
}

export function getUserAgent(opts: HttpOptions): string {
  return sanitizeHeaderValue(opts.userAgent ?? USER_AGENT);
}
