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
import { enrichReferences } from '../../../enrich/enrich-references.ts';
import type { PageData, EnrichResult, PipelineOptions } from '../types.ts';
import { ROOT, log, writeTemp } from '../utils.ts';

export async function enrichPhase(
  page: PageData,
  content: string,
  _options: PipelineOptions,
): Promise<{ content: string; result: EnrichResult }> {
  log('enrich', 'Starting post-improve enrichment');

  let enrichedContent = content;
  let entityLinkCount = 0;
  let factRefCount = 0;
  let referencesAction: string = 'none';
  let referencesCount = 0;

  // Step 1: Entity-link enrichment
  try {
    log('enrich', 'Running entity-link enrichment...');
    const entityLinkResult = await enrichEntityLinks(enrichedContent, { root: ROOT });
    enrichedContent = entityLinkResult.content;
    entityLinkCount = entityLinkResult.insertedCount;
    if (entityLinkCount > 0) {
      log('enrich', `  Added ${entityLinkCount} EntityLink(s)`);
    } else {
      log('enrich', '  No new EntityLinks needed');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('enrich', `  ⚠ Entity-link enrichment failed: ${msg} — continuing with original content`);
  }

  // Step 2: Fact-ref enrichment
  try {
    log('enrich', 'Running fact-ref enrichment...');
    const factRefResult = await enrichFactRefs(enrichedContent, { pageId: page.id, root: ROOT });
    enrichedContent = factRefResult.content;
    factRefCount = factRefResult.insertedCount;
    if (factRefCount > 0) {
      log('enrich', `  Added ${factRefCount} fact-ref(s)`);
    } else {
      log('enrich', '  No new fact-refs needed');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('enrich', `  ⚠ Fact-ref enrichment failed: ${msg} — continuing with current content`);
  }

  // Step 3: References block enrichment
  try {
    log('enrich', 'Running References enrichment...');
    const refsResult = enrichReferences(enrichedContent, { pageId: page.id, root: ROOT });
    enrichedContent = refsResult.content;
    referencesAction = refsResult.action;
    referencesCount = refsResult.refCount;
    if (refsResult.action === 'added') {
      log('enrich', `  Added References block (${refsResult.refCount} refs)`);
    } else if (refsResult.action === 'updated') {
      log('enrich', `  Updated References block (${refsResult.refCount} refs)`);
    } else {
      log('enrich', `  References: ${refsResult.action}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('enrich', `  ⚠ References enrichment failed: ${msg} — continuing with current content`);
  }

  writeTemp(page.id, 'enriched.mdx', enrichedContent);

  const result: EnrichResult = {
    entityLinks: { insertedCount: entityLinkCount },
    factRefs: { insertedCount: factRefCount },
    references: { action: referencesAction, refCount: referencesCount },
  };
  writeTemp(page.id, 'enrich-result.json', result);

  const totalAdded = entityLinkCount + factRefCount + (referencesAction === 'added' || referencesAction === 'updated' ? 1 : 0);
  log('enrich', `Complete (${totalAdded} total enrichments added)`);

  return { content: enrichedContent, result };
}
