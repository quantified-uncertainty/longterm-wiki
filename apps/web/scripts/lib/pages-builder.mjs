/**
 * Pages Registry Builder
 *
 * Scans MDX files, extracts frontmatter, computes page metrics, resolves dates,
 * and builds the path registry. Also includes the hallucination risk wrapper.
 *
 * Extracted from build-data.mjs for modularity.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, relative } from 'path';
import { parse } from 'yaml';
import { extractMetrics, suggestQuality } from '../../../../crux/lib/metrics-extractor.ts';
import { computeHallucinationRisk as computeCanonicalRisk, resolveEntityType } from '../../../../crux/lib/hallucination-risk.ts';
import { findUnconvertedLinks, countConvertedLinks } from './unconverted-links.mjs';
import { CONTENT_DIR, DATA_DIR, REPO_ROOT, TOP_LEVEL_CONTENT_DIRS } from './content-types.mjs';
import { buildRatingsFromAssessment } from './wiki-server-data.mjs';

/**
 * Normalize a YAML date value (string or Date object) to a YYYY-MM-DD string.
 * Returns null if the value is falsy.
 */
export function toDateString(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val);
}

/**
 * Extract PR number from a URL like "https://github.com/.../pull/123".
 */
export function extractPrNumber(prUrl) {
  if (!prUrl) return undefined;
  if (typeof prUrl === 'number') return prUrl;
  const m = String(prUrl).match(/\/pull\/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Resolve the last-updated date for a page using a priority fallback chain.
 *
 * Priority:
 *   1. frontmatter `lastEdited` (set by content editing tools)
 *   2. frontmatter `lastUpdated` (legacy field)
 *   3. edit log date from wiki-server
 *   4. git modified date (last resort — includes metadata-only commits)
 *
 * @param {object} fm           - parsed frontmatter object
 * @param {string|null} editLogDate - date string from wiki-server edit logs
 * @param {string|null} gitDate     - date string from git modified map
 * @returns {string|null}
 */
export function resolveLastUpdated(fm, editLogDate, gitDate) {
  return toDateString(fm.lastEdited)
    || toDateString(fm.lastUpdated)
    || editLogDate
    || gitDate
    || null;
}

/**
 * Extract frontmatter from MDX/MD content using YAML parser
 * Properly handles nested objects like ratings
 */
export function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  try {
    return parse(match[1]) || {};
  } catch (e) {
    console.warn('Failed to parse frontmatter:', e.message);
    return {};
  }
}

/**
 * Build pages registry by scanning all MDX/MD files
 * Extracts frontmatter including quality, lastUpdated, title, etc.
 * Also detects unconverted links (markdown links with matching resources)
 */
export function buildPagesRegistry(urlToResource, editLogDates, gitDateMaps, earliestEditLogDates, assessmentMap = new Map()) {
  const { gitCreatedMap = new Map(), gitModifiedMap = new Map() } = gitDateMaps || {};
  const earliestDates = earliestEditLogDates || new Map();
  const pages = [];

  function scanDirectory(dir, urlPrefix = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        scanDirectory(fullPath, `${urlPrefix}/${entry}`);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        const id = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');
        const content = readFileSync(fullPath, 'utf-8');
        const fm = extractFrontmatter(content);

        // Index files use __index__ slug and are marked for ID registration only
        const isIndexFile = (id === 'index');
        const effectiveId = isIndexFile ? `__index__${urlPrefix}` : id;

        const urlPath = isIndexFile ? `${urlPrefix}/` : `${urlPrefix}/${id}/`;

        // Extract structural metrics (format-aware scoring)
        const contentFormat = fm.contentFormat || 'article';
        const metrics = extractMetrics(content, fullPath, contentFormat);

        // Find unconverted links (markdown links that have matching resources)
        const unconvertedLinks = urlToResource ? findUnconvertedLinks(content, urlToResource) : [];

        // Count already converted links (<R> components)
        const convertedLinkCount = countConvertedLinks(content);

        // Scoring fields are sourced exclusively from PG assessments (epic #2428)
        const assessment = assessmentMap.get(effectiveId);

        pages.push({
          id: effectiveId,
          wikiId: fm.wikiId || null,
          _fullPath: fullPath,
          path: urlPath,
          filePath: relative(CONTENT_DIR, fullPath),
          title: fm.title || id.replace(/-/g, ' '),
          quality: assessment?.quality ?? null,
          readerImportance: assessment?.readerImportance ?? null,
          researchImportance: assessment?.researchImportance ?? null,
          tacticalValue: assessment?.tacticalValue ?? null,
          // Content format: article (default), table, diagram, index, dashboard
          contentFormat: fm.contentFormat || 'article',
          causalLevel: fm.causalLevel || null,
          // Fallback chain — see resolveLastUpdated() for priority order.
          lastUpdated: resolveLastUpdated(
            fm,
            editLogDates.get(isIndexFile ? null : id),
            gitModifiedMap.get(relative(REPO_ROOT, fullPath)),
          ),
          // Derive creation date: prefer explicit frontmatter, then non-bulk git
          // first-commit, then earliest edit log from wiki-server, then legacy
          // frontmatter. Bulk-import git dates are already filtered out of
          // gitCreatedMap by buildGitDateMaps().
          dateCreated: toDateString(fm.createdAt) || gitCreatedMap.get(relative(REPO_ROOT, fullPath)) || earliestDates.get(isIndexFile ? null : id) || toDateString(fm.dateCreated) || null,
          summary: fm.summary || null,
          description: fm.description || null,
          // Ratings sourced from PG assessments
          ratings: assessment ? buildRatingsFromAssessment(assessment, null) : null,
          // Extract category from path (prefer subdirectory, fallback to top-level dir)
          category: urlPrefix.split('/').filter(Boolean)[1] || urlPrefix.split('/').filter(Boolean)[0] || 'other',
          // Subcategory from frontmatter (set by flatten-content migration)
          subcategory: fm.subcategory || null,
          // Topic clusters for filtering
          clusters: fm.clusters || ['ai-safety'],
          // Structural metrics
          metrics: {
            wordCount: metrics.wordCount,
            tableCount: metrics.tableCount,
            diagramCount: metrics.diagramCount,
            internalLinks: metrics.internalLinks,
            externalLinks: metrics.externalLinks,
            footnoteCount: metrics.footnoteCount,
            bulletRatio: Math.round(metrics.bulletRatio * 100) / 100,
            sectionCount: metrics.sectionCount.total,
            hasOverview: metrics.hasOverview,
            structuralScore: metrics.structuralScore,
          },
          // Suggested quality based on structure
          suggestedQuality: suggestQuality(metrics.structuralScore, fm),
          // Update frequency (days between updates)
          updateFrequency: fm.update_frequency ? parseInt(fm.update_frequency) : null,
          // Evergreen flag (false = point-in-time content like reports, excluded from update schedule)
          evergreen: fm.evergreen === false ? false : true,
          // Legacy field for backwards compatibility
          wordCount: metrics.wordCount,
          // Unconverted links (markdown links with matching resources)
          unconvertedLinks,
          unconvertedLinkCount: unconvertedLinks.length,
          // Already converted links (<R> components)
          convertedLinkCount,
          // Raw content for redundancy analysis (removed before JSON output)
          rawContent: content,
        });
      }
    }
  }

  // Scan all content directories
  scanDirectory(join(CONTENT_DIR, 'knowledge-base'), '/knowledge-base');

  for (const topDir of TOP_LEVEL_CONTENT_DIRS) {
    const dirPath = join(CONTENT_DIR, topDir);
    if (existsSync(dirPath)) {
      scanDirectory(dirPath, `/${topDir}`);
    }
  }

  return pages;
}

/**
 * Build path registry by scanning all MDX/MD files
 * Maps entity IDs (from filenames) to their URL paths.
 * Also adds entity-ID-to-path mappings from YAML data for entities
 * whose IDs differ from their page filenames.
 */
export function buildPathRegistry() {
  const registry = {};

  function scanDirectory(dir, urlPrefix = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Recurse into subdirectory
        scanDirectory(fullPath, `${urlPrefix}/${entry}`);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        // Extract ID from filename (remove extension)
        const id = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');

        // Skip index files - they use the directory path
        if (id === 'index') {
          // The directory itself is the URL
          registry[`__index__${urlPrefix}`] = `${urlPrefix}/`;
        } else {
          // Build the URL path
          const urlPath = `${urlPrefix}/${id}/`;
          registry[id] = urlPath;
        }
      }
    }
  }

  // Scan the knowledge-base directory
  scanDirectory(join(CONTENT_DIR, 'knowledge-base'), '/knowledge-base');

  // Also scan other top-level content directories
  for (const topDir of TOP_LEVEL_CONTENT_DIRS) {
    const dirPath = join(CONTENT_DIR, topDir);
    if (existsSync(dirPath)) {
      scanDirectory(dirPath, `/${topDir}`);
    }
  }

  // Add entity-to-path mappings from YAML entity data.
  // Many entities have IDs that differ from their page filenames
  // (e.g. entities whose IDs don't match their page filenames).
  // Also handle factor entities that follow "factors-{id}-overview" naming.
  const entityDir = join(DATA_DIR, 'entities');
  if (existsSync(entityDir)) {
    for (const file of readdirSync(entityDir)) {
      if (!file.endsWith('.yaml')) continue;
      const content = readFileSync(join(entityDir, file), 'utf-8');
      let entities;
      try {
        entities = parse(content);
      } catch (e) {
        console.error(`Failed to parse YAML ${join(entityDir, file)}: ${e.message}`);
        process.exitCode = 1;
        continue;
      }
      if (!Array.isArray(entities)) continue;
      for (const entity of entities) {
        if (!entity.id || registry[entity.id]) continue;
        // Use explicit path field if present
        if (entity.path) {
          const normalized = entity.path.replace(/\/$/, '') + '/';
          registry[entity.id] = normalized;
        } else {
          // Try "factors-{id}-overview" pattern for factor entities
          const overviewId = `factors-${entity.id}-overview`;
          if (registry[overviewId]) {
            registry[entity.id] = registry[overviewId];
          }
        }
      }
    }
  }

  return registry;
}

/**
 * Compute hallucination risk score for a page (build-time wrapper).
 *
 * Delegates to the canonical scorer in crux/lib/hallucination-risk.ts.
 * See that module for scoring details and factor weights.
 *
 * @param {object} page  - page object from buildPagesRegistry (with metrics, ratings, etc.)
 * @param {Map}    entityMap - Map<entityId, entity> from YAML data
 */
export function computeHallucinationRisk(page, entityMap) {
  const entity = entityMap.get(page.id);
  const rawType = entity?.type || null;

  // Strip frontmatter from raw content for integrity checks
  const contentBody = page.rawContent
    ? page.rawContent.replace(/^---\n[\s\S]*?\n---\n?/, '')
    : null;

  return computeCanonicalRisk({
    entityType: resolveEntityType(rawType),
    wordCount: page.metrics?.wordCount || 0,
    footnoteCount: page.metrics?.footnoteCount || 0,
    externalLinks: page.metrics?.externalLinks || 0,
    rigor: page.ratings?.rigor ?? null,
    quality: page.quality ?? null,
    contentBody,
    contentFormat: page.contentFormat || null,
  });
}
