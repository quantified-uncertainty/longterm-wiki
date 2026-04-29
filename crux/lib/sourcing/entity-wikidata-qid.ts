/**
 * Entity → Wikidata QID lookup for the subject-identity gate (QUA-724).
 *
 * Wikidata QIDs for wiki entities are stored in `data/external-links.yaml`,
 * keyed by `pageId` (the entity slug, e.g. `anthropic`). This module loads
 * that file once per process and exposes a fast `getEntityWikidataQid(slug)`
 * lookup that the suggest-urls CLI uses to wire the parent entity's QID into
 * `suggestUrls()`.
 *
 * Returns `null` when:
 *   - The slug isn't in the file (most entities don't have a Wikidata link).
 *   - The file is missing or malformed (treated as "no QIDs known" so the
 *     gate is fail-open per QUA-724's contract).
 *   - The wikidata link exists but doesn't reference a Q-number (e.g.
 *     `Property:P856` or a malformed URL).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DATA_DIR_ABS } from '../content-types.ts';
import { extractQid } from './wikidata-matcher.ts';

const EXTERNAL_LINKS_PATH = join(DATA_DIR_ABS, 'external-links.yaml');

interface ExternalLinksEntry {
  pageId: string;
  links?: { wikidata?: string };
}

let cachedQidBySlug: Map<string, string> | null = null;

/**
 * Reset the in-memory cache. Tests use this between cases that mutate the
 * underlying file or want to assert on cold-load behaviour.
 */
export function clearEntityWikidataQidCache(): void {
  cachedQidBySlug = null;
}

function loadCache(): Map<string, string> {
  if (cachedQidBySlug) return cachedQidBySlug;
  const out = new Map<string, string>();
  try {
    const raw = readFileSync(EXTERNAL_LINKS_PATH, 'utf-8');
    const entries = parseYaml(raw) as ExternalLinksEntry[] | null;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const wikidataUrl = entry?.links?.wikidata;
        if (!entry?.pageId || !wikidataUrl) continue;
        const qid = extractQid(wikidataUrl);
        if (qid) out.set(entry.pageId, qid);
      }
    }
  } catch (e: unknown) {
    // Fail-open per QUA-724: any read/parse failure (missing file, EPERM,
    // YAML syntax error, ...) means the gate stays disabled rather than
    // tripping every caller. We log at warn so file-shape regressions are
    // still visible; per `.claude/rules/error-handling.md` no catch is
    // silent.
    if (process.env.NODE_ENV !== 'test') {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[entity-wikidata-qid] Failed to load ${EXTERNAL_LINKS_PATH}: ${msg}. ` +
          `Subject-identity gate (QUA-724) is fail-open for this run.`,
      );
    }
  }
  cachedQidBySlug = out;
  return out;
}

/**
 * Look up an entity's Wikidata QID by its `pageId` slug
 * (e.g. `anthropic`, `geoffrey-hinton`). Returns null when the entity has
 * no Wikidata link recorded.
 *
 * The lookup is case-sensitive — slugs in `external-links.yaml` are kebab
 * lower-case so callers should pass them as-is from `entities.id`.
 */
export function getEntityWikidataQid(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return loadCache().get(slug) ?? null;
}
