/**
 * Canonical Frontmatter Field Ordering
 *
 * Defines the canonical order for MDX frontmatter fields to minimize
 * git merge conflicts. Stable "identity" fields come first; volatile
 * "metadata" and collection fields go last.
 *
 * New fields added by schema migrations should be appended at the bottom
 * (before the closing ---), so they occupy a different diff region from
 * commonly-edited fields like title, description, and lastEdited.
 *
 * See: https://github.com/quantified-uncertainty/longterm-wiki/issues/398
 */

/**
 * Canonical field order. Fields are grouped semantically:
 *
 * 1. Identity (rarely change)
 * 2. Structure / classification (rarely change)
 * 3. Quality & importance scores (change with grading)
 * 4. Temporal fields (change frequently)
 * 5. Summaries (change with content edits)
 * 6. Ratings block (change with grading)
 * 7. Collections & tags (volatile, often added by schema migrations)
 * 8. Misc / everything else (catch-all for unknown fields)
 */
export const FRONTMATTER_FIELD_ORDER: string[] = [
  // --- Group 1: Identity ---
  'numericId',
  'title',
  'description',

  // --- Group 2: Structure / classification ---
  'sidebar',
  'entityType',
  'subcategory',
  'pageType',
  'contentFormat',
  'pageTemplate',
  'draft',
  'fullWidth',

  // --- Group 3: Quality & importance scores ---
  'quality',
  'maturity',
  'readerImportance',
  'researchImportance',
  'tacticalValue',
  'tractability',
  'neglectedness',
  'uncertainty',
  'causalLevel',

  // --- Group 4: Temporal fields ---
  'lastEdited',
  'lastUpdated',
  'createdAt',
  'update_frequency',
  'evergreen',

  // --- Group 5: Summaries ---
  'llmSummary',
  'structuredSummary',

  // --- Group 6: Ratings ---
  'ratings',

  // --- Group 7: Collections & tags (volatile, migration-target zone) ---
  'clusters',
  'roles',
  'todos',
  'balanceFlags',

  // --- Group 8: Legacy / deprecated (kept last to avoid noise) ---
  'seeAlso',
  'todo',
  'entityId',

  // Starlight/Astro fields (rarely used)
  'template',
  'hero',
  'tableOfContents',
  'editUrl',
  'head',
  'prev',
  'next',
  'banner',
];

/**
 * Get the sort index for a frontmatter field.
 * Unknown fields get a high index so they sort to the end.
 */
export function getFieldSortIndex(field: string): number {
  const idx = FRONTMATTER_FIELD_ORDER.indexOf(field);
  // Unknown fields go after all known fields but before the very last group
  return idx === -1 ? FRONTMATTER_FIELD_ORDER.length : idx;
}

/**
 * Check whether a list of field names is in canonical order.
 * Returns the first pair of out-of-order fields, or null if all are in order.
 */
export function findFirstOutOfOrder(fields: string[]): { before: string; after: string } | null {
  for (let i = 1; i < fields.length; i++) {
    const prevIdx = getFieldSortIndex(fields[i - 1]);
    const currIdx = getFieldSortIndex(fields[i]);
    if (prevIdx > currIdx) {
      return { before: fields[i - 1], after: fields[i] };
    }
  }
  return null;
}

/**
 * Sort field names according to canonical order.
 * Unknown fields are sorted alphabetically among themselves at the end.
 */
export function sortFields(fields: string[]): string[] {
  return [...fields].sort((a, b) => {
    const aIdx = getFieldSortIndex(a);
    const bIdx = getFieldSortIndex(b);
    if (aIdx !== bIdx) return aIdx - bIdx;
    // Both unknown: sort alphabetically
    return a.localeCompare(b);
  });
}

/**
 * Reorder a frontmatter object's keys to canonical order.
 *
 * Use this when a code path modifies a parsed frontmatter object and then
 * re-serializes it with yaml.stringify(). JS object property order follows
 * insertion order, so newly added fields (e.g. tacticalValue from grading)
 * would otherwise end up at the bottom instead of their canonical position.
 *
 * Returns a new object with keys in canonical order.
 */
export function reorderFrontmatterObject<T extends Record<string, unknown>>(obj: T): T {
  const sorted = sortFields(Object.keys(obj));
  const result = {} as Record<string, unknown>;
  for (const key of sorted) {
    result[key] = obj[key];
  }
  return result as T;
}
