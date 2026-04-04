/**
 * Map resource domains to publications.
 *
 * Analyzes resources that lack a publicationId and reports which ones
 * could be matched via domain lookup against publications.yaml.
 *
 * Data source priority:
 * 1. Wiki-server API (paginated fetch of all resources)
 * 2. Local resources.json fallback (from `pnpm build-data`)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { listResources, upsertResourceBatch } from '../../lib/wiki-server/resources.ts';

interface Publication {
  id: string;
  domains: string[];
  name: string;
  type: string;
  credibility: number;
}

interface Resource {
  id: string;
  url: string;
  title: string | null;
  publicationId?: string | null;
  [key: string]: unknown;
}

export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function buildDomainIndex(publications: Publication[]): Map<string, Publication> {
  const index = new Map<string, Publication>();
  for (const pub of publications) {
    for (const domain of pub.domains) {
      index.set(domain.toLowerCase().replace(/^www\./, ''), pub);
    }
  }
  return index;
}

export function matchPublication(domain: string, index: Map<string, Publication>): Publication | undefined {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  const exact = index.get(normalized);
  if (exact) return exact;
  for (const [pubDomain, pub] of index) {
    if (normalized.endsWith(`.${pubDomain}`)) return pub;
  }
  return undefined;
}

export interface MapPublicationsOptions {
  apply?: boolean;
  top?: number;
  verbose?: boolean;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

/**
 * Fetch all resources from the wiki-server API, paginating through all results.
 * Returns null if the server is unavailable.
 */
async function fetchAllResourcesFromServer(verbose: boolean): Promise<Resource[] | null> {
  // Server caps at 200 per page — request that to avoid offset misalignment
  const PAGE_SIZE = 200;
  const allResources: Resource[] = [];
  let offset = 0;

  try {
    while (true) {
      const result = await listResources(PAGE_SIZE, offset);
      if (!result.ok) {
        console.error(`Wiki-server API error: ${result.error}`);
        return null;
      }
      const { resources, total } = result.data;
      if (verbose && offset === 0) {
        console.log(`Wiki-server reports ${total} total resources`);
      }
      allResources.push(...resources.map((r) => ({ ...r }) as Resource));
      if (verbose && allResources.length % 2000 === 0) {
        console.log(`  Fetched ${allResources.length}/${total} resources...`);
      }
      if (allResources.length >= total || resources.length === 0) break;
      offset += resources.length;
    }
    return allResources;
  } catch (e) {
    console.error(`Failed to connect to wiki-server: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function mapPublications(options: MapPublicationsOptions): Promise<void> {
  const topN = options.top ?? 20;
  const verbose = !!options.verbose;
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  const pubPath = path.join(repoRoot, 'data', 'publications.yaml');
  const publications = yaml.load(fs.readFileSync(pubPath, 'utf-8')) as Publication[];
  console.log(`Loaded ${publications.length} publications from publications.yaml`);

  // Try wiki-server API first, fall back to local resources.json
  let resources: Resource[];
  const serverResources = await fetchAllResourcesFromServer(verbose);
  if (serverResources !== null && serverResources.length > 0) {
    resources = serverResources;
    console.log(`Loaded ${resources.length} resources from wiki-server API\n`);
  } else {
    const resourcesPath = path.join(repoRoot, 'apps', 'web', 'src', 'data', 'resources.json');
    if (!fs.existsSync(resourcesPath)) {
      console.error('resources.json not found and wiki-server unavailable. Run `pnpm build-data` first or set WIKI_SERVER_ENV=prod.');
      process.exit(1);
    }
    const localResources: Resource[] = JSON.parse(fs.readFileSync(resourcesPath, 'utf-8'));
    if (localResources.length === 0) {
      console.error('resources.json is empty and wiki-server unavailable. Set WIKI_SERVER_ENV=prod or run a full build-data.');
      process.exit(1);
    }
    resources = localResources;
    console.log(`Loaded ${resources.length} resources from local resources.json\n`);
  }

  const domainIndex = buildDomainIndex(publications);
  const withPubId = resources.filter((r) => r.publicationId).length;
  const withoutPubId = resources.filter((r) => !r.publicationId).length;

  const domainMatched: { resource: Resource; publication: Publication; domain: string }[] = [];
  const unmappedDomains = new Map<string, number>();

  for (const r of resources) {
    if (r.publicationId) continue;
    const domain = extractDomain(r.url);
    if (!domain) continue;
    const pub = matchPublication(domain, domainIndex);
    if (pub) {
      domainMatched.push({ resource: r, publication: pub, domain });
    } else {
      unmappedDomains.set(domain, (unmappedDomains.get(domain) ?? 0) + 1);
    }
  }

  console.log('=== Publication Mapping Report ===\n');
  console.log(`Total resources:           ${resources.length}`);
  console.log(`With publicationId:       ${withPubId} (${pct(withPubId, resources.length)})`);
  console.log(`Without publicationId:    ${withoutPubId}`);
  console.log(`  Domain-matchable:        ${domainMatched.length}`);
  console.log(`  Truly unmapped:          ${withoutPubId - domainMatched.length}`);
  console.log(`\nEffective coverage:        ${withPubId + domainMatched.length}/${resources.length} (${pct(withPubId + domainMatched.length, resources.length)})`);

  const matchedByPub = new Map<string, number>();
  for (const { publication } of domainMatched) {
    matchedByPub.set(publication.name, (matchedByPub.get(publication.name) ?? 0) + 1);
  }
  const sortedMatched = [...matchedByPub.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedMatched.length > 0) {
    console.log(`\n=== Domain-Matched Resources ===\n`);
    for (const [name, count] of sortedMatched.slice(0, 30)) {
      console.log(`  ${String(count).padStart(5)}  ${name}`);
    }
    if (sortedMatched.length > 30) console.log(`  ... and ${sortedMatched.length - 30} more`);
  }

  const sortedUnmapped = [...unmappedDomains.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedUnmapped.length > 0) {
    console.log(`\n=== Top ${topN} Unmapped Domains ===\n`);
    for (const [domain, count] of sortedUnmapped.slice(0, topN)) {
      console.log(`  ${String(count).padStart(5)}  ${domain}`);
    }
    const totalUnmapped = sortedUnmapped.reduce((sum, [, c]) => sum + c, 0);
    console.log(`\n  Total unmapped: ${totalUnmapped} across ${sortedUnmapped.length} domains`);
  }

  // ---- Apply mode: write publicationId back via batch upsert ----
  if (options.apply && domainMatched.length > 0) {
    console.log(`\n=== Applying ${domainMatched.length} publication mappings ===\n`);
    const BATCH_SIZE = 200;
    let applied = 0;
    let errors = 0;

    for (let i = 0; i < domainMatched.length; i += BATCH_SIZE) {
      const batch = domainMatched.slice(i, i + BATCH_SIZE);
      const items = batch.map(({ resource, publication }) => ({
        id: resource.id,
        url: resource.url,
        publicationId: publication.id,
      }));

      const result = await upsertResourceBatch(items);
      if (result.ok) {
        applied += result.data.upserted;
        if (verbose) {
          console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.data.upserted} upserted`);
        }
      } else {
        errors++;
        console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${result.error}`);
      }
    }

    console.log(`\nApply complete: ${applied} resources updated, ${errors} batch errors`);
    console.log(`Coverage after: ${withPubId + applied}/${resources.length} (${pct(withPubId + applied, resources.length)})`);
  } else if (options.apply && domainMatched.length === 0) {
    console.log('\nNothing to apply — no domain-matchable resources found.');
  } else if (!options.apply && domainMatched.length > 0) {
    console.log(`\nDry run — pass --apply to write ${domainMatched.length} publication mappings.`);
  }
}
