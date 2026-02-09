/**
 * Sidebar Utilities
 *
 * Shared utilities for parsing and checking sidebar configuration from astro.config.mjs.
 * Used by validation engine and page-creator to ensure content is accessible in navigation.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

/**
 * Parse sidebar configuration from astro.config.mjs
 * @returns {{ entries: string[], directories: Set<string> }}
 */
export function parseSidebarConfig() {
  const configPath = join(PROJECT_ROOT, 'astro.config.mjs');
  if (!existsSync(configPath)) return { entries: [], directories: new Set() };

  try {
    const content = readFileSync(configPath, 'utf-8');
    const entries = [];
    const directories = new Set();

    // Extract slug entries
    const slugRegex = /slug:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = slugRegex.exec(content)) !== null) {
      entries.push(match[1]);
    }

    // Extract autogenerate directories
    const autoRegex = /autogenerate:\s*\{\s*directory:\s*['"]([^'"]+)['"]/g;
    while ((match = autoRegex.exec(content)) !== null) {
      directories.add(match[1]);
    }

    // Extract link entries
    const linkRegex = /link:\s*['"]([^'"]+)['"]/g;
    while ((match = linkRegex.exec(content)) !== null) {
      entries.push(match[1].replace(/^\//, '').replace(/\/$/, ''));
    }

    return { entries, directories };
  } catch {
    return { entries: [], directories: new Set() };
  }
}

/**
 * Get all autogenerate directory paths from sidebar config
 * @returns {string[]}
 */
export function getSidebarAutogeneratePaths() {
  const config = parseSidebarConfig();
  return [...config.directories];
}

/**
 * Check if a content path is covered by sidebar autogenerate
 * @param {string} contentPath - Path like "knowledge-base/people" or "knowledge-base/organizations/labs"
 * @returns {{ covered: boolean, matchedPath?: string, availablePaths?: string[] }}
 */
export function checkSidebarCoverage(contentPath) {
  const config = parseSidebarConfig();
  const autogeneratePaths = [...config.directories];

  // Normalize the destination path
  const normalizedPath = contentPath.replace(/^\/+/, '').replace(/\/+$/, '');

  // Check if this path or a parent is in autogenerate
  for (const autoPath of autogeneratePaths) {
    if (normalizedPath === autoPath || normalizedPath.startsWith(autoPath + '/')) {
      return { covered: true, matchedPath: autoPath };
    }
  }

  // Also check explicit entries
  const explicitEntries = config.entries;
  for (const entry of explicitEntries) {
    if (normalizedPath === entry || normalizedPath.startsWith(entry + '/') || entry.startsWith(normalizedPath + '/')) {
      return { covered: true, matchedPath: entry };
    }
  }

  return {
    covered: false,
    availablePaths: autogeneratePaths.filter(p => p.startsWith('knowledge-base/'))
  };
}

/**
 * Check if a new page at the given path would appear in the sidebar
 * @param {string} destPath - Destination directory path (e.g., "knowledge-base/people")
 * @returns {{ willAppear: boolean, reason: string, suggestions?: string[] }}
 */
export function checkNewPageVisibility(destPath) {
  const coverage = checkSidebarCoverage(destPath);

  if (coverage.covered) {
    return {
      willAppear: true,
      reason: `Covered by sidebar autogenerate: ${coverage.matchedPath}`
    };
  }

  return {
    willAppear: false,
    reason: `Path "${destPath}" is not covered by any sidebar autogenerate directive`,
    suggestions: coverage.availablePaths?.slice(0, 10) || []
  };
}

export default {
  parseSidebarConfig,
  getSidebarAutogeneratePaths,
  checkSidebarCoverage,
  checkNewPageVisibility
};
