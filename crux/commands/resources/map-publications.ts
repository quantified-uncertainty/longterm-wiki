/**
 * Map resource domains to publications.
 *
 * Analyzes resources that lack a publication_id and reports which ones
 * could be matched via domain lookup against publications.yaml.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

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
  title: string;
  publication_id?: string;
  [key: string]: unknown;
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function buildDomainIndex(publications: Publication[]): Map<string, Publication> {
  const index = new Map<string, Publication>();
  for (const pub of publications) {
    for (const domain of pub.domains) {
      index.set(domain.toLowerCase().replace(/^www\./, ''), pub);
    }
  }
  return index;
}

function matchPublication(domain: string, index: Map<string, Publication>): Publication | undefined {
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

export async function mapPublications(options: MapPublicationsOptions): Promise<void> {
  const topN = options.top ?? 20;
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  const pubPath = path.join(repoRoot, 'data', 'publications.yaml');
  const publications = yaml.load(fs.readFileSync(pubPath, 'utf-8')) as Publication[];
  console.log(`Loaded ${publications.length} publications from publications.yaml`);

  const resourcesPath = path.join(repoRoot, 'apps', 'web', 'src', 'data', 'resources.json');
  if (!fs.existsSync(resourcesPath)) {
    console.error('resources.json not found. Run `pnpm build-data` first.');
    process.exit(1);
  }
  const resources: Resource[] = JSON.parse(fs.readFileSync(resourcesPath, 'utf-8'));
  console.log(`Loaded ${resources.length} resources\n`);

  const domainIndex = buildDomainIndex(publications);
  const withPubId = resources.filter((r) => r.publication_id).length;
  const withoutPubId = resources.filter((r) => !r.publication_id).length;

  const domainMatched: { resource: Resource; publication: Publication; domain: string }[] = [];
  const unmappedDomains = new Map<string, number>();

  for (const r of resources) {
    if (r.publication_id) continue;
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
  console.log(`With publication_id:       ${withPubId} (${pct(withPubId, resources.length)})`);
  console.log(`Without publication_id:    ${withoutPubId}`);
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
}
