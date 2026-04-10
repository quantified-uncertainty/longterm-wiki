/**
 * Shared HTML-to-text utilities used across the fetch pipeline.
 *
 * Combines main-content scoping (from source-check) with structural
 * newline preservation (from search) into a single implementation.
 */

/**
 * Try to extract the main content area from an HTML page.
 * Returns the inner HTML of <main>, <article>, or role="main" element,
 * or null if none found (content must be > 200 chars to qualify).
 */
export function extractMainContent(html: string): string | null {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch && mainMatch[1].length > 200) return mainMatch[1];

  const roleMainMatch = html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i);
  if (roleMainMatch && roleMainMatch[1].length > 200) return roleMainMatch[1];

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].length > 200) return articleMatch[1];

  return null;
}

/**
 * Strip HTML tags and entities from raw HTML, returning plain text.
 * Prioritizes <main>, <article>, or role="main" content to avoid
 * nav/header/footer pollution. Preserves paragraph structure via newlines.
 */
export function htmlToText(html: string): string {
  const bodyContent = extractMainContent(html) ?? html;

  return bodyContent
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the <title> text from an HTML document.
 */
export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
