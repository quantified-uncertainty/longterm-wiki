/**
 * Shared HTML-to-text utilities used across the fetch pipeline.
 *
 * Combines main-content scoping (from sourcing) with structural
 * newline preservation (from search) into a single implementation.
 */

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/**
 * Apply `re` repeatedly until the string stops changing. Single-pass
 * `.replace()` can leave a fresh match behind when removing one match splices
 * two fragments into a new tag (e.g. `<scr<script>ipt>`), so sanitization that
 * removes markup must run to a fixed point.
 */
function replaceUntilStable(re: RegExp, input: string, replacement: string): string {
  let prev: string;
  let out = input;
  do {
    prev = out;
    out = out.replace(re, replacement);
  } while (out !== prev);
  return out;
}

/**
 * Decode the HTML entities that show up in page text.
 *
 * `&amp;` is decoded LAST so inputs like `&amp;lt;` round-trip to the literal
 * `&lt;` instead of being double-unescaped to `<`. Numeric and hex entities are
 * handled generically.
 */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/**
 * Try to extract the main content area from an HTML page.
 * Returns the inner HTML of <main>, <article>, or role="main" element,
 * or null if none found (content must be > 200 chars to qualify).
 */
export function extractMainContent(html: string): string | null {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main\s*>/i);
  if (mainMatch && mainMatch[1].length > 200) return mainMatch[1];

  const roleMainMatch = html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+\s*>/i);
  if (roleMainMatch && roleMainMatch[1].length > 200) return roleMainMatch[1];

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article\s*>/i);
  if (articleMatch && articleMatch[1].length > 200) return articleMatch[1];

  return null;
}

/**
 * Strip HTML tags and entities from raw HTML, returning plain text.
 * Prioritizes <main>, <article>, or role="main" content to avoid
 * nav/header/footer pollution. Preserves paragraph structure via newlines.
 */
export function htmlToText(html: string): string {
  let text = extractMainContent(html) ?? html;

  // Remove whole non-content blocks (content included) to a fixed point.
  // Closing tags tolerate whitespace (`</script >`) so they can't be bypassed.
  for (const tag of ["script", "style", "nav", "header", "footer", "aside"]) {
    text = replaceUntilStable(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), text, "");
  }

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<\/li\s*>/gi, "\n");

  // Strip any remaining tags to a fixed point so spliced-together angle
  // brackets can't re-form a tag.
  text = replaceUntilStable(/<[^>]+>/g, text, " ");

  return decodeHtmlEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the <title> text from an HTML document.
 */
export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!m) return "";
  return decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
}
