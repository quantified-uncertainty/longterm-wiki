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
 * - 2xx (or same-host 3xx → 2xx) → `confirmed`
 * - 4xx/5xx → `contradicted` (link rot)
 * - Network error / timeout → `unverifiable`
 *
 * Wikipedia-specific: also fetches the page and checks the `<title>` contains
 * the entity name. A Wikipedia URL that resolves but points at a different
 * article (e.g., a redirect from `/wiki/Anthropic_(company)` to a generic
 * disambiguation page) is `contradicted`, not `confirmed`.
 */

import type { SourcingVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import type { VerifyItem, VerifyResult, FactItemData } from './orchestrator-types.ts';

const URL_RESOLVES_TIMEOUT_MS = 10_000;
const URL_RESOLVES_USER_AGENT =
  'longterm-wiki url-resolves-verifier (https://www.longtermwiki.com)';

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
  // For wikipedia-url / github-profile / etc., the value IS the URL.
  const urlToCheck = data.rawValue ?? data.formattedValue;
  if (!urlToCheck || !looksLikeUrl(urlToCheck)) {
    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: 1.0,
      extractedValue: '',
      reasoning: `[url-resolves] fact value is not a URL: ${truncate(urlToCheck ?? '<empty>', 80)}`,
      sourceUrl: item.sourceUrl ?? '',
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
 * servers, notably GitHub raw and a few CDNs, return 405/501 for HEAD).
 *
 * Returns the verdict mapping described in this file's docstring.
 */
export async function probeUrlResolves(url: string): Promise<UrlResolvesProbeResult> {
  let response: Response;
  try {
    response = await fetchWithRedirectAwareness(url, 'HEAD');
    if (response.status === 405 || response.status === 501) {
      // HEAD not allowed — retry with GET (we ignore the body).
      response = await fetchWithRedirectAwareness(url, 'GET');
    }
  } catch (e: unknown) {
    return {
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: 0.7,
      reasoning: `[url-resolves] network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (response.status >= 200 && response.status < 300) {
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: 0.95,
      reasoning: `[url-resolves] HTTP ${response.status}${response.url !== url ? ` (redirected to ${response.url})` : ''}`,
      finalUrl: response.url,
    };
  }

  if (response.status >= 400) {
    return {
      verdict: 'contradicted' as SourcingVerdict,
      confidence: 0.95,
      reasoning: `[url-resolves] HTTP ${response.status} — link rot or removed`,
      finalUrl: response.url,
    };
  }

  // 3xx that wasn't followed (e.g., redirect: 'manual' would land here, but we
  // use redirect: 'follow' below so this is unusual). Treat as unverifiable.
  return {
    verdict: 'unverifiable' as SourcingVerdict,
    confidence: 0.6,
    reasoning: `[url-resolves] unexpected HTTP ${response.status}`,
    finalUrl: response.url,
  };
}

/**
 * Wikipedia-specific probe: fetch the page (GET, not HEAD — we need the title)
 * and check that the article title contains the entity name. Catches the case
 * where a wikipedia-url resolves but points at the wrong article (e.g., a
 * disambiguation page).
 */
export async function probeWikipediaUrl(
  url: string,
  entityName: string,
): Promise<UrlResolvesProbeResult> {
  let response: Response;
  let body: string;
  try {
    response = await fetchWithRedirectAwareness(url, 'GET');
    if (response.status >= 400) {
      return {
        verdict: 'contradicted' as SourcingVerdict,
        confidence: 0.95,
        reasoning: `[url-resolves wikipedia] HTTP ${response.status} — link rot`,
        finalUrl: response.url,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        verdict: 'unverifiable' as SourcingVerdict,
        confidence: 0.6,
        reasoning: `[url-resolves wikipedia] unexpected HTTP ${response.status}`,
        finalUrl: response.url,
      };
    }
    // Cap body read to avoid pulling MB of HTML for the title alone.
    body = await readCappedText(response, 64 * 1024);
  } catch (e: unknown) {
    return {
      verdict: 'unverifiable' as SourcingVerdict,
      confidence: 0.7,
      reasoning: `[url-resolves wikipedia] network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const title = extractWikipediaTitle(body);
  if (!title) {
    // Page resolved but no title parsed — treat as confirmed (URL is alive)
    // but at lower confidence. We don't downgrade to unverifiable because
    // 200-OK Wikipedia pages without a parsable title are extremely rare.
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: 0.7,
      reasoning: `[url-resolves wikipedia] HTTP ${response.status}, title not parseable`,
      finalUrl: response.url,
    };
  }

  // Title check: case-insensitive substring match. Wikipedia titles are like
  // "Anthropic - Wikipedia" or "Geoffrey Hinton - Wikipedia". The entity name
  // must appear somewhere in the title text.
  const titleNorm = title.toLowerCase();
  const nameNorm = entityName.toLowerCase();
  if (titleNorm.includes(nameNorm)) {
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: 0.95,
      reasoning: `[url-resolves wikipedia] title "${title}" contains "${entityName}"`,
      finalUrl: response.url,
      pageTitle: title,
    };
  }

  // URL resolved but the destination article is not about the entity.
  // Could be disambiguation, redirect to broader concept, or wrong link.
  return {
    verdict: 'contradicted' as SourcingVerdict,
    confidence: 0.85,
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
async function fetchWithRedirectAwareness(url: string, method: 'HEAD' | 'GET'): Promise<Response> {
  return fetch(url, {
    method,
    redirect: 'follow',
    headers: { 'User-Agent': URL_RESOLVES_USER_AGENT },
    signal: AbortSignal.timeout(URL_RESOLVES_TIMEOUT_MS),
  });
}

/** Read at most `cap` bytes of the response body as text. */
async function readCappedText(response: Response, cap: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= cap) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort; the reader may already be released.
    }
  }
  // Concatenate chunks then decode as UTF-8. Avoids the Blob<->TS-lib type
  // friction with newer @types/node where Uint8Array carries an ArrayBuffer
  // template parameter that BlobPart doesn't accept.
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

/** Tiny HTML entity decoder (just the handful Wikipedia titles use). */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ── Validation helpers ─────────────────────────────────────────────

function looksLikeUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// Re-export for tests + dispatchers
export type { FactItemData };
