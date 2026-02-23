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

/**
 * Get the page type, preferring entityType when available, falling back to
 * path-based detection. Returns 'concept' as default.
 */
export function getPageType(page: { path: string; entityType?: string }): string {
  return page.entityType || getEntityTypeFromPath(page.path) || 'concept';
}

/**
 * Check if a page is biographical (person or organization).
 * Use this instead of duplicating path.includes('/people/') checks.
 */
export function isBiographicalPage(page: { path: string; entityType?: string }): boolean {
  const type = getPageType(page);
  return type === 'person' || type === 'organization';
}

// ---------------------------------------------------------------------------
// Page type standard data — what data is expected per page type
// ---------------------------------------------------------------------------

/**
 * Standard data expectations per page type, used by adversarial review
 * and quality checks to flag missing information.
 */
export const PAGE_TYPE_STANDARD_DATA: Record<string, string[]> = {
  person: ['birth year or estimated age', 'institutional affiliation', 'key publications or positions', 'educational background'],
  organization: ['founding year', 'funding sources or budget', 'staff size or key personnel', 'primary mission statement'],
  incident: ['date and timeline of events', 'actors involved', 'community reception metrics (upvotes, comments)', 'resolution or outcome'],
  concept: ['formal definition with citation', 'key proponents', 'examples or applications', 'criticisms or limitations'],
  research: ['primary finding with sample size or confidence interval', 'authors and institution', 'replication status', 'key limitation'],
};

/**
 * Get the standard data expectations for a page type as a comma-separated string.
 * Falls back to concept expectations for unknown types.
 */
export function getPageTypeStandardData(page: { path: string; entityType?: string }): string {
  const type = getPageType(page);
  const data = PAGE_TYPE_STANDARD_DATA[type] || PAGE_TYPE_STANDARD_DATA.concept;
  return data.join(', ');
}
