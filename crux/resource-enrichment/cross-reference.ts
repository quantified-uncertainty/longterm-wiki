/**
 * Resource Enrichment — Cross-Referencing (Phase 5)
 *
 * Matches resources to entities:
 * - Authors → person entities (fuzzy name matching → authorEntityIds)
 * - Domains → org entities (→ publisher_entity_id)
 * - Policy docs → policy entities (→ resource_policy_docs.policy_entity_id)
 * - Detects duplicate resources (same paper at arXiv + publisher URL)
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';

interface EntityEntry {
  stableId: string;
  title: string;
  type: string;
  aliases?: string[];
}

// ── Entity loading ──────────────────────────────────────────────────────────

async function loadEntities(): Promise<EntityEntry[]> {
  const result = await apiRequest<{ entities: EntityEntry[] }>(
    'GET',
    '/api/entities/all?limit=5000',
  );
  if (!result.ok) {
    console.warn(`  Failed to load entities: ${result.message}`);
    return [];
  }
  return result.data.entities;
}

// ── Domain → org entity matching ────────────────────────────────────────────

function buildDomainToOrgMap(entities: EntityEntry[]): Map<string, string> {
  const map = new Map<string, string>();

  // Known domain → org mappings for common publishers
  const knownMappings: Record<string, string> = {
    'anthropic.com': 'anthropic',
    'openai.com': 'openai',
    'deepmind.google': 'google-deepmind',
    'deepmind.com': 'google-deepmind',
    'ai.meta.com': 'meta',
    'microsoft.com': 'microsoft',
    'research.google': 'google',
    'blog.google': 'google',
    'nist.gov': 'nist',
    'whitehouse.gov': 'us-government',
    'congress.gov': 'us-government',
    'miri.org': 'machine-intelligence-research-institute',
    'intelligence.org': 'machine-intelligence-research-institute',
    'redwoodresearch.org': 'redwood-research',
    'alignmentforum.org': 'alignment-forum',
    'aisafety.com': 'center-for-ai-safety',
    'safe.ai': 'center-for-ai-safety',
    'aisi.gov.uk': 'uk-aisi',
  };

  for (const [domain, entityId] of Object.entries(knownMappings)) {
    map.set(domain, entityId);
  }

  // Note: Auto-generating domain mappings from entity slugs is intentionally
  // not done here. The entity API returns stableIds (10-char hashes) not
  // human-readable slugs, and even slug-based matching would produce false
  // positives for short slugs (arc.com, meta.org, etc.). Extend the
  // knownMappings object above for new publisher domains instead.

  return map;
}

// ── Main command ────────────────────────────────────────────────────────────

export async function crossReferenceCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = options['dry-run'] as boolean;
  const verbose = options.verbose as boolean;
  const limit = (options.limit as number) || 5000;

  console.log('🔗 Resource Cross-Referencing\n');
  if (dryRun) console.log('  DRY RUN — no changes will be written\n');

  const [resources, entities] = await Promise.all([
    loadResourcesPGFirst(),
    loadEntities(),
  ]);

  console.log(`  ${resources.length} resources, ${entities.length} entities\n`);

  const domainToOrg = buildDomainToOrgMap(entities);
  const toProcess = resources.slice(0, limit);

  // Track updates
  const publisherUpdates: Array<{ id: string; url: string; publisherEntityId: string }> = [];
  let publisherMatched = 0;
  let duplicatesFound = 0;

  // ── Domain → publisher_entity_id matching ────────────────────────────

  for (const r of toProcess) {
    if (r.publisher_entity_id) continue; // Already matched

    try {
      const domain = new URL(r.url).hostname.replace('www.', '');

      // Try exact domain match
      let orgId = domainToOrg.get(domain);

      // Try parent domain (e.g., blog.anthropic.com → anthropic.com)
      if (!orgId) {
        const parts = domain.split('.');
        if (parts.length > 2) {
          const parentDomain = parts.slice(-2).join('.');
          orgId = domainToOrg.get(parentDomain);
        }
      }

      if (orgId) {
        publisherUpdates.push({
          id: r.id,
          url: r.url,
          publisherEntityId: orgId,
        });
        publisherMatched++;
        if (verbose) console.log(`  ✓ ${r.title || r.url} → ${orgId}`);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  console.log(`  Publisher matches: ${publisherMatched}`);

  // ── Duplicate detection ──────────────────────────────────────────────

  // Group resources by normalized title for duplicate detection
  const titleMap = new Map<string, Resource[]>();
  for (const r of toProcess) {
    if (!r.title) continue;
    const key = r.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (key.length < 10) continue; // Skip very short titles
    const group = titleMap.get(key) || [];
    group.push(r);
    titleMap.set(key, group);
  }

  for (const [, group] of titleMap) {
    if (group.length > 1) {
      duplicatesFound++;
      if (verbose) {
        console.log(`  ⚠ Possible duplicate: "${group[0].title}"`);
        for (const r of group) {
          console.log(`    - ${r.id}: ${r.url}`);
        }
      }
    }
  }

  console.log(`  Potential duplicates: ${duplicatesFound} groups`);

  // ── Write updates ────────────────────────────────────────────────────

  if (!dryRun && publisherUpdates.length > 0) {
    console.log(`\n  Writing ${publisherUpdates.length} publisher_entity_id updates...`);

    for (let i = 0; i < publisherUpdates.length; i += 200) {
      const batch = publisherUpdates.slice(i, i + 200);
      const result = await apiRequest(
        'POST',
        '/api/resources/batch',
        { items: batch },
        30000,
      );
      if (result.ok) {
        console.log(`  ✓ Written batch ${Math.floor(i / 200) + 1}`);
      } else {
        console.error(`  ✗ Batch write failed: ${result.message}`);
      }
    }
  }

  return {
    exitCode: 0,
    output: `Cross-referenced: ${publisherMatched} publishers, ${duplicatesFound} duplicate groups`,
  };
}
