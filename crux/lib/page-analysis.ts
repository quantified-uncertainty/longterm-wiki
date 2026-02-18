/**
 * Shared Page Analysis Utilities
 *
 * Common functions used by validation rules and analysis scripts for
 * counting prose words, classifying page entity types by path, and
 * counting citations.
 *
 * Extracted to avoid duplication across citation-density, balance-flags,
 * footnote-coverage, and validate-hallucination-risk.
 */

// ---------------------------------------------------------------------------
// Prose word counting
// ---------------------------------------------------------------------------

/**
 * Count words in body text, excluding code blocks, imports, JSX components,
 * table rows, horizontal rules, and footnote definitions.
 */
export function countProseWords(body: string): number {
  let inCodeBlock = false;
  let wordCount = 0;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (trimmed.startsWith('import ')) continue;
    if (trimmed.startsWith('<')) continue;
    if (trimmed.startsWith('|')) continue;
    if (trimmed === '---') continue;
    if (/^\[\^\d+\]:/.test(trimmed)) continue;

    wordCount += trimmed.split(/\s+/).filter(w => w.length > 0).length;
  }

  return wordCount;
}

// ---------------------------------------------------------------------------
// Entity type classification
// ---------------------------------------------------------------------------

/**
 * Map a content-relative page path to an entity type key.
 * Returns null for pages not in a recognized directory.
 */
export function getEntityTypeFromPath(relativePath: string): string | null {
  if (relativePath.includes('/people/')) return 'person';
  if (relativePath.includes('/organizations/')) return 'organization';
  if (relativePath.includes('/history/')) return 'historical';
  if (relativePath.includes('/risks/')) return 'risk';
  if (relativePath.includes('/responses/')) return 'response';
  if (relativePath.includes('/models/')) return 'model';
  if (relativePath.includes('/capabilities/')) return 'concept';
  if (relativePath.includes('/metrics/')) return 'metric';
  if (relativePath.includes('/debates/')) return 'debate';
  if (relativePath.includes('/cruxes/')) return 'crux';
  if (relativePath.includes('/intelligence-paradigms/')) return 'concept';
  if (relativePath.includes('/forecasting/')) return 'concept';
  if (relativePath.includes('/worldviews/')) return 'overview';
  return null;
}
