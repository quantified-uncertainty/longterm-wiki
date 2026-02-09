/**
 * Frontmatter Scanner
 *
 * Scans MDX files for entityType declarations in frontmatter.
 * Auto-creates minimal entity objects for pages that declare entityType
 * but don't have a corresponding YAML entity entry.
 *
 * Used by build-data.mjs to discover entities declared only in MDX frontmatter.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { parse } from 'yaml';

/**
 * Extract frontmatter from MDX/MD content using YAML parser.
 */
function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  try {
    return parse(match[1]) || {};
  } catch (e) {
    return {};
  }
}

/**
 * Scan MDX frontmatter for entityType declarations.
 * Returns array of auto-entity objects for pages that declare entityType
 * but don't have a corresponding YAML entity.
 *
 * @param {Set<string>} yamlEntityIds - Set of entity IDs already defined in YAML
 * @param {string} contentDir - Path to the content directory (e.g., ../content/docs)
 * @returns {Array<Object>} Auto-created entity objects
 */
export function scanFrontmatterEntities(yamlEntityIds, contentDir) {
  const autoEntities = [];

  function scanDir(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        scanDir(fullPath);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        const ext = entry.endsWith('.mdx') ? '.mdx' : '.md';
        const id = basename(entry, ext);
        if (id === 'index') continue;

        const content = readFileSync(fullPath, 'utf-8');
        const fm = extractFrontmatter(content);

        // Use entityId override if present, otherwise filename
        const entityId = fm.entityId || id;
        if (yamlEntityIds.has(entityId)) continue; // YAML entity takes precedence

        if (fm.entityType) {
          autoEntities.push({
            id: entityId,
            type: fm.entityType,
            title: fm.title || id.replace(/-/g, ' '),
            _source: 'frontmatter',
          });
        }
      }
    }
  }

  scanDir(join(contentDir, 'knowledge-base'));
  for (const topDir of ['ai-transition-model', 'analysis']) {
    scanDir(join(contentDir, topDir));
  }

  return autoEntities;
}
