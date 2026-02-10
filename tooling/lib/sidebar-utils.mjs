/**
 * Sidebar Utilities
 *
 * In the Next.js app, sidebar navigation is managed by app/src/lib/wiki-nav.ts
 * and the WikiSidebar component. There is no static config file to parse.
 *
 * These functions return empty data so that downstream consumers
 * (validation-engine, sidebar-coverage rule) continue to work without errors.
 */

/**
 * Parse sidebar configuration.
 * Returns empty data — sidebar is now driven by wiki-nav.ts in the Next.js app.
 * @returns {{ entries: string[], directories: Set<string> }}
 */
export function parseSidebarConfig() {
  return { entries: [], directories: new Set() };
}

/**
 * Get all autogenerate directory paths from sidebar config.
 * Returns empty — not applicable in Next.js.
 * @returns {string[]}
 */
export function getSidebarAutogeneratePaths() {
  return [];
}

/**
 * Check if a content path is covered by sidebar navigation.
 * Always returns not-covered — sidebar coverage checking is not applicable in Next.js.
 * @param {string} contentPath
 * @returns {{ covered: boolean, availablePaths?: string[] }}
 */
export function checkSidebarCoverage(contentPath) {
  return { covered: false, availablePaths: [] };
}

/**
 * Check if a new page at the given path would appear in the sidebar.
 * Always returns unknown — sidebar visibility is managed by wiki-nav.ts.
 * @param {string} destPath
 * @returns {{ willAppear: boolean, reason: string }}
 */
export function checkNewPageVisibility(destPath) {
  return {
    willAppear: false,
    reason: 'Sidebar visibility is managed by wiki-nav.ts in the Next.js app',
  };
}

export default {
  parseSidebarConfig,
  getSidebarAutogeneratePaths,
  checkSidebarCoverage,
  checkNewPageVisibility
};
