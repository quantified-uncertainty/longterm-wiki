/**
 * URL-resolves verifier (QUA-927).
 *
 * Cheap, fast verification path for facts whose source-of-truth IS the URL itself
 * (wikipedia-url, github-profile, google-scholar, social-media handles, …).
 * Content-claim verification is tautological for these — there's no separate claim
 * to compare against the source content. But the URL is still checkable: does it
 * resolve? Does the destination match the entity?
 *
 * Cost: $0. Latency: ~10ms vs ~5s+ for an LLM call.
 *
 * Verdict mapping:
 * - 2xx (after redirect-follow) → `confirmed`
 * - 4xx/5xx → `contradicted` (link rot)
 * - Network error / timeout → `unverifiable`
 *
 * Wikipedia-specific: also fetches the page and checks the `<title>` contains
 * the entity name as a whole-word match. A Wikipedia URL that resolves but
 * points at a different article (e.g., a redirect from `/wiki/Anthropic_(company)`
 * to a generic disambiguation page) is `contradicted`, not `confirmed`.
 *
 * Security:
 * - SSRF defense: hostnames matching private/loopback/internal patterns
 *   (RFC1918, link-local, localhost, .internal/.local) are rejected before
 *   the request fires. Final response URL after redirects is re-validated;
 *   if a redirect lands on an internal host the verdict is `unverifiable`.
 * - URLs with embedded credentials (`user:pass@host`) are rejected.
 * - Only http(s) protocols are accepted.
 *
 * Hardening considered out of scope (no observed need): full DNS-pinning to
 * defeat rebinding, robots.txt parsing, per-host token-bucket rate limit
 * (orchestrator-level concurrency cap is the existing knob).
 */

import type { SourcingVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import type { VerifyItem, VerifyResult } from './orchestrator-types.ts';

const URL_RESOLVES_TIMEOUT_MS = 10_000;
const URL_RESOLVES_USER_AGENT =
  'longterm-wiki url-resolves-verifier (https://www.longtermwiki.com)';
/** Cap on Wikipedia HTML body read; only `<title>` is needed and it's near the top. */
const WIKIPEDIA_BODY_CAP_BYTES = 64 * 1024;

/** Confidence values used in returned verdicts. */
const CONFIDENCE_DEFINITE = 0.95;
const CONFIDENCE_HIGH = 0.85;
const CONFIDENCE_MEDIUM = 0.7;

/** HTTP statuses where a server has rejected HEAD; retry with GET. */
const HEAD_NOT_ALLOWED_STATUSES = new Set([405, 501]);

/** Verdict + machine-readable reason returned by the underlying HTTP probe. */
interface UrlResolvesProbeResult {
  verdict: SourcingVerdict;
  confidence: number;
  reasoning: string;
  finalUrl?: string;
  /** HTML <title> text, when fetched (Wikipedia path). */
  pageTitle?: string;
}

/**
 * Public entry point. Returns a VerifyResult to be stored, or null if the item
 * is not eligible for url-resolves verification (caller should fall through to
 * content-claim).
 */
export async function tryUrlResolvesVerify(item: VerifyItem): Promise<VerifyResult | null> {
  if (item.data.kind !== 'fact') return null;
  const data = item.data;
  if (data.verifierKind !== 'url-resolves') return null;

  // The URL we verify is the fact's stored value, not fact.source.
  // Use rawValue only — formattedValue can include display formatting (units,
  // wrappers) that would parse as garbage.
  const urlToCheck = data.rawValue;
  if (!urlToCheck || !looksLikeUrl(urlToCheck)) {
    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: 1.0,
      extractedValue: '',
      reasoning: `[url-resolves] fact value is not an http(s) URL: ${truncate(urlToCheck ?? '<empty>', 80)}`,
      sourceUrl: item.sourceUrl ?? '',
      checkerModel: 'url-resolves',
    };
  }

  // SSRF defense: reject internal/private/loopback hostnames before any fetch.
  // The redirect-target is re-validated below; this catches the direct case.
  const hostnameError = rejectIfInternalHost(urlToCheck);
  if (hostnameError) {
    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: 1.0,
      extractedValue: '',
      reasoning: `[url-resolves] ${hostnameError}`,
      sourceUrl: item.sourceUrl ?? urlToCheck,
      checkerModel: 'url-resolves',
    };
  }

  const isWikipedia = data.propertyId === 'wikipedia-url';

  const probe = isWikipedia
    ? await probeWikipediaUrl(urlToCheck, data.entity.name)
    : await probeUrlResolves(urlToCheck);

  return {
    itemId: item.id,
    kind: item.kind,
    description: item.description,
    verdict: probe.verdict,
    confidence: probe.confidence,
    extractedValue: probe.pageTitle ?? probe.finalUrl ?? '',
    reasoning: probe.reasoning,
    // Persist the actual checked URL as sourceUrl so the verdict points at the
    // thing we verified (matches existing fact.source for these properties).
    sourceUrl: item.sourceUrl ?? urlToCheck,
    checkerModel: 'url-resolves',
  };
}

// ── HEAD/GET probe ──────────────────────────────────────────────────

/**
 * Probe a URL with HEAD; fall back to GET-no-body if HEAD is rejected (some
 * servers return 405/501 for HEAD).
 *
 * The GET fallback releases the body via `response.body?.cancel()` so we don't
 * hold the socket open waiting for a body we never read.
 */
export async function probeUrlResolves(url: string): Promise<UrlResolvesProbeResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, 'HEAD');
    if (HEAD_NOT_ALLOWED_STATUSES.has(response.status)) {
      // HEAD not allowed — retry with GET. Cancel the HEAD response body
      // (probably empty for HEAD anyway) and the GET response body once we
      // have status, so neither connection lingers.
      await safeCancel(response.body);
      response = await fetchWithTimeout(url, 'GET');
    }
  } catch (e: unknown) {
    return {
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: CONFIDENCE_MEDIUM,
      reasoning: `[url-resolves] network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Always release the body — neither HEAD nor the GET-fallback consumes it.
  await safeCancel(response.body);

  // If the redirect chain landed on an internal host, treat as unverifiable —
  // belt-and-suspenders to the pre-fetch check.
  const finalHostError = rejectIfInternalHost(response.url);
  if (finalHostError) {
    return {
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: 1.0,
      reasoning: `[url-resolves] redirected to internal host: ${finalHostError}`,
      finalUrl: response.url,
    };
  }

  if (response.status >= 200 && response.status < 300) {
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: CONFIDENCE_DEFINITE,
      reasoning: `[url-resolves] HTTP ${response.status}${response.url !== url ? ` (redirected to ${response.url})` : ''}`,
      finalUrl: response.url,
    };
  }

  if (response.status >= 400) {
    return {
      verdict: 'contradicted' as SourcingVerdict,
      confidence: CONFIDENCE_DEFINITE,
      reasoning: `[url-resolves] HTTP ${response.status} — link rot or removed`,
      finalUrl: response.url,
    };
  }

  // 3xx not normally reachable when redirect: 'follow' is set — fetch follows
  // up to 20 then throws. Defensive branch.
  return {
    verdict: 'unverifiable' as SourcingVerdict,
    confidence: 0.6,
    reasoning: `[url-resolves] unexpected HTTP ${response.status}`,
    finalUrl: response.url,
  };
}

/**
 * Wikipedia-specific probe: fetch the page (GET, not HEAD — we need the title)
 * and check that the article title contains the entity name as a whole-word
 * match. Catches the case where a wikipedia-url resolves but points at the
 * wrong article (e.g., a disambiguation page).
 */
export async function probeWikipediaUrl(
  url: string,
  entityName: string,
): Promise<UrlResolvesProbeResult> {
  let response: Response;
  let body: string;
  try {
    response = await fetchWithTimeout(url, 'GET');
    if (response.status >= 400) {
      await safeCancel(response.body);
      return {
        verdict: 'contradicted' as SourcingVerdict,
        confidence: CONFIDENCE_DEFINITE,
        reasoning: `[url-resolves wikipedia] HTTP ${response.status} — link rot`,
        finalUrl: response.url,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      await safeCancel(response.body);
      return {
        verdict: 'unverifiable' as SourcingVerdict,
        confidence: 0.6,
        reasoning: `[url-resolves wikipedia] unexpected HTTP ${response.status}`,
        finalUrl: response.url,
      };
    }
    body = await readCappedText(response, WIKIPEDIA_BODY_CAP_BYTES);
  } catch (e: unknown) {
    return {
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: CONFIDENCE_MEDIUM,
      reasoning: `[url-resolves wikipedia] network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const finalHostError = rejectIfInternalHost(response.url);
  if (finalHostError) {
    return {
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: 1.0,
      reasoning: `[url-resolves wikipedia] redirected to internal host: ${finalHostError}`,
      finalUrl: response.url,
    };
  }

  const title = extractWikipediaTitle(body);
  if (!title) {
    // Page resolved but no title parsed — treat as confirmed (URL is alive)
    // but at lower confidence. We don't downgrade to unverifiable because
    // 200-OK Wikipedia pages without a parsable title are extremely rare.
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: CONFIDENCE_MEDIUM,
      reasoning: `[url-resolves wikipedia] HTTP ${response.status}, title not parseable`,
      finalUrl: response.url,
    };
  }

  // Word-boundary check (not raw substring) — prevents an entity named "Foo"
  // from matching "Foobar - Wikipedia" or an org "AI" matching "AIDS".
  if (titleContainsEntityName(title, entityName)) {
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: CONFIDENCE_DEFINITE,
      reasoning: `[url-resolves wikipedia] title "${title}" contains "${entityName}"`,
      finalUrl: response.url,
      pageTitle: title,
    };
  }

  // URL resolved but the destination article is not about the entity.
  // Could be disambiguation, redirect to broader concept, or wrong link.
  return {
    verdict: 'contradicted' as SourcingVerdict,
    confidence: CONFIDENCE_HIGH,
    reasoning: `[url-resolves wikipedia] title "${title}" does not contain entity name "${entityName}"`,
    finalUrl: response.url,
    pageTitle: title,
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────

/**
 * Wrap fetch with a 10s timeout, a friendly UA, and redirect: 'follow'.
 * Returns the final Response; the caller checks .status and .url.
 */
async function fetchWithTimeout(url: string, method: 'HEAD' | 'GET'): Promise<Response> {
  return fetch(url, {
    method,
    redirect: 'follow',
    headers: { 'User-Agent': URL_RESOLVES_USER_AGENT },
    signal: AbortSignal.timeout(URL_RESOLVES_TIMEOUT_MS),
  });
}

/** Cancel a response body's reader if present; swallow errors. */
async function safeCancel(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // best-effort
  }
}

/**
 * Read at most `cap` bytes of the response body as text. Slices the trailing
 * chunk if it would push us past `cap` so we don't buffer a multi-MB body
 * just because the network sent one big chunk.
 */
async function readCappedText(response: Response, cap: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = cap - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = cap;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort; the reader may already be released.
    }
  }
  // Concatenate chunks then UTF-8 decode. TextDecoder's default replaces
  // truncated multi-byte sequences with U+FFFD, which is fine — Wikipedia
  // titles sit in the first few KB so the cap-boundary case is rare.
  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * Extract the inner text of the first `<title>...</title>` element.
 * Returns the text without the trailing " - Wikipedia" suffix when present.
 */
export function extractWikipediaTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!match) return null;
  const title = decodeHtmlEntities(match[1].trim());
  return title.replace(/\s*[-–]\s*Wikipedia\s*$/, '').trim() || null;
}

/**
 * Decode the HTML entities Wikipedia article titles realistically produce:
 * - Named entities: &amp; &lt; &gt; &quot; &#39; &nbsp; &apos; &copy; &mdash; &ndash; &hellip; &trade;
 * - Numeric entities: decimal (&#233;) and hex (&#xE9;) — used for non-ASCII chars
 *   in titles like "Citroën", "São Paulo", "Encyclopædia Britannica"
 *
 * `&amp;` is processed last so an input like "&amp;lt;" decodes to "&lt;",
 * not "<". Numeric/hex entities are processed first so they don't interact
 * with named-entity replacement.
 */
export function decodeHtmlEntities(s: string): string {
  // Numeric entities first
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)));
  out = out.replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)));
  // Common named entities (deliberately small — the realistic set Wikipedia uses).
  // Order: replace &amp; LAST so an encoded "&amp;lt;" becomes "&lt;" not "<".
  const named: Array<[RegExp, string]> = [
    [/&apos;/g, "'"],
    [/&lt;/g, '<'],
    [/&gt;/g, '>'],
    [/&quot;/g, '"'],
    [/&#39;/g, "'"],
    [/&nbsp;/g, ' '],
    [/&copy;/g, '©'],
    [/&trade;/g, '™'],
    [/&mdash;/g, '—'],
    [/&ndash;/g, '–'],
    [/&hellip;/g, '…'],
    [/&amp;/g, '&'],
  ];
  for (const [pattern, replacement] of named) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

// ── Validation helpers ─────────────────────────────────────────────

/**
 * Word-boundary–aware containment: returns true when `entityName` appears in
 * `title` as a whole word (or a sequence of whole words), case-insensitive.
 * Falls back to a permissive normalization (alphanumerics + spaces only) so
 * minor punctuation differences ("U.S." vs "U S") don't block a match.
 */
export function titleContainsEntityName(title: string, entityName: string): boolean {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      // Keep letters/numbers as words; collapse all other runs to a single space.
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const t = normalize(title);
  const n = normalize(entityName);
  if (!t || !n) return false;
  // Word-boundary match: the entity-name token sequence must appear at a word
  // boundary in the normalized title. Padding with spaces gives us cheap
  // \b-equivalent semantics on the normalized form.
  return ` ${t} `.includes(` ${n} `);
}

/**
 * Hostname-based SSRF guard. Returns an error string if the URL targets a
 * private/loopback/internal address; null if the host is acceptable.
 *
 * Not bulletproof against DNS rebinding (would need to resolve the host and
 * re-validate the IP), but blocks the obvious local-network probing case.
 */
export function rejectIfInternalHost(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return `unparseable URL: ${truncate(rawUrl, 80)}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `unsupported protocol: ${u.protocol}`;
  }
  const host = u.hostname.toLowerCase();
  if (!host) return 'missing hostname';

  // Block obvious local DNS suffixes
  if (host === 'localhost' || host.endsWith('.localhost')) return `local-only hostname: ${host}`;
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan'))
    return `internal-only hostname: ${host}`;

  // IPv4 literal checks
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b, c, d] = ipv4.map(Number) as [number, number, number, number, number];
    if (a > 255 || b > 255 || c > 255 || d > 255) return `invalid IPv4: ${host}`;
    if (a === 10) return `private IPv4 (10/8): ${host}`;
    if (a === 127) return `loopback IPv4: ${host}`;
    if (a === 0) return `null route IPv4: ${host}`;
    if (a === 169 && b === 254) return `link-local IPv4: ${host}`;
    if (a === 172 && b >= 16 && b <= 31) return `private IPv4 (172.16/12): ${host}`;
    if (a === 192 && b === 168) return `private IPv4 (192.168/16): ${host}`;
    if (a === 100 && b >= 64 && b <= 127) return `CGNAT IPv4: ${host}`;
  }

  // IPv6 literal checks (URL.hostname strips brackets but not always — handle both)
  const v6 = host.replace(/^\[|\]$/g, '');
  if (v6.includes(':')) {
    if (v6 === '::1') return `loopback IPv6: ${host}`;
    if (v6 === '::' || v6 === '0:0:0:0:0:0:0:0') return `null IPv6: ${host}`;
    if (/^fe[89ab][0-9a-f]:/i.test(v6)) return `link-local IPv6: ${host}`;
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return `unique-local IPv6: ${host}`;
    // IPv4-mapped IPv6 — Node canonicalizes "::ffff:127.0.0.1" to "::ffff:7f00:1",
    // so handle both forms.
    if (/^::ffff:/i.test(v6)) {
      const tail = v6.slice('::ffff:'.length);
      // Dotted form (rare after canonicalization but possible from user input)
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) {
        const inner = rejectIfInternalHost(`http://${tail}/`);
        if (inner) return `IPv4-mapped IPv6 to ${inner}`;
      } else {
        // Hex-pair form: high:low (each up to 4 hex chars).
        const parts = tail.split(':');
        if (parts.length === 2) {
          const high = parseInt(parts[0], 16);
          const low = parseInt(parts[1], 16);
          if (Number.isFinite(high) && Number.isFinite(low)) {
            const a = (high >> 8) & 0xff;
            const b = high & 0xff;
            const c = (low >> 8) & 0xff;
            const d = low & 0xff;
            const dotted = `${a}.${b}.${c}.${d}`;
            const inner = rejectIfInternalHost(`http://${dotted}/`);
            if (inner) return `IPv4-mapped IPv6 to ${inner}`;
          }
        }
      }
    }
  }

  return null;
}

/**
 * URL acceptability check at the value-string level. Rejects:
 * - non-http(s) protocols
 * - URLs with embedded credentials (`user:pass@host`) — we never want to
 *   send those in a HEAD/GET probe.
 *
 * SSRF host-class rejection is handled separately by `rejectIfInternalHost`.
 */
function looksLikeUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return true;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
