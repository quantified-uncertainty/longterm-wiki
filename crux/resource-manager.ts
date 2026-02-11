#!/usr/bin/env node
import 'dotenv/config';

/**
 * Resource Manager CLI
 *
 * Unified tool for managing external resource links in wiki content.
 *
 * Commands:
 *   list              List pages with unconverted links
 *   show <file>       Show unconverted links in a specific file
 *   process <file>    Convert links to <R>, creating resources as needed
 *   create <url>      Create a resource entry from a URL
 *   metadata <source> Extract metadata (arxiv|forum|scholar|web|all|stats)
 *   validate <source> Validate resources against authoritative sources
 *   enrich            Add publication_id and tags to resources
 *   rebuild-citations Rebuild cited_by relationships from MDX files
 *
 * Examples:
 *   node crux/resource-manager.ts list --limit 20
 *   node crux/resource-manager.ts show bioweapons
 *   node crux/resource-manager.ts process bioweapons --apply
 *   node crux/resource-manager.ts metadata arxiv --batch 50
 *   node crux/resource-manager.ts metadata all
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { CONTENT_DIR_ABS as CONTENT_DIR, DATA_DIR_ABS as DATA_DIR, type Entity } from './lib/content-types.ts';
import { findMdxFiles } from './lib/file-utils.ts';

import type { Resource, ParsedOpts, Conversion } from './resource-types.ts';
import { loadResources, saveResources, loadPages, loadPublications } from './resource-io.ts';
import { hashId, normalizeUrl, buildUrlToResourceMap, extractMarkdownLinks, findFileByName, guessResourceType } from './resource-utils.ts';
import { cmdMetadata } from './resource-metadata.ts';
import { cmdValidate } from './resource-validator.ts';

// ============ Arg Parsing ============

function parseArgs(args: string[]): ParsedOpts {
  const opts: ParsedOpts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const raw = args[i].slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value format
        const key = raw.slice(0, eqIdx);
        const val = raw.slice(eqIdx + 1);
        (opts as Record<string, unknown>)[key] = isNaN(Number(val)) ? val : parseFloat(val);
      } else {
        // --key value or --flag format
        const key = raw;
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          (opts as Record<string, unknown>)[key] = isNaN(Number(next)) ? next : parseFloat(next);
          i++;
        } else {
          (opts as Record<string, unknown>)[key] = true;
        }
      }
    } else if (!opts._cmd) {
      opts._cmd = args[i];
    } else {
      opts._args = opts._args || [];
      opts._args.push(args[i]);
    }
  }
  return opts;
}

// ============ List Command ============

function cmdList(opts: ParsedOpts): void {
  const limit = (opts.limit as number) || 30;
  const minUnconv = (opts['min-unconv'] as number) || 1;

  const pages = loadPages();

  // Filter and sort by unconverted link count
  const sorted = pages
    .filter(p => (p.unconvertedLinkCount || 0) >= minUnconv)
    .sort((a, b) => (b.unconvertedLinkCount || 0) - (a.unconvertedLinkCount || 0))
    .slice(0, limit);

  console.log(`\nPages with unconverted links (min: ${minUnconv}):\n`);
  console.log('Unconv  Refs   Title');
  console.log('-'.repeat(70));

  for (const p of sorted) {
    const unconv = String(p.unconvertedLinkCount || 0).padStart(4);
    const refs = String(p.convertedLinkCount || 0).padStart(4);
    console.log(`${unconv}   ${refs}   ${p.title}`);
  }

  const total = pages.reduce((sum, p) => sum + (p.unconvertedLinkCount || 0), 0);
  const pagesWithUnconv = pages.filter(p => (p.unconvertedLinkCount || 0) > 0).length;

  console.log('\n' + '-'.repeat(70));
  console.log(`Total: ${total} unconverted links across ${pagesWithUnconv} pages`);
}

// ============ Show Command ============

function cmdShow(opts: ParsedOpts): void {
  const name = opts._args?.[0];
  if (!name) {
    console.error('Usage: resource-manager.ts show <file-name>');
    process.exit(1);
  }

  const filePath = findFileByName(name);
  if (!filePath) {
    console.error(`File not found: ${name}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  const links = extractMarkdownLinks(content);
  const resources = loadResources();
  const urlMap = buildUrlToResourceMap(resources);

  console.log(`\n📄 ${relative('.', filePath)}`);
  console.log(`   Total external links: ${links.length}\n`);

  const convertible: (typeof links[0] & { resource: Resource })[] = [];
  const needsResource: typeof links = [];

  for (const link of links) {
    const resource = urlMap.get(link.url) || urlMap.get(link.url.replace(/\/$/, ''));
    if (resource) {
      convertible.push({ ...link, resource });
    } else {
      needsResource.push(link);
    }
  }

  if (convertible.length > 0) {
    console.log(`✅ Convertible (resource exists): ${convertible.length}`);
    for (const l of convertible) {
      console.log(`   [${l.text}] → <R id="${l.resource.id}">`);
    }
    console.log();
  }

  if (needsResource.length > 0) {
    console.log(`⚠️  Needs resource creation: ${needsResource.length}`);
    for (const l of needsResource) {
      const type = guessResourceType(l.url);
      console.log(`   [${l.text}] (${type})`);
      console.log(`      ${l.url}`);
    }
  }

  if (convertible.length === 0 && needsResource.length === 0) {
    console.log('No external links found.');
  }
}

// ============ Process Command ============

function cmdProcess(opts: ParsedOpts): void {
  const name = opts._args?.[0];
  const dryRun = !opts.apply;
  const skipCreate = opts['skip-create'];

  if (!name) {
    console.error('Usage: resource-manager.ts process <file-name> [--apply] [--skip-create]');
    process.exit(1);
  }

  const filePath = findFileByName(name);
  if (!filePath) {
    console.error(`File not found: ${name}`);
    process.exit(1);
  }

  let content = readFileSync(filePath, 'utf-8');
  const links = extractMarkdownLinks(content);
  let resources = loadResources();
  let urlMap = buildUrlToResourceMap(resources);

  console.log(`\n📄 ${relative('.', filePath)}`);
  console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'APPLYING'}`);
  console.log(`   External links: ${links.length}\n`);

  const conversions: Conversion[] = [];
  const newResources: Resource[] = [];

  for (const link of links) {
    let resource = urlMap.get(link.url) || urlMap.get(link.url.replace(/\/$/, ''));

    if (!resource && !skipCreate) {
      // Create new resource
      const id = hashId(link.url);
      const type = guessResourceType(link.url);
      resource = {
        id,
        url: link.url,
        title: link.text, // Use link text as initial title
        type,
      };
      newResources.push(resource);
      resources.push(resource);
      // Update map for any duplicate URLs
      for (const url of normalizeUrl(link.url)) {
        urlMap.set(url, resource);
      }
    }

    if (resource) {
      conversions.push({
        original: link.full,
        replacement: `<R id="${resource.id}">${link.text}</R>`,
        resource,
        isNew: newResources.includes(resource),
      });
    }
  }

  // Report new resources
  if (newResources.length > 0) {
    console.log(`📦 New resources to create: ${newResources.length}`);
    for (const r of newResources) {
      console.log(`   + ${r.id} (${r.type}): ${r.title}`);
    }
    console.log();
  }

  // Report conversions
  if (conversions.length > 0) {
    console.log(`🔄 Links to convert: ${conversions.length}`);
    for (const c of conversions) {
      const marker = c.isNew ? '(new)' : '';
      console.log(`   ${c.resource.title} ${marker}`);
    }
    console.log();
  }

  if (conversions.length === 0) {
    console.log('No links to process.');
    return;
  }

  // Apply conversions to content
  for (const c of conversions) {
    content = content.replace(c.original, c.replacement);
  }

  // Note: In Next.js, <R> is registered globally via mdx-components.tsx,
  // so no import injection is needed.

  // Save changes
  if (!dryRun) {
    // Save resources first
    if (newResources.length > 0) {
      saveResources(resources);
      console.log(`✅ Saved ${newResources.length} new resources`);
    }

    // Save file
    writeFileSync(filePath, content);
    console.log(`✅ Updated ${relative('.', filePath)}`);

    // Remind to rebuild
    console.log('\n💡 Run `pnpm build` to update the database.');
  } else {
    console.log('---');
    console.log('Dry run complete. Use --apply to make changes.');
  }
}

// ============ Create Command ============

function cmdCreate(opts: ParsedOpts): void {
  const url = opts._args?.[0];
  const title = opts.title as string | undefined;
  const type = opts.type as string | undefined;

  if (!url) {
    console.error('Usage: resource-manager.ts create <url> [--title "..."] [--type paper|blog|web]');
    process.exit(1);
  }

  const resources = loadResources();
  const urlMap = buildUrlToResourceMap(resources);

  // Check if already exists
  const existing = urlMap.get(url) || urlMap.get(url.replace(/\/$/, ''));
  if (existing) {
    console.log(`Resource already exists: ${existing.id}`);
    console.log(`  Title: ${existing.title}`);
    console.log(`  Type: ${existing.type}`);
    return;
  }

  const id = hashId(url);
  const resource: Resource = {
    id,
    url,
    title: title || new URL(url).hostname,
    type: type || guessResourceType(url),
  };

  resources.push(resource);

  if (!opts['dry-run']) {
    saveResources(resources);
    console.log(`✅ Created resource: ${id}`);
    console.log(`   URL: ${url}`);
    console.log(`   Title: ${resource.title}`);
    console.log(`   Type: ${resource.type}`);
    console.log('\n💡 Run `pnpm build` to update the database.');
  } else {
    console.log('Would create resource:');
    console.log(`   ID: ${id}`);
    console.log(`   URL: ${url}`);
    console.log(`   Title: ${resource.title}`);
    console.log(`   Type: ${resource.type}`);
  }
}

// ============ Rebuild Citations ============

async function cmdRebuildCitations(opts: ParsedOpts): Promise<void> {
  const dryRun = opts['dry-run'];

  console.log('🔗 Rebuilding cited_by relationships');
  if (dryRun) console.log('   DRY RUN');

  const resources = loadResources();
  const resourceMap = new Map<string, Resource>();
  for (const r of resources) {
    r.cited_by = [];
    resourceMap.set(r.id, r);
  }

  const files = findMdxFiles(CONTENT_DIR);
  const rComponentRegex = /<R\s+id="([^"]+)"/g;
  let totalCitations = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const articleId = basename(filePath, '.mdx');
    if (articleId === 'index') continue;

    const ids = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = rComponentRegex.exec(content)) !== null) {
      ids.add(match[1]);
    }

    for (const id of ids) {
      const resource = resourceMap.get(id);
      if (resource && !resource.cited_by!.includes(articleId)) {
        resource.cited_by!.push(articleId);
        totalCitations++;
      }
    }
  }

  // Clean up empty cited_by arrays
  for (const r of resources) {
    if (r.cited_by!.length === 0) delete r.cited_by;
  }

  const withCited = resources.filter(r => r.cited_by?.length && r.cited_by.length > 0).length;
  console.log(`   Resources with citations: ${withCited}`);
  console.log(`   Total citations: ${totalCitations}`);

  if (!dryRun) {
    saveResources(resources);
    console.log('   Saved resources files');
    console.log('\n💡 Run `pnpm build` to update the database.');
  }
}

// ============ Enrich Resources ============

function buildDomainToPublicationMap(publications: { id: string; name: string; domains?: string[] }[]): Map<string, { id: string; name: string }> {
  const map = new Map<string, { id: string; name: string }>();
  for (const pub of publications) {
    if (!pub.domains) continue;
    for (const domain of pub.domains) {
      map.set(domain, pub);
    }
  }
  return map;
}

// Infer topic tags from resource content and context
function inferTags(resource: Resource, entities: Entity[] = []): string[] {
  const tags = new Set<string>();
  const text = `${resource.title || ''} ${resource.abstract || ''} ${resource.summary || ''}`.toLowerCase();

  // Topic detection
  const topicPatterns: { pattern: RegExp; tag: string }[] = [
    { pattern: /\b(alignment|aligned|misalign)/i, tag: 'alignment' },
    { pattern: /\b(interpretab|mechanistic|circuits|features)/i, tag: 'interpretability' },
    { pattern: /\b(governance|regulat|policy|policymaker)/i, tag: 'governance' },
    { pattern: /\b(capabilit|benchmark|performance|scaling)/i, tag: 'capabilities' },
    { pattern: /\b(safety|safe|dangerous)/i, tag: 'safety' },
    { pattern: /\b(x-risk|existential|extinction|catastroph)/i, tag: 'x-risk' },
    { pattern: /\b(decepti|scheming|sandbagging)/i, tag: 'deception' },
    { pattern: /\b(rlhf|fine-tun|training)/i, tag: 'training' },
    { pattern: /\b(eval|evaluat|testing|benchmark)/i, tag: 'evaluation' },
    { pattern: /\b(economic|labor|job|employment|automat)/i, tag: 'economic' },
    { pattern: /\b(bioweapon|biological|pathogen|biosec)/i, tag: 'biosecurity' },
    { pattern: /\b(cyber|hacking|security|vulnerab)/i, tag: 'cybersecurity' },
    { pattern: /\b(compute|gpu|chip|hardware)/i, tag: 'compute' },
    { pattern: /\b(open.?source|closed|release)/i, tag: 'open-source' },
    { pattern: /\b(llm|language model|transformer|gpt|claude|gemini)/i, tag: 'llm' },
    { pattern: /\b(agi|artificial general|superintelligen)/i, tag: 'agi' },
    { pattern: /\b(mesa.?optim|inner|deceptive alignment)/i, tag: 'mesa-optimization' },
  ];

  for (const { pattern, tag } of topicPatterns) {
    if (pattern.test(text)) tags.add(tag);
  }

  // Infer from cited_by entities
  if (resource.cited_by?.length) {
    for (const entityId of resource.cited_by) {
      const entity = entities.find(e => e.id === entityId);
      if (entity?.tags) {
        for (const tag of entity.tags.slice(0, 3)) {
          tags.add(tag);
        }
      }
    }
  }

  return Array.from(tags).slice(0, 5);
}

async function cmdEnrich(opts: ParsedOpts): Promise<void> {
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  console.log('🏷️  Enriching resources with publication data and tags');
  if (dryRun) console.log('   DRY RUN');

  const resources = loadResources();
  const publications = loadPublications();
  const domainMap = buildDomainToPublicationMap(publications);

  // Load entities for tag inference (read all YAML files from data/entities/)
  let entities: Entity[] = [];
  try {
    const entitiesDir = join(DATA_DIR, 'entities');
    if (existsSync(entitiesDir)) {
      for (const file of readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'))) {
        const content = readFileSync(join(entitiesDir, file), 'utf-8');
        const parsed = parseYaml(content) as unknown;
        if (Array.isArray(parsed)) entities.push(...(parsed as Entity[]));
      }
    }
  } catch (_e: unknown) {
    console.warn('   Could not load entities for tag inference');
  }

  let pubMapped = 0;
  let tagsAdded = 0;

  for (const r of resources) {
    // Map to publication
    if (!r.publication_id && r.url) {
      try {
        const domain = new URL(r.url).hostname.replace('www.', '');
        const pub = domainMap.get(domain);
        if (pub) {
          r.publication_id = pub.id;
          pubMapped++;
          if (verbose) console.log(`   📰 ${r.id} → ${pub.name}`);
        }
      } catch (_err: unknown) {}
    }

    // Infer tags if missing
    if (!r.tags || r.tags.length === 0) {
      const inferredTags = inferTags(r, entities);
      if (inferredTags.length > 0) {
        r.tags = inferredTags;
        tagsAdded++;
        if (verbose) console.log(`   🏷️  ${r.id} → [${inferredTags.join(', ')}]`);
      }
    }
  }

  console.log(`\n   Mapped to publications: ${pubMapped}`);
  console.log(`   Resources with inferred tags: ${tagsAdded}`);

  // Stats
  const withPub = resources.filter(r => r.publication_id).length;
  const withTags = resources.filter(r => r.tags?.length && r.tags.length > 0).length;
  console.log(`\n   Total with publication_id: ${withPub} (${Math.round(withPub/resources.length*100)}%)`);
  console.log(`   Total with tags: ${withTags} (${Math.round(withTags/resources.length*100)}%)`);

  if (!dryRun && (pubMapped > 0 || tagsAdded > 0)) {
    saveResources(resources);
    console.log('\n   Saved resources files');
    console.log('💡 Run `pnpm build` to update the database.');
  }
}

// ============ Help ============

function showHelp(): void {
  console.log(`
Resource Manager CLI

Commands:
  list                    List pages with unconverted links
  show <file>            Show unconverted links in a file
  process <file>         Convert links to <R>, creating resources as needed
  create <url>           Create a resource entry from a URL
  metadata <source>      Extract metadata from resources
  validate <source>      Validate resources against authoritative sources
  enrich                 Add publication_id and tags to resources
  rebuild-citations      Rebuild cited_by from MDX files

Metadata Sources:
  arxiv                  ArXiv papers (free API)
  forum                  LessWrong/AlignmentForum/EA Forum (GraphQL)
  scholar                Nature, Science, etc. (Semantic Scholar API)
  web                    General web pages (Firecrawl - requires API key)
  all                    Run all extractors
  all --parallel         Run all extractors concurrently (faster)
  stats                  Show metadata statistics

Validate Sources:
  arxiv                  Verify arXiv papers exist and titles match
  wikipedia              Verify Wikipedia articles exist and titles match
  forums                 Verify LessWrong/EA Forum posts exist
  dates                  Check for invalid/future/ancient dates
  dois                   Verify DOIs via CrossRef API
  urls                   Check for broken URLs (404s, timeouts) - slow
  all                    Run all validators (except urls)

Options:
  --apply                Apply changes (default is dry-run for process)
  --batch N              Batch size for metadata extraction (default: varies)
  --parallel             Run extractors concurrently (metadata all)
  --limit N              Limit results (list command)
  --min-unconv N         Minimum unconverted links (list command)
  --skip-create          Don't create new resources (process command)
  --title "..."          Set resource title (create command)
  --type TYPE            Set resource type (create command)
  --dry-run              Preview without changes
  --verbose              Show detailed output

Examples:
  node crux/resource-manager.ts list --limit 20
  node crux/resource-manager.ts show bioweapons
  node crux/resource-manager.ts process economic-labor --apply
  node crux/resource-manager.ts metadata stats
  node crux/resource-manager.ts metadata arxiv --batch 50
  node crux/resource-manager.ts metadata all
  node crux/resource-manager.ts validate arxiv --limit 100
  node crux/resource-manager.ts validate all --verbose
  node crux/resource-manager.ts enrich
  node crux/resource-manager.ts rebuild-citations
`);
}

// ============ Main ============

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  switch (opts._cmd) {
    case 'list':
      cmdList(opts);
      break;
    case 'show':
      cmdShow(opts);
      break;
    case 'process':
      cmdProcess(opts);
      break;
    case 'create':
      cmdCreate(opts);
      break;
    case 'metadata':
      await cmdMetadata(opts);
      break;
    case 'rebuild-citations':
      await cmdRebuildCitations(opts);
      break;
    case 'enrich':
      await cmdEnrich(opts);
      break;
    case 'validate':
      await cmdValidate(opts);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${opts._cmd}`);
      showHelp();
      process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Error:', error.message);
    process.exit(1);
  });
}
