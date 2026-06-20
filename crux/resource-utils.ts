/**
 * Resource Manager — Shared Utilities
 *
 * URL normalization, link extraction, ID generation, type guessing, file finding.
 */

import { basename } from 'path';
import { createHash, randomBytes } from 'crypto';
import { normalizeUrl, hostMatches, hostHasLabel } from "@longterm-wiki/url-utils";
import { CONTENT_DIR_ABS as CONTENT_DIR } from './lib/content-types.ts';
import { findMdxFiles } from './lib/file-utils.ts';
import type { Resource, MarkdownLink } from './resource-types.ts';

export function hashId(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/** Generate a random 8-char hex ID for facts. */
export function generateFactId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Canonical lookup key for a resource URL: protocol-agnostic and trailing-slash
 * agnostic. Use this for both writing to and reading from a URL → resource map.
 */
export function resourceUrlKey(url: string): string {
  return normalizeUrl(url, { stripProtocol: true });
}

export function buildUrlToResourceMap(resources: Resource[]): Map<string, Resource> {
  const map = new Map<string, Resource>();
  for (const r of resources) {
    if (!r.url) continue;
    map.set(resourceUrlKey(r.url), r);
  }
  return map;
}

/** Look up a resource by URL using the canonical key normalization. */
export function lookupResourceByUrl(
  map: Map<string, Resource>,
  url: string,
): Resource | undefined {
  return map.get(resourceUrlKey(url));
}

export function extractMarkdownLinks(content: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const linkRegex = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(content)) !== null) {
    const [full, text, url] = match;
    links.push({ text, url, full, index: match.index });
  }
  return links;
}

export function findFileByName(name: string): string | null {
  const allFiles = findMdxFiles(CONTENT_DIR);
  // Try exact match first
  let match = allFiles.find(f => basename(f, '.mdx') === name);
  if (match) return match;
  // Try partial match
  match = allFiles.find(f => f.includes(name));
  return match || null;
}

/** Check whether a URL points to YouTube (youtube.com or youtu.be). */
export function isYoutubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

export function guessResourceType(url: string): string {
  const domain = new URL(url).hostname.toLowerCase();
  if (hostMatches(domain, 'arxiv.org')) return 'paper';
  if (hostMatches(domain, 'nature.com') || hostMatches(domain, 'science.org')) return 'paper';
  if (hostMatches(domain, 'springer.com') || hostMatches(domain, 'wiley.com')) return 'paper';
  if (hostMatches(domain, 'ncbi.nlm.nih.gov') || hostHasLabel(domain, 'pubmed')) return 'paper';
  if (hostHasLabel(domain, 'gov') || hostHasLabel(domain, 'government')) return 'government';
  if (hostMatches(domain, 'wikipedia.org')) return 'reference';
  if (hostMatches(domain, 'grokipedia.com')) return 'reference';
  if (isYoutubeUrl(url)) return 'talk';
  if (hostHasLabel(domain, 'podcast') || hostHasLabel(domain, 'podcasts') || hostMatches(domain, 'spotify.com')) return 'podcast';
  if (hostMatches(domain, 'substack.com') || hostMatches(domain, 'medium.com')) return 'blog';
  if (hostMatches(domain, 'forum.effectivealtruism.org')) return 'blog';
  if (hostMatches(domain, 'lesswrong.com') || hostMatches(domain, 'alignmentforum.org')) return 'blog';
  return 'web';
}

/**
 * Extract ArXiv ID from URL
 */
export function extractArxivId(url: string): string | null {
  const patterns: RegExp[] = [
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
 * Extract forum post slug
 */
export function extractForumSlug(url: string): string | null {
  const match = url.match(/(?:lesswrong\.com|alignmentforum\.org|forum\.effectivealtruism\.org)\/posts\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Extract DOI from URL
 */
export function extractDOI(url: string): string | null {
  const patterns: RegExp[] = [
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
 * Check if URL could have Semantic Scholar data
 */
export function isScholarlyUrl(url: string): boolean {
  const scholarlyDomains = [
    'nature.com', 'science.org', 'springer.com', 'wiley.com',
    'sciencedirect.com', 'plos.org', 'pnas.org', 'cell.com',
    'ncbi.nlm.nih.gov', 'pubmed', 'doi.org', 'ssrn.com',
    'aeaweb.org', 'jstor.org', 'tandfonline.com'
  ];
  return scholarlyDomains.some(d => url.includes(d));
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
