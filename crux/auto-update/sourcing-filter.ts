/**
 * Source-Check Pre-Flight Filter
 *
 * Checks candidate pages against sourcing verdicts from the wiki-server.
 * Pages whose entities have "contradicted" verdicts are skipped to avoid
 * auto-updating content that is known to have factual issues.
 *
 * Design: best-effort. If the wiki-server is unavailable or entities can't
 * be resolved, the filter passes all pages through (no filtering).
 */

import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getContradictedEntityIds } from '../lib/wiki-server/sourcing.ts';
import { loadEntityRegistry } from '../validate/validate-kb-entity-slugs.ts';
import type { PageUpdate } from './types.ts';

// ── Entity slug → stableId mapping ─────────────────────────────────────────

export interface EntityMapping {
  /** slug → stableId (e.g., "anthropic" → "mK9pX3rQ7n") */
  slugToStableId: Map<string, string>;
  /** stableId → slug (reverse lookup) */
  stableIdToSlug: Map<string, string>;
}

/**
 * Load entity ID mappings directly from YAML files in data/entities/.
 * Delegates to the shared loadEntityRegistry() utility.
 */
export function loadEntityMappings(): EntityMapping {
  const entitiesDir = join(PROJECT_ROOT, 'data', 'entities');
  const registry = loadEntityRegistry(entitiesDir);
  return {
    slugToStableId: registry.slugToStableId,
    stableIdToSlug: registry.stableIdToSlug,
  };
}

// ── Filter result ──────────────────────────────────────────────────────────

export interface SourcingFilterResult {
  /** Pages that passed the filter (no contradicted verdicts) */
  passed: PageUpdate[];
  /** Pages that were skipped due to contradicted verdicts */
  skipped: Array<{
    pageUpdate: PageUpdate;
    reason: string;
  }>;
}

// ── Injectable dependencies for testability ────────────────────────────────

export interface SourcingFilterDeps {
  /** Fetch contradicted entity stableIds from wiki-server */
  getContradictedEntityIds: () => Promise<Set<string>>;
  /** Load slug ↔ stableId mappings from YAML */
  loadEntityMappings: () => EntityMapping;
}

const defaultDeps: SourcingFilterDeps = {
  getContradictedEntityIds,
  loadEntityMappings,
};

// ── Main filter function ───────────────────────────────────────────────────

/**
 * Filter page updates by checking for contradicted sourcing verdicts.
 *
 * Pages whose entities have at least one "contradicted" verdict are removed
 * from the update plan. This is a safety measure: if an entity's facts have
 * been found to contradict their sources, auto-updating the page could
 * compound the factual errors.
 *
 * Best-effort: returns all pages unfiltered if:
 * - Wiki-server is unavailable
 * - Entity mapping can't be loaded
 * - Any unexpected error occurs
 *
 * @param pageUpdates - Candidate page updates from the routing stage
 * @param verbose - Log detailed information
 * @param deps - Injectable dependencies (for testing)
 * @returns Filtered result with passed and skipped pages
 */
export async function filterBySourcingVerdicts(
  pageUpdates: PageUpdate[],
  verbose = false,
  deps: SourcingFilterDeps = defaultDeps,
): Promise<SourcingFilterResult> {
  if (pageUpdates.length === 0) {
    return { passed: [], skipped: [] };
  }

  try {
    // Step 1: Fetch contradicted entity IDs from wiki-server
    const contradictedStableIds = await deps.getContradictedEntityIds();

    if (contradictedStableIds.size === 0) {
      if (verbose) {
        console.log('  Source-check filter: no contradicted verdicts found, all pages pass');
      }
      return { passed: [...pageUpdates], skipped: [] };
    }

    if (verbose) {
      console.log(`  Source-check filter: ${contradictedStableIds.size} entities with contradicted verdicts`);
    }

    // Step 2: Load slug → stableId mapping
    const { slugToStableId } = deps.loadEntityMappings();

    if (slugToStableId.size === 0) {
      console.warn('[auto-update] Source-check filter: could not load entity mappings, skipping filter');
      return { passed: [...pageUpdates], skipped: [] };
    }

    // Step 3: Check each candidate page
    const passed: PageUpdate[] = [];
    const skipped: SourcingFilterResult['skipped'] = [];

    for (const update of pageUpdates) {
      const stableId = slugToStableId.get(update.pageId);

      if (stableId && contradictedStableIds.has(stableId)) {
        skipped.push({ pageUpdate: update, reason: 'Entity has contradicted sourcing verdicts' });
        console.log(
          `[auto-update] Skipping page "${update.pageTitle}" (${update.pageId}): entity has contradicted sourcing verdicts`,
        );
      } else {
        passed.push(update);
      }
    }

    if (verbose && skipped.length > 0) {
      console.log(`  Source-check filter: ${skipped.length} page(s) skipped, ${passed.length} page(s) passed`);
    }

    return { passed, skipped };
  } catch (err) {
    // Best-effort: on any error, pass all pages through
    console.warn(
      `[auto-update] Source-check filter failed (proceeding without filter): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { passed: [...pageUpdates], skipped: [] };
  }
}
