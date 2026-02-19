/**
 * Text Utilities for Build Pipeline
 *
 * Shared functions for extracting and formatting text from
 * entity content fields (intros, descriptions, etc.).
 */

/**
 * Strip markup (JSX/HTML tags, markdown links, bold/italic markers) from text.
 *
 * @param {string} text - Raw text potentially containing markup
 * @returns {string} Plain text without markup
 */
export function stripMarkup(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')                 // Strip JSX/HTML tags
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Strip markdown links (keep text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // Strip bold markers
    .replace(/\*([^*]+)\*/g, '$1')           // Strip italic markers
    .trim();
}

/**
 * Extract a description-length first sentence from entity content intro.
 * Strips markup, splits on sentence boundaries, truncates to 157 chars.
 *
 * @param {string} intro - Raw intro text (may contain markup)
 * @returns {string|null} Plain text first sentence, or null if too short
 */
export function extractDescriptionFromIntro(intro) {
  if (!intro) return null;

  const text = stripMarkup(intro);
  const firstSentence = text.split(/\.\s|\n\n/)[0]?.trim();

  if (!firstSentence || firstSentence.length < 10) return null;

  if (firstSentence.length > 157) {
    return firstSentence.slice(0, 157) + '...';
  }
  return firstSentence + (firstSentence.endsWith('.') ? '' : '.');
}
