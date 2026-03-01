/**
 * Git Date Utilities
 *
 * Pure functions for processing git-based date maps, including
 * bulk-import detection and dateCreated fallback chain logic.
 */

/**
 * Threshold for bulk-import detection: if more than this many files share the
 * same git-created date, that date is treated as a bulk import/restructure and
 * discarded from gitCreatedMap so it doesn't produce misleading dateCreated
 * values. Individual files with legitimate creation dates are unaffected.
 */
export const BULK_IMPORT_THRESHOLD = 50;

/**
 * Filter out bulk-import dates from a gitCreatedMap.
 *
 * If more than BULK_IMPORT_THRESHOLD files share the same git-created date,
 * those entries are removed. This prevents mass restructures (e.g. an import
 * that touched 650 files) from giving every page an identical, meaningless
 * creation date.
 *
 * @param {Map<string, string>} gitCreatedMap - Map of file path → YYYY-MM-DD
 * @param {number} [threshold] - Override default threshold (for testing)
 * @returns {{ filtered: Map<string, string>, discardedDates: Array<{ date: string, fileCount: number }> }}
 */
export function filterBulkImportDates(gitCreatedMap, threshold = BULK_IMPORT_THRESHOLD) {
  // Count how many files share each created date
  const dateFileCounts = new Map();
  for (const date of gitCreatedMap.values()) {
    dateFileCounts.set(date, (dateFileCounts.get(date) || 0) + 1);
  }

  // Identify bulk-import dates
  const discardedDates = [];
  for (const [date, fileCount] of dateFileCounts) {
    if (fileCount > threshold) {
      discardedDates.push({ date, fileCount });
    }
  }

  if (discardedDates.length === 0) {
    return { filtered: new Map(gitCreatedMap), discardedDates: [] };
  }

  // Filter out entries with bulk-import dates
  const bulkDateSet = new Set(discardedDates.map(b => b.date));
  const filtered = new Map();
  for (const [filePath, date] of gitCreatedMap) {
    if (!bulkDateSet.has(date)) {
      filtered.set(filePath, date);
    }
  }

  return { filtered, discardedDates };
}

/**
 * Resolve the dateCreated value for a page using the standard fallback chain:
 *
 * 1. Frontmatter `createdAt` (explicit, highest priority)
 * 2. Git first-commit date (with bulk-import dates already filtered)
 * 3. Earliest edit-log date from wiki-server
 * 4. Frontmatter `dateCreated` (legacy field)
 * 5. null (honest about missing data)
 *
 * @param {object} options
 * @param {string|null} options.fmCreatedAt - frontmatter createdAt value
 * @param {string|null} options.gitCreatedDate - git first-commit date (already filtered for bulk imports)
 * @param {string|null} options.earliestEditLogDate - earliest edit log from wiki-server
 * @param {string|null} options.fmDateCreated - legacy frontmatter dateCreated value
 * @returns {string|null}
 */
export function resolveDateCreated({ fmCreatedAt, gitCreatedDate, earliestEditLogDate, fmDateCreated }) {
  return fmCreatedAt || gitCreatedDate || earliestEditLogDate || fmDateCreated || null;
}
