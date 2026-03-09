/**
 * KB Context Builder for Improve Pipeline
 *
 * Loads KB facts for the entity associated with a wiki page and formats them
 * as a compact, human-readable context block for injection into LLM prompts.
 *
 * The LLM uses this to:
 * - Know what KB facts exist for the entity (so it can reference them with <KBF>)
 * - Avoid contradicting structured data when writing prose
 */

import { join } from 'path';
import { PROJECT_ROOT } from './content-types.ts';
import { loadKB } from '../../packages/kb/src/loader.ts';
import { computeInverses } from '../../packages/kb/src/inverse.ts';
import { formatFactValue } from '../../packages/kb/src/format.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity, Fact } from '../../packages/kb/src/types.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

let _graph: Graph | null = null;

async function getGraph(): Promise<Graph> {
  if (!_graph) {
    _graph = await loadKB(KB_DATA_DIR);
    computeInverses(_graph);
  }
  return _graph;
}

/**
 * Find the KB entity for a wiki page by matching `entity.numericId === pageId`.
 * Falls back to matching `entity.id` against the last path segment (slug).
 */
function findKbEntity(graph: Graph, pageId: string, pagePath?: string): Entity | undefined {
  // Primary: match by numericId (e.g., "E22" → anthropic)
  const all = graph.getAllEntities();
  const byNumericId = all.find((e) => e.numericId === pageId);
  if (byNumericId) return byNumericId;

  // Fallback: match by slug extracted from path
  if (pagePath) {
    const slug = pagePath.split('/').pop()?.replace(/\.mdx$/, '');
    if (slug) {
      const bySlug = graph.getEntity(slug);
      if (bySlug) return bySlug;
    }
  }

  return undefined;
}

/**
 * Format a single fact as a compact line for the LLM prompt.
 * e.g. "  revenue:           $1.0B  (as of 2024-06, source: https://...)"
 */
function formatFactLine(fact: Fact, graph: Graph): string {
  const property = graph.getProperty(fact.propertyId);
  const propName = property?.name ?? fact.propertyId;
  const val = formatFactValue(fact, property ?? undefined, graph);
  const parts: string[] = [val];
  if (fact.asOf) parts.push(`as of ${fact.asOf}`);
  if (fact.validEnd) parts.push(`until ${fact.validEnd}`);
  if (fact.source) parts.push(`source: ${fact.source}`);
  if (fact.notes) parts.push(`note: ${fact.notes}`);
  return `  ${fact.id}  ${propName.padEnd(28)} ${parts.join(' | ')}`;
}

/**
 * Build a KB context block for a wiki page, for injection into improve prompts.
 *
 * Returns null if no KB entity is found for this page.
 *
 * @param pageId - The wiki page numeric ID, e.g. "E22"
 * @param pagePath - Optional: the wiki page path (used as slug fallback)
 */
export async function buildKbContextForPage(
  pageId: string,
  pagePath?: string,
): Promise<string | null> {
  let graph: Graph;
  try {
    graph = await getGraph();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[kb-context] Failed to load KB graph: ${msg} — skipping KB context`);
    return null;
  }

  const entity = findKbEntity(graph, pageId, pagePath);
  if (!entity) return null;

  const facts = graph.getFacts(entity.id);
  if (facts.length === 0) return null;

  // Group facts by propertyId for readability
  const grouped = new Map<string, Fact[]>();
  for (const fact of facts) {
    const existing = grouped.get(fact.propertyId);
    if (existing) existing.push(fact);
    else grouped.set(fact.propertyId, [fact]);
  }

  const lines: string[] = [];
  lines.push(`KB Facts for ${entity.name} (entity: "${entity.id}", stableId: ${entity.stableId})`);
  lines.push(`Use <KBF entity="${entity.id}" property="PROPERTY_ID" /> to reference these inline.`);
  lines.push(`The fact ID (8-char hex) can be used in <F e="${entity.id}" f="FACT_ID">display</F> for hover tooltips.`);
  lines.push('');
  lines.push(`${'Fact ID'.padEnd(14)} ${'Property'.padEnd(28)} Value (source)`);
  lines.push('-'.repeat(90));

  for (const [propertyId, propertyFacts] of grouped) {
    // Skip derived/inverse facts — they're computed, not stored
    const nonDerived = propertyFacts.filter((f) => !f.id.startsWith('inv_'));
    if (nonDerived.length === 0) continue;

    // Sort newest-first so the most recent (most authoritative) value appears at the top of the table
    const sorted = nonDerived.slice().sort((a, b) => {
      if (!a.asOf && !b.asOf) return 0;
      if (!a.asOf) return 1;
      if (!b.asOf) return -1;
      return b.asOf.localeCompare(a.asOf);
    });

    for (const fact of sorted) {
      lines.push(formatFactLine(fact, graph));
    }
  }

  // Item collections
  const collections = graph.getItemCollectionNames(entity.id);
  if (collections.length > 0) {
    lines.push('');
    lines.push(`Item collections: ${collections.join(', ')} (use <KBF> or <KBItemCollection> to render)`);
  }

  return lines.join('\n');
}
