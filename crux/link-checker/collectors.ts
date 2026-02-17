/**
 * URL collectors — extract URLs from various wiki data sources.
 *
 * Covers: resource YAML files, external-links.yaml, and MDX content.
 */

import { readFileSync, existsSync } from 'fs';
import { relative } from 'path';
import { parse as parseYaml } from 'yaml';
import { CONTENT_DIR_ABS, DATA_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { loadResources } from '../resource-io.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { isInCodeBlock } from '../lib/mdx-utils.ts';
import type { UrlEntry, UrlSource } from './types.ts';
import { join } from 'path';

const EXTERNAL_LINKS_FILE = join(DATA_DIR_ABS, 'external-links.yaml');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if a URL looks truncated (unbalanced parentheses from markdown parsing).
 */
function isTruncatedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const openParens = (path.match(/\(/g) || []).length;
    const closeParens = (path.match(/\)/g) || []).length;
    return openParens > closeParens;
  } catch {
    return true;
  }
}

/**
 * Extract URLs from MDX body content (markdown links, bare URLs, HTML hrefs, footnotes).
 */
function extractUrlsFromContent(body: string): Array<{ url: string; line: number; text: string }> {
  const urls: Array<{ url: string; line: number; text: string }> = [];

  const mdLinkRegex = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  const bareUrlRegex = /(?<!\[)\b(https?:\/\/[^\s<>"\])}]+)/g;
  const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/g;
  const footnoteUrlRegex = /\[\^[^\]]+\]:\s*(?:\[[^\]]*\]\()?(https?:\/\/[^\s)]+)/g;

  const lines = body.split('\n');
  let position = 0;

  const markdownLinkUrls = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!isInCodeBlock(body, position)) {
      let match: RegExpExecArray | null;

      mdLinkRegex.lastIndex = 0;
      while ((match = mdLinkRegex.exec(line)) !== null) {
        urls.push({ url: match[2], line: i + 1, text: match[1] });
        markdownLinkUrls.add(match[2]);
      }

      bareUrlRegex.lastIndex = 0;
      while ((match = bareUrlRegex.exec(line)) !== null) {
        if (!markdownLinkUrls.has(match[1])) {
          urls.push({ url: match[1], line: i + 1, text: '' });
        }
      }

      hrefRegex.lastIndex = 0;
      while ((match = hrefRegex.exec(line)) !== null) {
        urls.push({ url: match[1], line: i + 1, text: '' });
      }

      footnoteUrlRegex.lastIndex = 0;
      while ((match = footnoteUrlRegex.exec(line)) !== null) {
        urls.push({ url: match[1], line: i + 1, text: 'footnote' });
      }
    }

    position += line.length + 1;
  }

  return urls;
}

// ── Source Collectors ─────────────────────────────────────────────────────────

/** Extract URLs from resource YAML files (data/resources/*.yaml). */
export function collectResourceUrls(): UrlEntry[] {
  const entries = new Map<string, UrlEntry>();

  const resources = loadResources();
  for (const r of resources) {
    if (!r.url) continue;
    const url = r.url.trim();
    if (!url.startsWith('http')) continue;

    const source: UrlSource = {
      file: `data/resources/${r._sourceFile || 'unknown'}.yaml`,
      context: r.title,
    };

    if (entries.has(url)) {
      entries.get(url)!.sources.push(source);
    } else {
      entries.set(url, { url, sources: [source] });
    }
  }

  return Array.from(entries.values());
}

/** Extract URLs from data/external-links.yaml. */
export function collectExternalLinkUrls(): UrlEntry[] {
  const entries = new Map<string, UrlEntry>();

  if (!existsSync(EXTERNAL_LINKS_FILE)) return [];

  try {
    const content = readFileSync(EXTERNAL_LINKS_FILE, 'utf-8');
    const data = parseYaml(content) as Array<{ pageId: string; links: Record<string, string> }>;

    if (!Array.isArray(data)) return [];

    for (const entry of data) {
      if (!entry.links) continue;
      for (const [linkType, url] of Object.entries(entry.links)) {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;

        const source: UrlSource = {
          file: 'data/external-links.yaml',
          context: `${entry.pageId} (${linkType})`,
        };

        if (entries.has(url)) {
          entries.get(url)!.sources.push(source);
        } else {
          entries.set(url, { url, sources: [source] });
        }
      }
    }
  } catch {
    console.error('  Warning: Could not parse external-links.yaml');
  }

  return Array.from(entries.values());
}

/** Extract URLs from MDX content files. */
export function collectContentUrls(): UrlEntry[] {
  const entries = new Map<string, UrlEntry>();

  const mdxFiles = findMdxFiles(CONTENT_DIR_ABS);

  for (const filePath of mdxFiles) {
    if (filePath.includes('/internal/')) continue;

    const content = readFileSync(filePath, 'utf-8');
    const relPath = relative(PROJECT_ROOT, filePath);

    const extracted = extractUrlsFromContent(content);
    for (const { url, line, text } of extracted) {
      const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
      if (!cleanUrl.startsWith('http')) continue;
      if (isTruncatedUrl(cleanUrl)) continue;

      const source: UrlSource = {
        file: relPath,
        line,
        context: text,
      };

      if (entries.has(cleanUrl)) {
        entries.get(cleanUrl)!.sources.push(source);
      } else {
        entries.set(cleanUrl, { url: cleanUrl, sources: [source] });
      }
    }
  }

  return Array.from(entries.values());
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Collect all URLs from specified sources, deduplicating by URL. */
export function collectAllUrls(source: string): UrlEntry[] {
  const allEntries = new Map<string, UrlEntry>();

  function mergeEntries(entries: UrlEntry[]): void {
    for (const entry of entries) {
      if (allEntries.has(entry.url)) {
        allEntries.get(entry.url)!.sources.push(...entry.sources);
      } else {
        allEntries.set(entry.url, { ...entry });
      }
    }
  }

  if (source === 'all' || source === 'resources') {
    console.log('  Collecting URLs from resource YAML files...');
    const resourceUrls = collectResourceUrls();
    console.log(`    Found ${resourceUrls.length} unique URLs in resources`);
    mergeEntries(resourceUrls);
  }

  if (source === 'all' || source === 'external') {
    console.log('  Collecting URLs from external-links.yaml...');
    const externalUrls = collectExternalLinkUrls();
    console.log(`    Found ${externalUrls.length} unique URLs in external-links.yaml`);
    mergeEntries(externalUrls);
  }

  if (source === 'all' || source === 'content') {
    console.log('  Collecting URLs from MDX content...');
    const contentUrls = collectContentUrls();
    console.log(`    Found ${contentUrls.length} unique URLs in MDX content`);
    mergeEntries(contentUrls);
  }

  return Array.from(allEntries.values());
}
