/**
 * Resource Enrichment — Papers (Semantic Scholar + arXiv)
 *
 * Enriches paper-type resources with citation counts, abstracts, categories,
 * and writes to the resource_papers sub-table.
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { extractArxivId, extractDOI, isScholarlyUrl, sleep } from '../resource-utils.ts';
import { fetchArxivBatch } from '../resource-metadata.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';
import { hostMatches } from '@longterm-wiki/url-utils';

// ── Semantic Scholar extended data ──────────────────────────────────────────

interface SemanticScholarPaper {
  paperId: string;
  title: string;
  authors: { authorId: string; name: string }[];
  year: number | null;
  abstract: string | null;
  citationCount: number;
  influentialCitationCount: number;
  fieldsOfStudy: { category: string }[] | null;
  publicationTypes: string[] | null;
  externalIds: { ArXiv?: string; DOI?: string } | null;
  tldr: { text: string } | null;
}

const S2_FIELDS = 'paperId,title,authors,year,abstract,citationCount,influentialCitationCount,fieldsOfStudy,publicationTypes,externalIds,tldr';

async function fetchSemanticScholarExtended(identifier: string): Promise<SemanticScholarPaper | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/${identifier}?fields=${S2_FIELDS}`;
  const response = await fetch(url);
  if (response.status === 429) {
    // Rate limited — wait and retry once
    await sleep(5000);
    const retry = await fetch(url);
    if (!retry.ok) return null;
    return retry.json() as Promise<SemanticScholarPaper>;
  }
  if (!response.ok) return null;
  return response.json() as Promise<SemanticScholarPaper>;
}

function inferMethodology(paper: SemanticScholarPaper): string | null {
  const types = paper.publicationTypes;
  if (!types) return null;
  if (types.includes('Review')) return 'survey';
  if (types.includes('CaseReport') || types.includes('ClinicalTrial')) return 'empirical';
  return null;
}

// ── Main enrichment ─────────────────────────────────────────────────────────

export async function enrichPapersCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const limit = (options.limit as number) || 200;
  const dryRun = options['dry-run'] as boolean;
  const verbose = options.verbose as boolean;

  console.log('📚 Paper Enrichment (Semantic Scholar + arXiv → resource_papers)\n');
  if (dryRun) console.log('  DRY RUN — no changes will be written\n');

  const resources = await loadResourcesPGFirst();

  // Find paper-like resources
  const paperResources = resources.filter((r) => {
    if (!r.url) return false;
    // arXiv papers
    if (hostMatches(r.url, 'arxiv.org')) return true;
    // Papers with DOIs
    if (extractDOI(r.url)) return true;
    // Scholarly URLs (nature.com, science.org, etc.)
    if (isScholarlyUrl(r.url)) return true;
    // Resources typed as paper
    if (r.type === 'paper') return true;
    return false;
  });

  console.log(`  Found ${paperResources.length} paper-like resources`);

  // Skip already-enriched/reviewed resources so we progress through the backlog
  // instead of re-processing the same first N resources every run.
  const unenriched = paperResources.filter((r) => {
    const s = r.enrichment_status;
    return !s || s === 'pending' || s === 'fetched' || s === 'classified';
  });
  console.log(`  ${unenriched.length} need enrichment (${paperResources.length - unenriched.length} already enriched/reviewed)`);

  const toProcess = unenriched.slice(0, limit);
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  const paperBatch: Array<{ resourceId: string } & Record<string, unknown>> = [];

  for (const r of toProcess) {
    // Build the Semantic Scholar identifier
    let identifier: string | null = null;
    const arxivId = extractArxivId(r.url);
    const doi = extractDOI(r.url);

    if (arxivId) {
      identifier = `ARXIV:${arxivId}`;
    } else if (doi) {
      identifier = `DOI:${doi}`;
    } else if (r.url.includes('nature.com/articles/')) {
      const match = r.url.match(/nature\.com\/articles\/([^?#]+)/);
      if (match) identifier = `DOI:10.1038/${match[1]}`;
    }

    if (!identifier) {
      skipped++;
      continue;
    }

    try {
      const paper = await fetchSemanticScholarExtended(identifier);
      if (!paper) {
        failed++;
        if (verbose) console.log(`  ✗ No S2 data: ${r.title || r.url}`);
        continue;
      }

      const paperData: Record<string, unknown> = {
        resourceId: r.id,
        semanticScholarId: paper.paperId,
        citationCount: paper.citationCount,
        influentialCitationCount: paper.influentialCitationCount,
        year: paper.year,
      };

      // Prefer S2 abstract over empty
      if (paper.abstract) {
        paperData.abstract = paper.abstract;
      }

      // Extract arXiv ID from S2 external IDs
      if (paper.externalIds?.ArXiv) {
        paperData.arxivId = paper.externalIds.ArXiv;
      } else if (arxivId) {
        paperData.arxivId = arxivId;
      }

      // Extract DOI
      if (paper.externalIds?.DOI) {
        paperData.doi = paper.externalIds.DOI;
      } else if (doi) {
        paperData.doi = doi;
      }

      // Categories from fields of study (filter nulls — S2 sometimes returns null categories)
      if (paper.fieldsOfStudy && paper.fieldsOfStudy.length > 0) {
        const cats = paper.fieldsOfStudy.map((f) => f.category).filter((c): c is string => c != null);
        if (cats.length > 0) paperData.categories = cats;
      }

      // Methodology inference
      const methodology = inferMethodology(paper);
      if (methodology) {
        paperData.methodology = methodology;
      }

      paperBatch.push(paperData as { resourceId: string } & Record<string, unknown>);
      enriched++;

      if (verbose) {
        console.log(`  ✓ ${r.title || r.url} (citations: ${paper.citationCount})`);
      }

      // Rate limit: S2 allows 100 req/5min for unauthenticated
      await sleep(3100);
    } catch (err) {
      failed++;
      if (verbose) {
        console.log(`  ✗ ${r.title || r.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`\n  Results: ${enriched} enriched, ${skipped} skipped (no identifier), ${failed} failed`);

  // Write to sub-table via batch-details API
  if (!dryRun && paperBatch.length > 0) {
    console.log(`  Writing ${paperBatch.length} paper records to resource_papers...`);

    // Process in batches of 200
    for (let i = 0; i < paperBatch.length; i += 200) {
      const batch = paperBatch.slice(i, i + 200);
      // typed-client-ok: QUA-770 baseline — resource enrichment pipeline, internal write path
      const result = await apiRequest<{ ok: boolean; upserted: { papers: number } }>(
        'POST',
        '/api/resources/batch-details',
        { papers: batch },
        30000,
      );

      if (result.ok) {
        console.log(`  ✓ Batch ${Math.floor(i / 200) + 1}: ${result.data.upserted.papers} papers written`);
      } else {
        console.error(`  ✗ Batch ${Math.floor(i / 200) + 1} failed: ${result.message}`);
      }
    }

    // Also update enrichment_status on the base resource
    const statusBatch = paperBatch.map((p) => ({
      id: p.resourceId,
      url: '', // will be COALESCED away
      enrichmentStatus: 'enriched',
    }));

    for (let i = 0; i < statusBatch.length; i += 200) {
      const batch = statusBatch.slice(i, i + 200);
      await apiRequest(
        'POST',
        '/api/resources/batch',
        { items: batch.map((b) => ({ ...b, url: resources.find((r) => r.id === b.id)?.url || '' })) },
        30000,
      );
    }
  }

  return { exitCode: 0, output: `Enriched ${enriched} papers` };
}
