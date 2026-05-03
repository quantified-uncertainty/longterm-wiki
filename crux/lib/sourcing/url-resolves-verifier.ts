/**
 * URL-resolves verifier (QUA-927).
 *
 * Cheap, fast verification path for facts whose source-of-truth IS the URL
 * itself (wikipedia-url, github-profile, google-scholar, social-media handles,
 * …). Content-claim verification is tautological for these — there's no
 * separate claim to compare against the source content. But the URL is still
 * checkable: does it resolve? For Wikipedia, does the destination match the
 * entity?
 *
 * **The verifier rides the Resource pipeline; it does not fetch URLs.**
 *
 * Decision tree:
 *   1. Look up cached state via `lookupResourceByUrl` + `getCitationContentByUrl`.
 *   2. If `citation_content.httpStatus` is 2xx:
 *        - For wikipedia-url: also check `pageTitle` contains entity name.
 *        - Else: `confirmed`.
 *   3. If `citation_content.httpStatus` is 4xx/5xx, OR
 *      `resources.fetchStatus` is a dead variant: `contradicted` (link rot).
 *   4. Otherwise (URL never fetched): enqueue ingest via `suggestResourcesApi`
 *      and return `unverifiable` — the next sourcing run will see real state.
 *
 * Why not a direct HEAD probe? An earlier draft of this verifier issued its
 * own HEAD/GET against the live URL. That bypassed the rest of the source-
 * checking pipeline:
 *   - No `content_hash` change detection (QUA-312/329) — a Wikipedia page
 *     rewritten to a different topic would still verdict `confirmed` on
 *     stale data until something else triggered a re-fetch.
 *   - No `resources` row, so no `archive_url`, no audit trail in operational
 *     dashboards, no Wayback fallback for dead links.
 *   - Parallel HTTP code path (SSRF defenses, timeout handling, redirect
 *     tracking, HTML title parsing) duplicating logic the resource-ingest
 *     worker already runs.
 * Going through the Resource pipeline keeps sourcing on one rail.
 *
 * Cost: $0. Latency: one wiki-server lookup (~10–50ms) — no LLM.
 *
 * Self-healing: a brand-new URL returns `unverifiable` on its first pass and
 * enqueues a resource-ingest job. The next pass (after the worker runs) gets
 * a real verdict from the cached state. This matches the existing
 * `source-fetcher.ts` "not_cached → enqueue → re-run" flow.
 */

import { isDeadFetchStatus } from '../../../apps/wiki-server/src/api-types.ts';
import type { SourcingVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import { getCitationContentByUrl } from '../wiki-server/citations.ts';
import { lookupResourceByUrl, suggestResourcesApi } from '../wiki-server/resources.ts';
import type { VerifyItem, VerifyResult } from './orchestrator-types.ts';
import { truncate } from '../text-utils.ts';

const CONFIDENCE_DEFINITE = 0.95;
const CONFIDENCE_HIGH = 0.85;
const CONFIDENCE_MEDIUM = 0.7;

interface ResolveResult {
  verdict: SourcingVerdict;
  confidence: number;
  reasoning: string;
  /** Final URL after resource-ingest processed redirects, when known. */
  finalUrl?: string;
  /** Cached `<title>` from citation_content (Wikipedia path). */
  pageTitle?: string;
}

/**
 * Public entry point. Returns a VerifyResult to be stored, or null if the
 * item is not eligible for url-resolves verification (caller should fall
 * through to content-claim).
 */
export async function tryUrlResolvesVerify(item: VerifyItem): Promise<VerifyResult | null> {
  if (item.data.kind !== 'fact') return null;
  const data = item.data;
  if (data.verifierKind !== 'url-resolves') return null;

  // Prefer rawValue; fall back to formattedValue for legacy/external producers
  // that didn't populate rawValue. For URL-typed properties they are the same
  // string — the display-formatting concern only applies to numeric fields.
  const urlToCheck = data.rawValue ?? data.formattedValue;
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

  const isWikipedia = data.propertyId === 'wikipedia-url';
  const result = await resolveFromResourcePipeline(urlToCheck, isWikipedia, data.entity.name);

  return {
    itemId: item.id,
    kind: item.kind,
    description: item.description,
    verdict: result.verdict,
    confidence: result.confidence,
    extractedValue: result.pageTitle ?? result.finalUrl ?? '',
    reasoning: result.reasoning,
    sourceUrl: item.sourceUrl ?? urlToCheck,
    checkerModel: 'url-resolves',
  };
}

/**
 * Read cached resource + citation_content state and derive a verdict.
 *
 * `lookupResourceByUrl` and `getCitationContentByUrl` are independent reads:
 * citation_content is keyed by URL (no resource_id needed) and is populated
 * by the resource-ingest worker after each successful fetch. We consult both
 * because a resource may exist (with fetchStatus) before its content has been
 * cached — e.g., dead-link statuses are written to `resources` even when no
 * content body is stored.
 */
export async function resolveFromResourcePipeline(
  url: string,
  isWikipedia: boolean,
  entityName: string,
): Promise<ResolveResult> {
  const [resourceLookup, contentLookup] = await Promise.all([
    lookupResourceByUrl(url),
    getCitationContentByUrl(url),
  ]);

  // ── Citation content present (the happy path) ────────────────────
  if (contentLookup.ok && contentLookup.data) {
    const cached = contentLookup.data;
    const httpStatus = cached.httpStatus;

    if (httpStatus != null && httpStatus >= 200 && httpStatus < 300) {
      if (isWikipedia) return verdictFromWikipediaCachedContent(cached, entityName);
      return {
        verdict: 'confirmed' as SourcingVerdict,
        confidence: CONFIDENCE_DEFINITE,
        reasoning: `[url-resolves] resource-ingest fetched HTTP ${httpStatus} (cached at ${cached.fetchedAt})`,
        finalUrl: url,
      };
    }

    if (httpStatus != null && httpStatus >= 400) {
      // Distinguish "URL alive, body blocked" from "URL gone". 401/403/451 mean
      // the resource exists but the server refuses to serve the body to us
      // (auth required, anti-bot block, legal removal). For url-resolves
      // properties the truth being verified is "this URL is the canonical
      // pointer for the entity" — body access is not required. Match the
      // paywall branch below: confirmed at HIGH confidence.
      // 429 + 5xx are transient (rate limit / server error) — unverifiable so
      // we re-check next pass instead of flipping a previously-confirmed URL
      // to contradicted on a hiccup.
      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 451) {
        return {
          verdict: 'confirmed' as SourcingVerdict,
          confidence: CONFIDENCE_HIGH,
          reasoning: `[url-resolves] resource-ingest recorded HTTP ${httpStatus} (URL alive, body blocked)`,
          finalUrl: url,
        };
      }
      if (httpStatus === 429 || httpStatus >= 500) {
        return {
          verdict: 'unverifiable' as SourcingVerdict,
          confidence: CONFIDENCE_MEDIUM,
          reasoning: `[url-resolves] resource-ingest recorded HTTP ${httpStatus} — transient, re-check on next pass`,
          finalUrl: url,
        };
      }
      return {
        verdict: 'contradicted' as SourcingVerdict,
        confidence: CONFIDENCE_DEFINITE,
        reasoning: `[url-resolves] resource-ingest recorded HTTP ${httpStatus} — link rot or removed`,
        finalUrl: url,
      };
    }
    // Cached but no httpStatus (very rare — pre-QUA-329 row, or fetchMethod that
    // didn't record one). Fall through to fetchStatus / re-enqueue.
  }

  // ── Resource row exists with a dead fetchStatus ──────────────────
  if (resourceLookup.ok && resourceLookup.data) {
    const fetchStatus = resourceLookup.data.fetchStatus;
    if (isDeadFetchStatus(fetchStatus)) {
      return {
        verdict: 'contradicted' as SourcingVerdict,
        confidence: CONFIDENCE_DEFINITE,
        reasoning: `[url-resolves] resource fetch_status: ${fetchStatus}`,
        finalUrl: url,
      };
    }
    if (fetchStatus === 'paywall') {
      // Paywalled URLs resolve as far as we can tell — the URL is alive,
      // we just can't read the body. Treat as confirmed for url-resolves
      // semantics (the property is "this URL exists", not "we read it").
      return {
        verdict: 'confirmed' as SourcingVerdict,
        confidence: CONFIDENCE_HIGH,
        reasoning: '[url-resolves] resource fetch_status: paywall (URL alive, body gated)',
        finalUrl: url,
      };
    }
    if (fetchStatus === 'ok') {
      // Resource says ok but no citation_content yet (rare ordering window
      // between resource update and citation upsert). Treat as confirmed.
      return {
        verdict: 'confirmed' as SourcingVerdict,
        confidence: CONFIDENCE_HIGH,
        reasoning: '[url-resolves] resource fetch_status: ok (citation content pending)',
        finalUrl: url,
      };
    }
  }

  // ── No info yet: enqueue ingest, return unverifiable for this run ─
  let enqueued = false;
  let enqueueError: string | null = null;
  try {
    const result = await suggestResourcesApi({ urls: [url] });
    if (!result.ok) {
      enqueueError = result.message ?? 'suggestResourcesApi returned ok=false';
    } else {
      enqueued = true;
    }
  } catch (e: unknown) {
    enqueueError = e instanceof Error ? e.message : String(e);
  }

  return {
    verdict: 'unverifiable' as SourcingVerdict,
    confidence: CONFIDENCE_MEDIUM,
    reasoning: enqueued
      ? '[url-resolves] no cached state — resource-ingest job enqueued; re-run after ingest completes'
      : `[url-resolves] no cached state — failed to enqueue ingest: ${enqueueError ?? 'unknown error'}`,
    finalUrl: url,
  };
}

/**
 * Wikipedia cached-content branch: the citation_content row already has
 * `pageTitle` extracted by the resource-ingest worker. Use that directly
 * (no HTML re-parsing) and check whole-word containment of the entity name.
 */
function verdictFromWikipediaCachedContent(
  cached: { httpStatus: number | null; pageTitle: string | null; fetchedAt: string },
  entityName: string,
): ResolveResult {
  // Strip trailing " - Wikipedia" / " – Wikipedia" / " — Wikipedia" suffix.
  // Wikipedia uses hyphen-minus, en-dash, or em-dash depending on locale/render.
  const title = (cached.pageTitle ?? '').replace(/\s*[-‐-―]\s*Wikipedia\s*$/i, '').trim();
  if (!title) {
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: CONFIDENCE_MEDIUM,
      reasoning: `[url-resolves wikipedia] HTTP ${cached.httpStatus} but no cached pageTitle to verify`,
      pageTitle: cached.pageTitle ?? undefined,
    };
  }
  if (titleContainsEntityName(title, entityName)) {
    return {
      verdict: 'confirmed' as SourcingVerdict,
      confidence: CONFIDENCE_DEFINITE,
      reasoning: `[url-resolves wikipedia] cached title "${title}" contains "${entityName}"`,
      pageTitle: title,
    };
  }
  return {
    verdict: 'contradicted' as SourcingVerdict,
    confidence: CONFIDENCE_HIGH,
    reasoning: `[url-resolves wikipedia] cached title "${title}" does not contain entity name "${entityName}"`,
    pageTitle: title,
  };
}

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
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const t = normalize(title);
  const n = normalize(entityName);
  if (!t || !n) return false;
  return ` ${t} `.includes(` ${n} `);
}

/**
 * URL acceptability check at the value-string level. Rejects:
 * - non-http(s) protocols
 * - URLs with embedded credentials (`user:pass@host`)
 *
 * Pre-validation only — actual SSRF defense lives in resource-ingest, where
 * the URL is fetched. This check just keeps obvious garbage out of the
 * resource-ingest queue.
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

