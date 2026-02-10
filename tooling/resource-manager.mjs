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
 *   rebuild-citations Rebuild cited_by relationships from MDX files
 *
 * Examples:
 *   node tooling/resource-manager.mjs list --limit 20
 *   node tooling/resource-manager.mjs show bioweapons
 *   node tooling/resource-manager.mjs process bioweapons --apply
 *   node tooling/resource-manager.mjs metadata arxiv --batch 50
 *   node tooling/resource-manager.mjs metadata all
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname, relative } from 'path';
import { createHash } from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CONTENT_DIR_ABS as CONTENT_DIR, DATA_DIR_ABS as DATA_DIR, GENERATED_DATA_DIR_ABS } from './lib/content-types.mjs';

const RESOURCES_DIR = join(DATA_DIR, 'resources');
const PUBLICATIONS_FILE = join(DATA_DIR, 'publications.yaml');
const PAGES_FILE = join(GENERATED_DATA_DIR_ABS, 'pages.json');

// Forum publication IDs that go in forums.yaml
const FORUM_PUBLICATION_IDS = new Set(['lesswrong', 'alignment-forum', 'ea-forum']);

// ============ Utilities ============

function hashId(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Determine which file a resource belongs to based on type/publication
 */
function getResourceCategory(resource) {
  if (resource.type === 'paper') return 'papers';
  if (resource.type === 'government') return 'government';
  if (resource.publication_id && FORUM_PUBLICATION_IDS.has(resource.publication_id)) return 'forums';
  return 'general';
}

/**
 * Load all resources from the split directory
 */
function loadResources() {
  const resources = [];
  if (!existsSync(RESOURCES_DIR)) {
    return resources;
  }

  const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(RESOURCES_DIR, file);
    const content = readFileSync(filepath, 'utf-8');
    const data = parseYaml(content) || [];
    resources.push(...data);
  }
  return resources;
}

/**
 * Save resources to the appropriate split files based on type
 */
function saveResources(resources) {
  // Categorize resources
  const categorized = {
    papers: [],
    government: [],
    forums: [],
    general: [],
  };

  for (const resource of resources) {
    const category = getResourceCategory(resource);
    categorized[category].push(resource);
  }

  // Headers for each file
  const headers = {
    papers: '# Papers Resources\n# Academic papers, preprints, and research publications\n\n',
    government: '# Government Resources\n# Government documents, policy reports, and regulatory materials\n\n',
    forums: '# Forums Resources\n# Posts from LessWrong, Alignment Forum, and EA Forum\n\n',
    general: '# General Resources\n# Web articles, blog posts, and other resources\n\n',
  };

  // Write each category to its file
  for (const [category, items] of Object.entries(categorized)) {
    const filepath = join(RESOURCES_DIR, `${category}.yaml`);
    const content = headers[category] + stringifyYaml(items, { lineWidth: 100 });
    writeFileSync(filepath, content);
  }
}

function loadPages() {
  return JSON.parse(readFileSync(PAGES_FILE, 'utf-8'));
}

function normalizeUrl(url) {
  const variations = new Set();
  try {
    const parsed = new URL(url);
    const base = parsed.href.replace(/\/$/, '');
    variations.add(base);
    variations.add(base + '/');
    // Without www
    if (parsed.hostname.startsWith('www.')) {
      const noWww = base.replace('://www.', '://');
      variations.add(noWww);
      variations.add(noWww + '/');
    }
    // With www
    if (!parsed.hostname.startsWith('www.')) {
      const withWww = base.replace('://', '://www.');
      variations.add(withWww);
      variations.add(withWww + '/');
    }
  } catch {
    variations.add(url);
  }
  return Array.from(variations);
}

function buildUrlToResourceMap(resources) {
  const map = new Map();
  for (const r of resources) {
    if (!r.url) continue;
    for (const url of normalizeUrl(r.url)) {
      map.set(url, r);
    }
  }
  return map;
}

function extractMarkdownLinks(content) {
  const links = [];
  const linkRegex = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const [full, text, url] = match;
    links.push({ text, url, full, index: match.index });
  }
  return links;
}

function findMdxFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      findMdxFiles(path, files);
    } else if (entry.endsWith('.mdx')) {
      files.push(path);
    }
  }
  return files;
}

function findFileByName(name) {
  const allFiles = findMdxFiles(CONTENT_DIR);
  // Try exact match first
  let match = allFiles.find(f => basename(f, '.mdx') === name);
  if (match) return match;
  // Try partial match
  match = allFiles.find(f => f.includes(name));
  return match || null;
}

function getImportDepth(filePath) {
  const fromDir = dirname(filePath);
  const srcDir = 'src';
  const rel = relative(fromDir, srcDir);
  return rel.split('/').join('/') + '/';
}

function guessResourceType(url) {
  const domain = new URL(url).hostname.toLowerCase();
  if (domain.includes('arxiv.org')) return 'paper';
  if (domain.includes('nature.com') || domain.includes('science.org')) return 'paper';
  if (domain.includes('springer.com') || domain.includes('wiley.com')) return 'paper';
  if (domain.includes('ncbi.nlm.nih.gov') || domain.includes('pubmed')) return 'paper';
  if (domain.includes('gov') || domain.includes('government')) return 'government';
  if (domain.includes('wikipedia.org')) return 'reference';
  if (domain.includes('youtube.com') || domain.includes('youtu.be')) return 'talk';
  if (domain.includes('podcast') || domain.includes('spotify.com')) return 'podcast';
  if (domain.includes('substack.com') || domain.includes('medium.com')) return 'blog';
  if (domain.includes('forum.effectivealtruism.org')) return 'blog';
  if (domain.includes('lesswrong.com') || domain.includes('alignmentforum.org')) return 'blog';
  return 'web';
}

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = isNaN(next) ? next : parseFloat(next);
        i++;
      } else {
        opts[key] = true;
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

function cmdList(opts) {
  const limit = opts.limit || 30;
  const minUnconv = opts['min-unconv'] || 1;

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

function cmdShow(opts) {
  const name = opts._args?.[0];
  if (!name) {
    console.error('Usage: resource-manager.mjs show <file-name>');
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

  const convertible = [];
  const needsResource = [];

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

function cmdProcess(opts) {
  const name = opts._args?.[0];
  const dryRun = !opts.apply;
  const skipCreate = opts['skip-create'];

  if (!name) {
    console.error('Usage: resource-manager.mjs process <file-name> [--apply] [--skip-create]');
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

  const conversions = [];
  const newResources = [];

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

  // Add R import if needed
  const hasRImport = /import\s*{[^}]*\bR\b[^}]*}\s*from/.test(content);
  if (!hasRImport) {
    const wikiImportRegex = /import\s*{([^}]+)}\s*from\s*['"]([^'"]*components\/wiki)['"]/;
    const wikiMatch = content.match(wikiImportRegex);
    if (wikiMatch) {
      const existingImports = wikiMatch[1];
      const newImports = existingImports.trim() + ', R';
      content = content.replace(wikiImportRegex, `import {${newImports}} from '${wikiMatch[2]}'`);
    } else {
      // Add new import after frontmatter
      const importDepth = getImportDepth(filePath);
      const importStatement = `\nimport {R} from '${importDepth}components/wiki';\n`;
      if (content.startsWith('---')) {
        const afterFirst = content.indexOf('\n') + 1;
        const closingMatch = content.slice(afterFirst).match(/\n---(?=\n|[^-]|$)/);
        if (closingMatch) {
          const insertPos = afterFirst + closingMatch.index + 4;
          content = content.slice(0, insertPos) + importStatement + content.slice(insertPos);
        }
      }
    }
  }

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

function cmdCreate(opts) {
  const url = opts._args?.[0];
  const title = opts.title;
  const type = opts.type;

  if (!url) {
    console.error('Usage: resource-manager.mjs create <url> [--title "..."] [--type paper|blog|web]');
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
  const resource = {
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

// ============ Metadata Extraction ============

/**
 * Extract ArXiv ID from URL
 */
function extractArxivId(url) {
  const patterns = [
    /arxiv\.org\/(?:abs|pdf|html)\/(\d+\.\d+)(?:v\d+)?/,
    /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+\/\d+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch metadata from ArXiv API
 */
async function fetchArxivBatch(arxivIds) {
  const idList = arxivIds.join(',');
  const url = `http://export.arxiv.org/api/query?id_list=${idList}&max_results=${arxivIds.length}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ArXiv API error: ${response.status}`);
  const xml = await response.text();

  const results = new Map();
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const idMatch = entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
    if (!idMatch) continue;
    const id = idMatch[1].replace(/v\d+$/, '');

    const authors = [];
    const authorRegex = /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);

    results.set(id, {
      authors,
      published: publishedMatch ? publishedMatch[1].split('T')[0] : null,
      abstract: summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim() : null,
    });
  }
  return results;
}

/**
 * Extract ArXiv metadata for resources
 */
async function extractArxivMetadata(opts) {
  const batch = opts.batch || 100;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;
  const skipSave = opts._skipSave;

  if (!opts._skipSave) console.log('📚 ArXiv Metadata Extractor');
  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources = opts._resources || loadResources();
  const arxivResources = resources.filter(r => {
    if (!r.url || !r.url.includes('arxiv.org')) return false;
    if (r.authors && r.authors.length > 0) return false;
    return extractArxivId(r.url) !== null;
  });

  console.log(`   Found ${arxivResources.length} ArXiv papers without metadata`);

  const toProcess = arxivResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All ArXiv papers have metadata');
    return 0;
  }

  const idToResource = new Map();
  for (const r of toProcess) {
    const arxivId = extractArxivId(r.url);
    if (arxivId) idToResource.set(arxivId, r);
  }

  const allIds = Array.from(idToResource.keys());
  let updated = 0;

  for (let i = 0; i < allIds.length; i += 20) {
    const batchIds = allIds.slice(i, i + 20);
    try {
      const metadata = await fetchArxivBatch(batchIds);
      for (const [arxivId, meta] of metadata) {
        const resource = idToResource.get(arxivId);
        if (!resource) continue;
        if (meta.authors?.length > 0) resource.authors = meta.authors;
        if (meta.published) resource.published_date = meta.published;
        if (meta.abstract && !resource.abstract) resource.abstract = meta.abstract;
        updated++;
        if (verbose) console.log(`   ✓ ${resource.title}`);
      }
      if (i + 20 < allIds.length) await sleep(3000);
    } catch (err) {
      console.error(`   Error: ${err.message}`);
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} papers`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

/**
 * Extract forum post slug
 */
function extractForumSlug(url) {
  const match = url.match(/(?:lesswrong\.com|alignmentforum\.org|forum\.effectivealtruism\.org)\/posts\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Fetch forum metadata via GraphQL
 */
async function fetchForumMetadata(postId, isEAForum) {
  const endpoint = isEAForum
    ? 'https://forum.effectivealtruism.org/graphql'
    : 'https://www.lesswrong.com/graphql';

  const query = `query { post(input: {selector: {_id: "${postId}"}}) { result { title postedAt user { displayName } coauthors { displayName } } } }`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const post = data?.data?.post?.result;
  if (!post) return null;

  const authors = [post.user?.displayName];
  if (post.coauthors) authors.push(...post.coauthors.map(c => c.displayName));

  return {
    title: post.title,
    authors: authors.filter(Boolean),
    published: post.postedAt ? post.postedAt.split('T')[0] : null,
  };
}

/**
 * Extract forum metadata for resources
 */
async function extractForumMetadata(opts) {
  const batch = opts.batch || 100;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  if (!opts._skipSave) console.log('📝 Forum Metadata Extractor (LW/AF/EAF)');
  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources = opts._resources || loadResources();
  const forumResources = resources.filter(r => {
    if (!r.url) return false;
    if (r.authors && r.authors.length > 0) return false;
    return extractForumSlug(r.url) !== null;
  });

  console.log(`   Found ${forumResources.length} forum posts without metadata`);

  const toProcess = forumResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All forum posts have metadata');
    return 0;
  }

  let updated = 0;
  for (const r of toProcess) {
    const slug = extractForumSlug(r.url);
    const isEA = r.url.includes('forum.effectivealtruism.org');
    try {
      const meta = await fetchForumMetadata(slug, isEA);
      if (meta?.authors?.length > 0) {
        r.authors = meta.authors;
        if (meta.published) r.published_date = meta.published;
        updated++;
        if (verbose) console.log(`   ✓ ${r.title}`);
      }
      await sleep(200);
    } catch (err) {
      if (verbose) console.log(`   ✗ ${r.title}: ${err.message}`);
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} posts`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

/**
 * Extract DOI from URL
 */
function extractDOI(url) {
  // Match DOI patterns
  const patterns = [
    /doi\.org\/(10\.\d{4,}\/[^\s]+)/,
    /nature\.com\/articles\/([^\s?#]+)/,
    /science\.org\/doi\/(10\.\d{4,}\/[^\s]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch metadata from Semantic Scholar API
 */
async function fetchSemanticScholarMetadata(identifier) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/${identifier}?fields=title,authors,year,abstract,publicationDate`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const data = await response.json();
  if (!data) return null;

  return {
    title: data.title,
    authors: data.authors?.map(a => a.name) || [],
    published: data.publicationDate || (data.year ? `${data.year}` : null),
    abstract: data.abstract,
  };
}

/**
 * Check if URL could have Semantic Scholar data
 */
function isScholarlyUrl(url) {
  const scholarlyDomains = [
    'nature.com', 'science.org', 'springer.com', 'wiley.com',
    'sciencedirect.com', 'plos.org', 'pnas.org', 'cell.com',
    'ncbi.nlm.nih.gov', 'pubmed', 'doi.org', 'ssrn.com',
    'aeaweb.org', 'jstor.org', 'tandfonline.com'
  ];
  return scholarlyDomains.some(d => url.includes(d));
}

/**
 * Extract Semantic Scholar metadata for resources
 */
async function extractScholarMetadata(opts) {
  const batch = opts.batch || 50;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  if (!opts._skipSave) console.log('🎓 Semantic Scholar Metadata Extractor');
  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources = opts._resources || loadResources();

  // Find scholarly resources without authors
  const scholarResources = resources.filter(r => {
    if (!r.url) return false;
    if (r.authors && r.authors.length > 0) return false;
    if (r.url.includes('arxiv.org')) return false; // ArXiv handled separately
    return isScholarlyUrl(r.url);
  });

  console.log(`   Found ${scholarResources.length} scholarly resources without metadata`);

  const toProcess = scholarResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All scholarly resources have metadata');
    return 0;
  }

  let updated = 0;
  let failed = 0;

  for (const r of toProcess) {
    // Try DOI first
    let doi = extractDOI(r.url);

    // For nature.com, construct DOI
    if (!doi && r.url.includes('nature.com/articles/')) {
      const match = r.url.match(/nature\.com\/articles\/([^?#]+)/);
      if (match) doi = `10.1038/${match[1]}`;
    }

    if (!doi) {
      failed++;
      continue;
    }

    try {
      const meta = await fetchSemanticScholarMetadata(doi);
      if (meta?.authors?.length > 0) {
        r.authors = meta.authors;
        if (meta.published) r.published_date = meta.published;
        if (meta.abstract && !r.abstract) r.abstract = meta.abstract;
        updated++;
        if (verbose) console.log(`   ✓ ${r.title}`);
      } else {
        failed++;
      }
      await sleep(100); // Rate limit
    } catch (err) {
      failed++;
      if (verbose) console.log(`   ✗ ${r.title}: ${err.message}`);
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} resources (${failed} failed/no data)`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

/**
 * Extract metadata using Firecrawl for general web pages
 */
async function extractWebMetadata(opts) {
  const batch = opts.batch || 20;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  if (!opts._skipSave) console.log('🔥 Web Metadata Extractor (Firecrawl)');

  const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY;
  if (!FIRECRAWL_KEY) {
    if (!opts._skipSave) console.log('   ⚠️  FIRECRAWL_KEY not set in .env - skipping');
    return 0;
  }

  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources = opts._resources || loadResources();

  // Find web resources without authors (excluding those handled by other extractors)
  const webResources = resources.filter(r => {
    if (!r.url) return false;
    if (r.authors && r.authors.length > 0) return false;
    if (r.url.includes('arxiv.org')) return false;
    if (extractForumSlug(r.url)) return false;
    if (isScholarlyUrl(r.url)) return false;
    if (r.url.includes('wikipedia.org')) return false;
    if (r.url.includes('github.com')) return false;
    return true;
  });

  console.log(`   Found ${webResources.length} web resources without metadata`);

  const toProcess = webResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All processable web resources have metadata');
    return 0;
  }

  // Dynamic import for Firecrawl
  let FirecrawlApp;
  try {
    const module = await import('@mendable/firecrawl-js');
    FirecrawlApp = module.default;
  } catch {
    console.log('   ⚠️  @mendable/firecrawl-js not installed');
    return 0;
  }

  const firecrawl = new FirecrawlApp({ apiKey: FIRECRAWL_KEY });
  let updated = 0;

  // Build URL to resource map
  const urlToResource = new Map();
  for (const r of toProcess) {
    urlToResource.set(r.url, r);
  }

  // Use batch scraping for efficiency
  const urls = toProcess.map(r => r.url);
  if (!opts._skipSave) console.log(`   Batch scraping ${urls.length} URLs...`);

  try {
    // batchScrape processes URLs in parallel on Firecrawl's side
    const results = await firecrawl.batchScrape(urls, {
      formats: ['markdown'],
      timeout: 300000, // 5 min timeout
    });

    // Process results
    for (const result of results.data || []) {
      const r = urlToResource.get(result.metadata?.sourceURL || result.metadata?.url);
      if (!r) continue;

      const metadata = result.metadata || {};

      // Extract authors from various metadata fields
      const authorFields = ['author', 'authors', 'DC.Contributor', 'DC.Creator', 'article:author', 'og:article:author'];
      let authors = null;
      for (const field of authorFields) {
        const value = metadata[field];
        if (value) {
          if (Array.isArray(value)) {
            authors = value.filter(a => a && typeof a === 'string');
          } else if (typeof value === 'string') {
            authors = value.includes(',') ? value.split(',').map(a => a.trim()) : [value];
          }
          if (authors?.length > 0) break;
        }
      }

      const publishedDate = metadata.publishedTime || metadata.datePublished || metadata.article?.publishedTime;

      if (authors?.length > 0) {
        r.authors = authors;
        updated++;
        if (verbose) console.log(`   ✓ ${r.title} (authors: ${authors.join(', ')})`);
      }
      if (publishedDate) {
        r.published_date = publishedDate.split('T')[0];
        if (!authors?.length) updated++;
        if (verbose && !authors?.length) console.log(`   ✓ ${r.title} (date: ${publishedDate})`);
      }
    }
  } catch (err) {
    // Fall back to sequential if batch fails
    if (!opts._skipSave) console.log(`   Batch failed (${err.message}), falling back to sequential...`);

    for (const r of toProcess) {
      try {
        const result = await firecrawl.scrape(r.url, { formats: ['markdown'] });
        const metadata = result.metadata || {};

        const authorFields = ['author', 'authors', 'DC.Contributor', 'DC.Creator', 'article:author', 'og:article:author'];
        let authors = null;
        for (const field of authorFields) {
          const value = metadata[field];
          if (value) {
            if (Array.isArray(value)) {
              authors = value.filter(a => a && typeof a === 'string');
            } else if (typeof value === 'string') {
              authors = value.includes(',') ? value.split(',').map(a => a.trim()) : [value];
            }
            if (authors?.length > 0) break;
          }
        }

        const publishedDate = metadata.publishedTime || metadata.datePublished || metadata.article?.publishedTime;

        if (authors?.length > 0) {
          r.authors = authors;
          updated++;
        }
        if (publishedDate) {
          r.published_date = publishedDate.split('T')[0];
          if (!authors?.length) updated++;
        }

        await sleep(7000);
      } catch (e) {
        if (verbose) console.log(`   ✗ ${r.title}: ${e.message}`);
      }
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} resources`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

/**
 * Show metadata statistics
 */
function showMetadataStats() {
  console.log('📊 Resource Metadata Statistics\n');

  const resources = loadResources();
  const total = resources.length;
  const withAuthors = resources.filter(r => r.authors?.length > 0).length;
  const withDate = resources.filter(r => r.published_date).length;
  const withAbstract = resources.filter(r => r.abstract).length;
  const withSummary = resources.filter(r => r.summary).length;

  console.log(`Total resources: ${total}`);
  console.log(`With authors: ${withAuthors} (${Math.round(withAuthors/total*100)}%)`);
  console.log(`With date: ${withDate} (${Math.round(withDate/total*100)}%)`);
  console.log(`With abstract: ${withAbstract} (${Math.round(withAbstract/total*100)}%)`);
  console.log(`With summary: ${withSummary} (${Math.round(withSummary/total*100)}%)`);

  // Count by extractable source
  const arxiv = resources.filter(r => r.url?.includes('arxiv.org') && !r.authors?.length).length;
  const forum = resources.filter(r => extractForumSlug(r.url) && !r.authors?.length).length;
  const scholarly = resources.filter(r => r.url && isScholarlyUrl(r.url) && !r.url.includes('arxiv.org') && !r.authors?.length).length;
  const web = resources.filter(r => r.url && !r.authors?.length && !r.url.includes('arxiv.org') && !extractForumSlug(r.url) && !isScholarlyUrl(r.url)).length;

  console.log('\nPending extraction:');
  console.log(`  ArXiv: ${arxiv}`);
  console.log(`  Forums (LW/AF/EAF): ${forum}`);
  console.log(`  Scholarly (Semantic Scholar): ${scholarly}`);
  console.log(`  Web (Firecrawl): ${web}`);

  // Top domains without metadata
  const domains = {};
  for (const r of resources.filter(r => r.url && !r.authors?.length)) {
    try {
      const domain = new URL(r.url).hostname.replace('www.', '');
      domains[domain] = (domains[domain] || 0) + 1;
    } catch {}
  }
  const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log('\nTop domains without metadata:');
  for (const [domain, count] of sorted) {
    console.log(`  ${count.toString().padStart(4)} ${domain}`);
  }
}

/**
 * Main metadata command router
 */
async function cmdMetadata(opts) {
  const source = opts._args?.[0];
  const parallel = opts.parallel;

  if (!source || source === 'stats') {
    showMetadataStats();
    return;
  }

  if (!['arxiv', 'forum', 'scholar', 'web', 'all', 'stats'].includes(source)) {
    console.error(`Unknown source: ${source}`);
    console.log('Valid sources: arxiv, forum, scholar, web, all, stats');
    process.exit(1);
  }

  let totalUpdated = 0;

  if (source === 'all' && parallel) {
    // Run all extractors in parallel (they use different APIs)
    // Load resources once, pass to all, save once at end
    console.log('🚀 Running all extractors in parallel...\n');

    const resources = loadResources();
    const sharedOpts = { ...opts, _resources: resources, _skipSave: true };

    const results = await Promise.allSettled([
      extractArxivMetadata(sharedOpts),
      extractForumMetadata(sharedOpts),
      extractScholarMetadata(sharedOpts),
      extractWebMetadata(sharedOpts),
    ]);

    const labels = ['ArXiv', 'Forum', 'Scholar', 'Web'];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`✅ ${labels[i]}: ${r.value} updated`);
        totalUpdated += r.value;
      } else {
        console.log(`❌ ${labels[i]}: ${r.reason?.message || 'failed'}`);
      }
    });

    // Save once at the end
    if (totalUpdated > 0 && !opts['dry-run']) {
      saveResources(resources);
      console.log('\n📁 Saved resources files');
    }
  } else {
    // Sequential execution
    if (source === 'arxiv' || source === 'all') {
      totalUpdated += await extractArxivMetadata(opts);
      console.log();
    }

    if (source === 'forum' || source === 'all') {
      totalUpdated += await extractForumMetadata(opts);
      console.log();
    }

    if (source === 'scholar' || source === 'all') {
      totalUpdated += await extractScholarMetadata(opts);
      console.log();
    }

    if (source === 'web' || source === 'all') {
      totalUpdated += await extractWebMetadata(opts);
      console.log();
    }
  }

  if (totalUpdated > 0 && !opts['dry-run']) {
    console.log('\n💡 Run `pnpm build` to update the database.');
  }
}

// ============ Rebuild Citations ============

async function cmdRebuildCitations(opts) {
  const dryRun = opts['dry-run'];

  console.log('🔗 Rebuilding cited_by relationships');
  if (dryRun) console.log('   DRY RUN');

  const resources = loadResources();
  const resourceMap = new Map();
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

    const ids = new Set();
    let match;
    while ((match = rComponentRegex.exec(content)) !== null) {
      ids.add(match[1]);
    }

    for (const id of ids) {
      const resource = resourceMap.get(id);
      if (resource && !resource.cited_by.includes(articleId)) {
        resource.cited_by.push(articleId);
        totalCitations++;
      }
    }
  }

  // Clean up empty cited_by arrays
  for (const r of resources) {
    if (r.cited_by.length === 0) delete r.cited_by;
  }

  const withCited = resources.filter(r => r.cited_by?.length > 0).length;
  console.log(`   Resources with citations: ${withCited}`);
  console.log(`   Total citations: ${totalCitations}`);

  if (!dryRun) {
    saveResources(resources);
    console.log('   Saved resources files');
    console.log('\n💡 Run `pnpm build` to update the database.');
  }
}

// ============ Enrich Resources ============

function loadPublications() {
  const content = readFileSync(PUBLICATIONS_FILE, 'utf-8');
  return parseYaml(content) || [];
}

function buildDomainToPublicationMap(publications) {
  const map = new Map();
  for (const pub of publications) {
    if (!pub.domains) continue;
    for (const domain of pub.domains) {
      map.set(domain, pub);
    }
  }
  return map;
}

// Infer topic tags from resource content and context
function inferTags(resource, entities = []) {
  const tags = new Set();
  const text = `${resource.title || ''} ${resource.abstract || ''} ${resource.summary || ''}`.toLowerCase();

  // Topic detection
  const topicPatterns = [
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

async function cmdEnrich(opts) {
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  console.log('🏷️  Enriching resources with publication data and tags');
  if (dryRun) console.log('   DRY RUN');

  const resources = loadResources();
  const publications = loadPublications();
  const domainMap = buildDomainToPublicationMap(publications);

  // Load entities for tag inference (read all YAML files from data/entities/)
  let entities = [];
  try {
    const entitiesDir = 'data/entities';
    if (existsSync(entitiesDir)) {
      for (const file of readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'))) {
        const content = readFileSync(join(entitiesDir, file), 'utf-8');
        const parsed = parseYaml(content);
        if (Array.isArray(parsed)) entities.push(...parsed);
      }
    }
  } catch (e) {
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
      } catch {}
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
  const withTags = resources.filter(r => r.tags?.length > 0).length;
  console.log(`\n   Total with publication_id: ${withPub} (${Math.round(withPub/resources.length*100)}%)`);
  console.log(`   Total with tags: ${withTags} (${Math.round(withTags/resources.length*100)}%)`);

  if (!dryRun && (pubMapped > 0 || tagsAdded > 0)) {
    saveResources(resources);
    console.log('\n   Saved resources files');
    console.log('💡 Run `pnpm build` to update the database.');
  }
}

// ============ Validate Resources ============

/**
 * Normalize title for fuzzy comparison
 */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two titles are similar enough
 */
function titlesAreSimilar(stored, fetched) {
  const a = normalizeTitle(stored);
  const b = normalizeTitle(fetched);
  if (!a || !b) return true; // Can't compare
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // Word overlap
  const aWords = new Set(a.split(' ').filter(w => w.length > 3));
  const bWords = new Set(b.split(' ').filter(w => w.length > 3));
  let overlap = 0;
  for (const w of aWords) if (bWords.has(w)) overlap++;
  return overlap / Math.max(aWords.size, bWords.size) > 0.4;
}

/**
 * Validate arXiv resources against API
 */
async function validateArxiv(resources, opts) {
  const verbose = opts.verbose;
  const limit = opts.limit || 50;

  const arxivResources = resources.filter(r => r.url?.includes('arxiv.org'));
  console.log(`   Found ${arxivResources.length} arXiv resources`);

  const toCheck = arxivResources.slice(0, limit);
  const idToResource = new Map();

  for (const r of toCheck) {
    const arxivId = extractArxivId(r.url);
    if (arxivId) idToResource.set(arxivId, r);
  }

  const issues = [];
  const allIds = Array.from(idToResource.keys());

  for (let i = 0; i < allIds.length; i += 20) {
    const batchIds = allIds.slice(i, i + 20);
    process.stdout.write(`\r   Checking ${Math.min(i + 20, allIds.length)}/${allIds.length}...`);

    try {
      const metadata = await fetchArxivBatch(batchIds);

      for (const arxivId of batchIds) {
        const resource = idToResource.get(arxivId);
        const fetched = metadata.get(arxivId);

        if (!fetched) {
          issues.push({
            resource,
            type: 'not_found',
            message: `Paper not found on arXiv: ${arxivId}`
          });
          continue;
        }

        // Check title mismatch
        if (resource.title && fetched.title && !titlesAreSimilar(resource.title, fetched.title)) {
          issues.push({
            resource,
            type: 'title_mismatch',
            message: 'Title mismatch',
            stored: resource.title,
            fetched: fetched.title
          });
        }

        // Check author mismatch (if we have stored authors)
        if (resource.authors?.length > 0 && fetched.authors?.length > 0) {
          // Normalize names - handle "Last, First" vs "First Last" formats
          const normalizeName = (name) => {
            const parts = name.split(/[,\s]+/).filter(p => p.length > 1);
            return parts.sort().join(' ').toLowerCase();
          };
          const storedNorm = normalizeName(resource.authors[0]);
          const fetchedNorm = normalizeName(fetched.authors[0]);

          // Check if names have same parts (ignoring order)
          if (storedNorm !== fetchedNorm) {
            issues.push({
              resource,
              type: 'author_mismatch',
              message: 'First author mismatch',
              stored: resource.authors[0],
              fetched: fetched.authors[0]
            });
          }
        }
      }

      if (i + 20 < allIds.length) await sleep(3000);
    } catch (err) {
      console.error(`\n   API error: ${err.message}`);
    }
  }

  console.log();
  return issues;
}

/**
 * Check for broken URLs (HTTP errors)
 */
async function validateUrls(resources, opts) {
  const limit = opts.limit || 100;
  const verbose = opts.verbose;

  // Sample random resources to check
  const toCheck = resources
    .filter(r => r.url && !r.url.includes('arxiv.org')) // Skip arXiv (checked separately)
    .sort(() => Math.random() - 0.5)
    .slice(0, limit);

  console.log(`   Checking ${toCheck.length} random URLs...`);

  const issues = [];
  let checked = 0;

  for (const resource of toCheck) {
    checked++;
    if (checked % 10 === 0) {
      process.stdout.write(`\r   Checked ${checked}/${toCheck.length}...`);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(resource.url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'LongtermWikiValidator/1.0' },
        redirect: 'follow'
      });

      clearTimeout(timeout);

      if (response.status >= 400) {
        issues.push({
          resource,
          type: 'http_error',
          message: `HTTP ${response.status}`,
          url: resource.url
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        issues.push({
          resource,
          type: 'timeout',
          message: 'Request timeout',
          url: resource.url
        });
      }
      // Ignore other errors (DNS, etc) as they may be network issues
    }

    await sleep(200); // Be polite
  }

  console.log();
  return issues;
}

/**
 * Validate Wikipedia links exist and match expected topic
 */
async function validateWikipedia(resources, opts) {
  const limit = opts.limit || 50;
  const verbose = opts.verbose;

  const wikiResources = resources.filter(r =>
    r.url?.includes('wikipedia.org/wiki/') || r.url?.includes('en.wikipedia.org')
  );
  console.log(`   Found ${wikiResources.length} Wikipedia resources`);

  const toCheck = wikiResources.slice(0, limit);
  const issues = [];

  for (let i = 0; i < toCheck.length; i++) {
    const resource = toCheck[i];
    if ((i + 1) % 5 === 0) {
      process.stdout.write(`\r   Checking ${i + 1}/${toCheck.length}...`);
    }

    try {
      // Extract article title from URL
      const urlMatch = resource.url.match(/wikipedia\.org\/wiki\/([^#?]+)/);
      if (!urlMatch) continue;
      const articleTitle = decodeURIComponent(urlMatch[1].replace(/_/g, ' '));

      // Use Wikipedia API to check if article exists
      const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(urlMatch[1])}`;
      const response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'LongtermWikiValidator/1.0' }
      });

      if (response.status === 404) {
        issues.push({
          resource,
          type: 'wiki_not_found',
          message: `Wikipedia article not found: ${articleTitle}`,
          url: resource.url
        });
      } else if (response.ok) {
        const data = await response.json();
        // Check if stored title matches Wikipedia title
        if (resource.title && data.title) {
          if (!titlesAreSimilar(resource.title, data.title) &&
              !titlesAreSimilar(resource.title, articleTitle)) {
            issues.push({
              resource,
              type: 'wiki_title_mismatch',
              message: 'Wikipedia title mismatch',
              stored: resource.title,
              fetched: data.title
            });
          }
        }
      }

      await sleep(100); // Be polite to Wikipedia
    } catch (err) {
      // Ignore network errors
    }
  }

  console.log();
  return issues;
}

/**
 * Validate forum posts (LessWrong, EA Forum, Alignment Forum)
 */
async function validateForumPosts(resources, opts) {
  const limit = opts.limit || 50;
  const verbose = opts.verbose;

  const forumResources = resources.filter(r => {
    const url = r.url || '';
    return url.includes('lesswrong.com') ||
           url.includes('alignmentforum.org') ||
           url.includes('forum.effectivealtruism.org');
  });
  console.log(`   Found ${forumResources.length} forum resources`);

  const toCheck = forumResources.slice(0, limit);
  const issues = [];

  for (let i = 0; i < toCheck.length; i++) {
    const resource = toCheck[i];
    if ((i + 1) % 5 === 0) {
      process.stdout.write(`\r   Checking ${i + 1}/${toCheck.length}...`);
    }

    try {
      // Extract post slug from URL
      const postMatch = resource.url.match(/\/posts\/([a-zA-Z0-9]+)/);
      if (!postMatch) continue;
      const postId = postMatch[1];

      // Determine which API to use
      let apiUrl;
      if (resource.url.includes('lesswrong.com')) {
        apiUrl = 'https://www.lesswrong.com/graphql';
      } else if (resource.url.includes('alignmentforum.org')) {
        apiUrl = 'https://www.alignmentforum.org/graphql';
      } else {
        apiUrl = 'https://forum.effectivealtruism.org/graphql';
      }

      const query = {
        query: `query { post(input: {selector: {_id: "${postId}"}}) { result { title postedAt } } }`
      };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'LongtermWikiValidator/1.0'
        },
        body: JSON.stringify(query)
      });

      if (response.ok) {
        const data = await response.json();
        const post = data?.data?.post?.result;

        if (!post) {
          issues.push({
            resource,
            type: 'forum_not_found',
            message: `Forum post not found: ${postId}`,
            url: resource.url
          });
        } else if (resource.title && post.title) {
          if (!titlesAreSimilar(resource.title, post.title)) {
            issues.push({
              resource,
              type: 'forum_title_mismatch',
              message: 'Forum post title mismatch',
              stored: resource.title,
              fetched: post.title
            });
          }
        }
      }

      await sleep(200); // Rate limit
    } catch (err) {
      // Ignore network errors
    }
  }

  console.log();
  return issues;
}

/**
 * Validate dates are sane (not in future, not too old, proper format)
 */
function validateDates(resources, opts) {
  const issues = [];
  const now = new Date();
  const minDate = new Date('1990-01-01'); // AI safety didn't exist before this
  const maxDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Allow 1 week into future for timezone issues

  for (const resource of resources) {
    const dateStr = resource.published_date || resource.date;
    if (!dateStr) continue;

    // Check format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      issues.push({
        resource,
        type: 'date_format',
        message: `Invalid date format: ${dateStr} (expected YYYY-MM-DD)`,
        url: resource.url
      });
      continue;
    }

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      issues.push({
        resource,
        type: 'date_invalid',
        message: `Invalid date: ${dateStr}`,
        url: resource.url
      });
      continue;
    }

    if (date > maxDate) {
      issues.push({
        resource,
        type: 'date_future',
        message: `Future date: ${dateStr}`,
        url: resource.url
      });
    }

    if (date < minDate) {
      issues.push({
        resource,
        type: 'date_ancient',
        message: `Suspiciously old date: ${dateStr}`,
        url: resource.url
      });
    }
  }

  console.log(`   Checked ${resources.filter(r => r.published_date || r.date).length} resources with dates`);
  return issues;
}

/**
 * Validate DOIs via CrossRef API
 */
async function validateDois(resources, opts) {
  const limit = opts.limit || 50;
  const verbose = opts.verbose;

  // Find resources with DOIs (in URL or doi field)
  // Exclude arXiv URLs which have similar patterns but aren't DOIs
  const doiResources = resources.filter(r => {
    if (r.url?.includes('arxiv.org')) return false; // arXiv IDs look like DOIs but aren't
    if (r.doi) return true;
    if (r.url?.includes('doi.org/')) return true;
    if (r.url?.match(/10\.\d{4,}\/[^\s]+/)) return true; // DOIs have format 10.XXXX/something
    return false;
  });
  console.log(`   Found ${doiResources.length} resources with DOIs`);

  const toCheck = doiResources.slice(0, limit);
  const issues = [];

  for (let i = 0; i < toCheck.length; i++) {
    const resource = toCheck[i];
    if ((i + 1) % 5 === 0) {
      process.stdout.write(`\r   Checking ${i + 1}/${toCheck.length}...`);
    }

    try {
      // Extract DOI
      let doi = resource.doi;
      if (!doi && resource.url) {
        const doiMatch = resource.url.match(/(10\.\d{4,}[^\s"<>]+)/);
        if (doiMatch) doi = doiMatch[1];
      }
      if (!doi) continue;

      // Query CrossRef
      const apiUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
      const response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'LongtermWikiValidator/1.0 (mailto:admin@example.com)' }
      });

      if (response.status === 404) {
        issues.push({
          resource,
          type: 'doi_not_found',
          message: `DOI not found: ${doi}`,
          url: resource.url
        });
      } else if (response.ok) {
        const data = await response.json();
        const work = data.message;

        // Check title match
        if (resource.title && work.title?.[0]) {
          if (!titlesAreSimilar(resource.title, work.title[0])) {
            issues.push({
              resource,
              type: 'doi_title_mismatch',
              message: 'DOI title mismatch',
              stored: resource.title,
              fetched: work.title[0]
            });
          }
        }
      }

      await sleep(100); // CrossRef asks for polite rate limiting
    } catch (err) {
      // Ignore network errors
    }
  }

  console.log();
  return issues;
}

async function cmdValidate(opts) {
  const source = opts._args?.[0] || 'all';
  const verbose = opts.verbose;
  const limit = opts.limit;

  console.log('🔍 Validating resource data\n');

  const resources = loadResources();
  console.log(`   Total resources: ${resources.length}\n`);

  const allIssues = [];

  if (source === 'arxiv' || source === 'all') {
    console.log('📚 Validating arXiv papers...');
    const arxivIssues = await validateArxiv(resources, opts);
    allIssues.push(...arxivIssues);
  }

  if (source === 'wikipedia' || source === 'all') {
    console.log('\n📖 Validating Wikipedia links...');
    const wikiIssues = await validateWikipedia(resources, opts);
    allIssues.push(...wikiIssues);
  }

  if (source === 'forums' || source === 'all') {
    console.log('\n💬 Validating forum posts...');
    const forumIssues = await validateForumPosts(resources, opts);
    allIssues.push(...forumIssues);
  }

  if (source === 'dates' || source === 'all') {
    console.log('\n📅 Validating dates...');
    const dateIssues = validateDates(resources, opts);
    allIssues.push(...dateIssues);
  }

  if (source === 'dois' || source === 'all') {
    console.log('\n🔬 Validating DOIs...');
    const doiIssues = await validateDois(resources, opts);
    allIssues.push(...doiIssues);
  }

  if (source === 'urls') {
    console.log('\n🔗 Checking for broken URLs...');
    const urlIssues = await validateUrls(resources, opts);
    allIssues.push(...urlIssues);
  }

  // Report
  console.log('\n' + '='.repeat(60));

  if (allIssues.length === 0) {
    console.log('\n✅ All resources validated successfully!');
  } else {
    console.log(`\n⚠️  Found ${allIssues.length} potential issues:\n`);

    // Group by type
    const byType = {};
    for (const issue of allIssues) {
      byType[issue.type] = byType[issue.type] || [];
      byType[issue.type].push(issue);
    }

    for (const [type, issues] of Object.entries(byType)) {
      console.log(`\n${type.toUpperCase()} (${issues.length}):`);
      for (const issue of issues.slice(0, verbose ? 100 : 10)) {
        console.log(`  - ${issue.message}`);
        if (issue.resource?.title) {
          console.log(`    Title: ${issue.resource.title.slice(0, 60)}...`);
        }
        if (issue.stored && issue.fetched) {
          console.log(`    Stored: "${issue.stored.slice(0, 50)}..."`);
          console.log(`    Actual: "${issue.fetched.slice(0, 50)}..."`);
        }
        console.log(`    URL: ${issue.resource?.url || issue.url}`);
      }
      if (!verbose && issues.length > 10) {
        console.log(`  ... and ${issues.length - 10} more`);
      }
    }

    process.exit(1);
  }
}

// ============ Utility ============

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ Help ============

function showHelp() {
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
  node tooling/resource-manager.mjs list --limit 20
  node tooling/resource-manager.mjs show bioweapons
  node tooling/resource-manager.mjs process economic-labor --apply
  node tooling/resource-manager.mjs metadata stats
  node tooling/resource-manager.mjs metadata arxiv --batch 50
  node tooling/resource-manager.mjs metadata all
  node tooling/resource-manager.mjs validate arxiv --limit 100
  node tooling/resource-manager.mjs validate all --verbose
  node tooling/resource-manager.mjs enrich
  node tooling/resource-manager.mjs rebuild-citations
`);
}

// ============ Main ============

const opts = parseArgs(process.argv.slice(2));

async function main() {
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

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
