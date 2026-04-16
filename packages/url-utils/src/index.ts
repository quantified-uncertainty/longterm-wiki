/**
 * @longterm-wiki/url-utils — Canonical URL normalization for the longterm-wiki system.
 *
 * One helper, options when needed. Replaces the historical sprawl of seven
 * `normalizeUrl`-style functions across crux/, apps/web/, and scripts/, each
 * with subtly different semantics (QUA-341).
 *
 * Default semantics: strip tracking params, fragment, www, trailing slash;
 * lowercase host; preserve protocol and case-sensitive path.
 *
 * Use options for the legitimate variations:
 *   - `stripProtocol`  — for protocol-agnostic comparison
 *   - `lowercasePath`  — for case-insensitive dedup
 *   - `sortParams`     — for deterministic lookup keys
 *   - `keepTracking`   — for footnote-style dedup that wants the raw query
 */

const TRACKING_PREFIXES = ["utm_", "mc_", "oly_"];
const TRACKING_EXACT = new Set(["fbclid", "gclid", "yclid", "msclkid", "_ga"]);

export interface NormalizeUrlOptions {
  /** Drop the `http://` / `https://` scheme entirely. Default: false. */
  stripProtocol?: boolean;
  /** Lowercase the path component (lossy but useful for case-insensitive dedup). Default: false. */
  lowercasePath?: boolean;
  /** Sort remaining query parameters alphabetically. Default: false. */
  sortParams?: boolean;
  /** Keep tracking parameters (utm_*, fbclid, ...). Default: false (strip them). */
  keepTracking?: boolean;
}

/**
 * Normalize a URL into a stable comparison/lookup key.
 *
 * Always: lowercases host, strips `www.` prefix, strips fragment, strips
 * trailing slash, strips default ports (`:80` for http, `:443` for https),
 * removes tracking parameters (utm_*, fbclid, gclid, ...) unless
 * `keepTracking` is set.
 *
 * Falls back to a trimmed-lowercased version of the input if it can't be
 * parsed as a URL — this keeps fuzzy lookups working on malformed inputs.
 */
export function normalizeUrl(raw: string, opts: NormalizeUrlOptions = {}): string {
  const { stripProtocol, lowercasePath, sortParams, keepTracking } = opts;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim().replace(/\/+$/, "").toLowerCase();
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  const portSuffix =
    url.port === "" ||
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
      ? ""
      : `:${url.port}`;

  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (!keepTracking) {
      const keyLower = k.toLowerCase();
      if (TRACKING_EXACT.has(keyLower)) continue;
      if (TRACKING_PREFIXES.some((p) => keyLower.startsWith(p))) continue;
    }
    params.append(k, v);
  }
  if (sortParams) params.sort();
  const qs = params.toString();

  let path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  if (lowercasePath) path = path.toLowerCase();

  const scheme = stripProtocol ? "" : `${url.protocol}//`;
  return `${scheme}${host}${portSuffix}${path}${qs ? "?" + qs : ""}`;
}

/** Extract just the host portion, normalized (lowercased, www-stripped). */
export function extractHost(raw: string): string {
  try {
    let host = new URL(raw).hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return "(invalid-url)";
  }
}
