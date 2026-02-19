/**
 * Unconverted Link Detection
 *
 * Detects markdown links in content that have matching resources in the database,
 * meaning they could be converted to <R> component references.
 *
 * Extracted from build-data.mjs for modularity.
 */

/**
 * Normalize URL to handle variations (trailing slashes, www prefix, http/https)
 */
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

/**
 * Build URL → resource map from resources
 */
export function buildUrlToResourceMap(resources) {
  const urlToResource = new Map();
  for (const r of resources) {
    if (!r.url) continue;
    const normalizedUrls = normalizeUrl(r.url);
    for (const url of normalizedUrls) {
      urlToResource.set(url, r);
    }
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
    const resource = urlToResource.get(link.url) || urlToResource.get(link.url.replace(/\/$/, ''));
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
