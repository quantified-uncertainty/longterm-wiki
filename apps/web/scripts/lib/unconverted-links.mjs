/**
 * Unconverted Link Detection
 *
 * Detects markdown links in content that have matching resources in the database,
 * meaning they could be converted to <R> component references.
 *
 * Extracted from build-data.mjs for modularity.
 */

// Re-export the canonical resource-URL helpers from crux so this module and
// build-data.mjs share a single source of truth (build-data.mjs runs under
// tsx/esm, so importing .ts is fine).
import { resourceUrlKey, buildUrlToResourceMap, lookupResourceByUrl } from "../../../../crux/resource-utils.ts";
export { resourceUrlKey as urlKey, buildUrlToResourceMap, lookupResourceByUrl };

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
    const resource = lookupResourceByUrl(urlToResource, link.url);
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
