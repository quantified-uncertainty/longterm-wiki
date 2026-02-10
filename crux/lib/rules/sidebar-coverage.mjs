/**
 * Rule: Sidebar Coverage
 *
 * Checks that all content directories have representation in the sidebar.
 * This catches orphaned sections that exist in the filesystem but aren't
 * accessible to users through navigation.
 *
 * This is a global rule that operates on all content at once.
 */

import { createRule, Issue, Severity } from '../validation-engine.js';
import { dirname } from 'path';

export const sidebarCoverageRule = createRule({
  id: 'sidebar-coverage',
  name: 'Sidebar Coverage',
  description: 'Verify all content directories are accessible from sidebar',
  scope: 'global',

  check(files, engine) {
    const issues = [];

    // Get all unique directories from content
    const contentDirs = new Set();
    for (const file of files) {
      // Get the top-level section directory (e.g., "knowledge-base/risks")
      const parts = file.relativePath.split('/');
      if (parts.length >= 2) {
        // Add first two levels (e.g., "knowledge-base/risks", "knowledge-base/responses")
        contentDirs.add(parts.slice(0, 2).join('/'));
      }
      if (parts.length >= 3) {
        // Add third level too for deeper sections
        contentDirs.add(parts.slice(0, 3).join('/'));
      }
    }

    // Check which directories are in sidebar
    const sidebarDirs = engine.sidebarConfig?.directories || new Set();
    const sidebarEntries = engine.sidebarConfig?.entries || [];

    // Convert entries to directories for comparison
    const sidebarPaths = new Set([
      ...sidebarDirs,
      ...sidebarEntries.map(e => dirname(e)).filter(d => d !== '.'),
    ]);

    // Find directories not in sidebar
    for (const dir of contentDirs) {
      // Skip some known non-sidebar directories
      if (dir === 'internal' || dir.startsWith('internal/')) continue;
      if (dir === 'diagrams' || dir.startsWith('diagrams/')) continue;

      // Check if this directory or a parent is in sidebar
      const isInSidebar = [...sidebarPaths].some(sidebarPath =>
        dir === sidebarPath ||
        dir.startsWith(sidebarPath + '/') ||
        sidebarPath.startsWith(dir + '/')
      );

      // Also check direct slug entries
      const hasSlugEntry = sidebarEntries.some(entry =>
        entry === dir ||
        entry.startsWith(dir + '/') ||
        dir.startsWith(entry + '/')
      );

      if (!isInSidebar && !hasSlugEntry) {
        // Count files in this directory
        const filesInDir = files.filter(f => f.relativePath.startsWith(dir + '/'));

        if (filesInDir.length > 0) {
          issues.push(new Issue({
            rule: this.id,
            file: `content/docs/${dir}/`,
            message: `Directory "${dir}" has ${filesInDir.length} file(s) but is not in sidebar - users cannot discover this content`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
});

export default sidebarCoverageRule;
