/**
 * Unconverted Link Detection
 *
 * Detects markdown links in content that have matching resources in the database,
 * meaning they could be converted to <R> component references.
 *
 * Extracted from build-data.mjs for modularity.
 */

import { normalizeUrl } from "@longterm-wiki/url-utils";

/** Canonical lookup key for a resource URL — protocol+slash agnostic. */
function urlKey(url) {
  return normalizeUrl(url, { stripProtocol: true });
}

/**
 * Build URL → resource map from resources
 */
export function buildUrlToResourceMap(resources) {
  const urlToResource = new Map();
  for (const r of resources) {
    if (!r.url) continue;
    urlToResource.set(urlKey(r.url), r);
  }
  return urlToResource;
}

/**
 * Extract markdown links from content (not images, not internal, not <R> components)
 */
function extractMarkdownLinks(content) {
  const links = [];
  // Match [text](url) but not images ![text](url)
  const linkRegex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const [full, text, url] = match;
    // Skip internal links, anchors, mailto
    if (url.startsWith('/') || url.startsWith('#') || url.startsWith('mailto:')) continue;
    links.push({ text, url });
  }
  return links;
}

/**
 * Find unconverted links in content (markdown links that have matching resources)
 */
export function findUnconvertedLinks(content, urlToResource) {
  const links = extractMarkdownLinks(content);
  const unconverted = [];

  for (const link of links) {
    const resource = urlToResource.get(urlKey(link.url));
    if (resource) {
      unconverted.push({
        text: link.text,
        url: link.url,
        resourceId: resource.id,
        resourceTitle: resource.title,
      });
    }
  }

  return unconverted;
}

/**
 * Count <R> component usages in content (already converted links)
 */
export function countConvertedLinks(content) {
  // Match <R id="..."> or <R id="...">...</R>
  const rComponentRegex = /<R\s+id=/g;
  const matches = content.match(rComponentRegex);
  return matches ? matches.length : 0;
}
