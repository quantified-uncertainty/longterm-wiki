/**
 * Enrich Phase
 *
 * Runs standalone enrichment tools (entity-links, fact-refs) as post-processing
 * after the improve phase. These are cheap (Haiku), idempotent operations that
 * normalize EntityLink and fact-ref coverage across all pipeline runs.
 *
 * See issue #669.
 */

import { enrichEntityLinks } from '../../../enrich/enrich-entity-links.ts';
import { enrichFactRefs } from '../../../enrich/enrich-fact-refs.ts';
import type { PageData, EnrichResult, PipelineOptions } from '../types.ts';
import { ROOT, log, writeTemp } from '../utils.ts';

export async function enrichPhase(
  page: PageData,
  content: string,
  _options: PipelineOptions,
): Promise<{ content: string; result: EnrichResult }> {
  log('enrich', 'Starting post-improve enrichment');

  let enrichedContent = content;

  // Step 1: Entity-link enrichment
  log('enrich', 'Running entity-link enrichment...');
  const entityLinkResult = await enrichEntityLinks(enrichedContent, { root: ROOT });
  enrichedContent = entityLinkResult.content;
  if (entityLinkResult.insertedCount > 0) {
    log('enrich', `  Added ${entityLinkResult.insertedCount} EntityLink(s)`);
  } else {
    log('enrich', '  No new EntityLinks needed');
  }

  // Step 2: Fact-ref enrichment
  log('enrich', 'Running fact-ref enrichment...');
  const factRefResult = await enrichFactRefs(enrichedContent, { pageId: page.id, root: ROOT });
  enrichedContent = factRefResult.content;
  if (factRefResult.insertedCount > 0) {
    log('enrich', `  Added ${factRefResult.insertedCount} fact-ref(s)`);
  } else {
    log('enrich', '  No new fact-refs needed');
  }

  writeTemp(page.id, 'enriched.mdx', enrichedContent);

  const result: EnrichResult = {
    entityLinks: { insertedCount: entityLinkResult.insertedCount },
    factRefs: { insertedCount: factRefResult.insertedCount },
  };
  writeTemp(page.id, 'enrich-result.json', result);

  const totalAdded = entityLinkResult.insertedCount + factRefResult.insertedCount;
  log('enrich', `Complete (${totalAdded} total enrichments added)`);

  return { content: enrichedContent, result };
}
