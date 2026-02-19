/**
 * Aggregate Statistics
 *
 * Computes summary statistics for the entity database:
 * counts by type/severity/status, recently updated, most linked, top tags.
 *
 * Extracted from build-data.mjs for modularity.
 */

/**
 * Compute aggregate statistics
 */
export function computeStats(entities, backlinks, tagIndex) {
  // Count by type
  const byType = {};
  for (const entity of entities) {
    byType[entity.type] = (byType[entity.type] || 0) + 1;
  }

  // Count by severity
  const bySeverity = {};
  for (const entity of entities) {
    if (entity.severity) {
      bySeverity[entity.severity] = (bySeverity[entity.severity] || 0) + 1;
    }
  }

  // Count by status
  const byStatus = {};
  for (const entity of entities) {
    const status = entity.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  // Recently updated (sort by lastUpdated, take top 10)
  const recentlyUpdated = entities
    .filter((e) => e.lastUpdated)
    .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
    .slice(0, 10)
    .map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      lastUpdated: e.lastUpdated,
    }));

  // Most linked (entities with most backlinks)
  // Pre-build a Map for O(1) lookups instead of O(n) entities.find() per entry
  const entityById = new Map(entities.map(e => [e.id, e]));
  const mostLinked = Object.entries(backlinks)
    .map(([id, links]) => ({
      id,
      count: links.length,
      entity: entityById.get(id),
    }))
    .filter((item) => item.entity)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      type: item.entity.type,
      title: item.entity.title,
      backlinkCount: item.count,
    }));

  // Tag statistics
  const topTags = Object.entries(tagIndex)
    .map(([tag, entities]) => ({ tag, count: entities.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Entities with descriptions
  const withDescription = entities.filter((e) => e.description).length;

  return {
    totalEntities: entities.length,
    byType,
    bySeverity,
    byStatus,
    recentlyUpdated,
    mostLinked,
    topTags,
    totalTags: Object.keys(tagIndex).length,
    withDescription,
    lastBuilt: new Date().toISOString(),
  };
}
