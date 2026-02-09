/**
 * File Utilities for Scripts
 *
 * Common file discovery and traversal functions used across validators and generators.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Find all MDX/MD files recursively in a directory
 * @param {string} dir - Directory to search
 * @param {string[]} results - Accumulator for results (internal use)
 * @returns {string[]} Array of file paths
 */
export function findMdxFiles(dir, results = []) {
  if (!existsSync(dir)) return results;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        findMdxFiles(filePath, results);
      } else if (file.endsWith('.mdx') || file.endsWith('.md')) {
        results.push(filePath);
      }
    }
  } catch {
    // Skip directories that can't be read (permissions, etc.)
  }
  return results;
}

/**
 * Find files matching specific extensions recursively
 * @param {string} dir - Directory to search
 * @param {string[]} extensions - Array of extensions to match (e.g., ['.yaml', '.yml'])
 * @param {string[]} results - Accumulator for results (internal use)
 * @returns {string[]} Array of file paths
 */
export function findFiles(dir, extensions, results = []) {
  if (!existsSync(dir)) return results;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        findFiles(filePath, extensions, results);
      } else if (extensions.some(ext => file.endsWith(ext))) {
        results.push(filePath);
      }
    }
  } catch {
    // Skip directories that can't be read
  }
  return results;
}

/**
 * Walk a directory tree, calling a callback for each file
 * @param {string} dir - Directory to walk
 * @param {function} callback - Called with (filePath, stat) for each file
 */
export function walkDirectory(dir, callback) {
  if (!existsSync(dir)) return;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        walkDirectory(filePath, callback);
      } else {
        callback(filePath, stat);
      }
    }
  } catch {
    // Skip directories that can't be read
  }
}

/**
 * Get all directories in a path (non-recursive)
 * @param {string} dir - Directory to list
 * @returns {string[]} Array of directory paths
 */
export function getDirectories(dir) {
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .map(file => join(dir, file))
      .filter(path => statSync(path).isDirectory());
  } catch {
    return [];
  }
}
