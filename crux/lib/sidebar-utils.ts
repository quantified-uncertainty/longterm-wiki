/**
 * Sidebar Utilities
 *
 * In the Next.js app, sidebar navigation is managed by app/src/lib/wiki-nav.ts
 * and the WikiSidebar component. There is no static config file to parse.
 *
 * These functions return empty data so that downstream consumers
 * (validation-engine, sidebar-coverage rule) continue to work without errors.
 */

export interface SidebarParseResult {
  entries: string[];
  directories: Set<string>;
}

/**
 * Parse sidebar configuration.
 * Returns empty data — sidebar is now driven by wiki-nav.ts in the Next.js app.
 */
export function parseSidebarConfig(): SidebarParseResult {
  return { entries: [], directories: new Set() };
}

export default {
  parseSidebarConfig,
};
