/**
 * Link graph operations — extracted from build-data.mjs.
 *
 * Pure functions for computing backlinks, scanning EntityLink references,
 * building the related-pages graph, and collecting link signals for sync.
 * No side effects, no API calls, no imports.
 */

/**
 * Compute YAML backlinks from entity relatedEntries.
 * Returns: { [targetId]: [{ id, type, title, relationship }, ...] }
 */
export function computeBacklinks(entities, byStableId) {
  const backlinks = {};

  for (const entity of entities) {
    // Check relatedEntries
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        // Resolve stableId references to canonical slug IDs
        const targetId = (byStableId && byStableId[ref.id]) || ref.id;
        if (!backlinks[targetId]) {
          backlinks[targetId] = [];
        }
        backlinks[targetId].push({
          id: entity.id,
          type: entity.type,
          title: entity.title,
          relationship: ref.relationship,
        });
      }
    }
  }

  return backlinks;
}

/**
 * Scan MDX content for <EntityLink id="..."> references.
 * Returns inbound map: targetEntityId -> array of source pages that link to it.
 * Must be called before rawContent is stripped from pages.
 */
export function scanContentEntityLinks(pages, entityMap, wikiIdToSlug, byStableId) {
  const inbound = {};
  let totalLinks = 0;

  for (const page of pages) {
    if (!page.rawContent) continue;

    const regex = /<EntityLink\s+[^>]*id="([^"]+)"/g;
    let match;
    const seen = new Set();

    while ((match = regex.exec(page.rawContent)) !== null) {
      let targetId = match[1];
      // Resolve wiki IDs (e.g. "E22") to slug IDs (e.g. "anthropic")
      if (wikiIdToSlug && wikiIdToSlug[targetId]) {
        targetId = wikiIdToSlug[targetId];
      }
      // Resolve stableIds (e.g. "mK9pX3rQ7n") to slug IDs
      else if (byStableId && byStableId[targetId]) {
        targetId = byStableId[targetId];
      }
      if (targetId === page.id) continue; // Skip self-links
      if (seen.has(targetId)) continue;
      seen.add(targetId);

      if (!inbound[targetId]) {
        inbound[targetId] = [];
      }
      const sourceEntity = entityMap.get(page.id);
      inbound[targetId].push({
        id: page.id,
        type: sourceEntity?.type || 'concept',
        title: page.title,
      });
      totalLinks++;
    }
  }

  return { inbound, totalLinks };
}

/**
 * Build inverted tag index.
 * Returns a map: tag -> array of entities with that tag (sorted alphabetically by tag).
 */
export function buildTagIndex(entities) {
  const index = {};

  for (const entity of entities) {
    if (!entity.tags) continue;

    for (const tag of entity.tags) {
      if (!index[tag]) {
        index[tag] = [];
      }
      index[tag].push({
        id: entity.id,
        type: entity.type,
        title: entity.title,
      });
    }
  }

  // Sort tags alphabetically
  const sortedIndex = {};
  for (const tag of Object.keys(index).sort()) {
    sortedIndex[tag] = index[tag];
  }

  return sortedIndex;
}

/**
 * Map for auto-generating reverse relationship labels.
 */
const INVERSE_LABEL = {
  'causes': 'caused by',
  'cause': 'caused by',
  'mitigates': 'mitigated by',
  'mitigated-by': 'mitigates',
  'mitigation': 'mitigated by',
  'requires': 'required by',
  'enables': 'enabled by',
  'blocks': 'blocked by',
  'supersedes': 'superseded by',
  'increases': 'increased by',
  'decreases': 'decreased by',
  'supports': 'supported by',
  'measures': 'measured by',
  'measured-by': 'measures',
  'analyzed-by': 'analyzes',
  'analyzes': 'analyzed by',
  'child-of': 'parent of',
  'composed-of': 'component of',
  'component': 'composed of',
  'addresses': 'addressed by',
  'affects': 'affected by',
  'amplifies': 'amplified by',
  'contributes-to': 'receives contribution from',
  'driven-by': 'drives',
  'driver': 'driven by',
  'drives': 'driven by',
  'leads-to': 'leads',
  'shaped-by': 'shapes',
  'prerequisite': 'depends on',
  'research': 'researched by',
  'models': 'modeled by',
};

/**
 * Compute a bidirectional related-pages graph combining all signals.
 * Every connection is symmetric: if A relates to B, B relates to A.
 *
 * Signals (from strongest to weakest):
 *   1. Explicit YAML relatedEntries  (weight 10)
 *   2. Name/prefix matching          (weight 6)
 *   3. Content EntityLinks            (weight 5)
 *   4. Content similarity/redundancy  (weight 0–3, scaled by similarity)
 *   5. Shared tags                    (weight varies by specificity)
 *
 * Quality boost: Each neighbor's raw score is multiplied by a gentle factor
 * based on the target page's quality and readerImportance ratings:
 *   boost = 1 + quality/40 + importance/400   (max ~1.45x)
 * Unrated pages default to average values (q=5, imp=50 → 1.25x) so they
 * aren't penalized vs rated pages.
 *
 * Returns: entityId -> sorted array of { id, type, title, score, label? }
 */
export function computeRelatedGraph(entities, pages, contentInbound, tagIndex, byStableId) {
  const entityMap = new Map(entities.map(e => [e.id, e]));
  // Also index by stableId so relatedEntries that use stableId refs can be resolved
  if (byStableId) {
    for (const entity of entities) {
      if (entity.stableId) {
        entityMap.set(entity.stableId, entity);
      }
    }
  }
  const pageMap = new Map(pages.map(p => [p.id, p]));
  // Helper: resolve a ref.id that may be a stableId or wikiId to the canonical slug
  function resolveRefId(id) {
    if (byStableId && byStableId[id]) return byStableId[id];
    return id;
  }

  // Accumulator: graph[entityId] = Map<relatedId, score>
  const graph = {};

  // Directional labels from YAML relatedEntries (not symmetric)
  // labels[from][to] = "analyzes"
  const labels = {};

  function addEdge(a, b, weight) {
    if (a === b) return;
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!graph[from]) graph[from] = new Map();
      graph[from].set(to, (graph[from].get(to) || 0) + weight);
    }
  }

  // 1. Explicit YAML relatedEntries (strongest signal)
  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        // Resolve stableId references (10-char alphanum) to canonical slug IDs
        const resolvedRefId = resolveRefId(ref.id);
        addEdge(entity.id, resolvedRefId, 10);
        // Store directional label if present
        if (ref.relationship && ref.relationship !== 'related') {
          if (!labels[entity.id]) labels[entity.id] = {};
          labels[entity.id][resolvedRefId] = ref.relationship.replace(/-/g, ' ');
          // Also store inverse label for the reverse direction
          const inverse = INVERSE_LABEL[ref.relationship];
          if (inverse) {
            if (!labels[resolvedRefId]) labels[resolvedRefId] = {};
            // Don't overwrite an explicit label with an inferred one
            if (!labels[resolvedRefId][entity.id]) {
              labels[resolvedRefId][entity.id] = inverse;
            }
          }
        }
      }
    }
  }

  // 2. Name/prefix matching (e.g. "anthropic" ↔ "anthropic-ipo")
  const sortedIds = entities.map(e => e.id).sort();
  for (let i = 0; i < sortedIds.length; i++) {
    const a = sortedIds[i];
    const prefix = a + '-';
    for (let j = i + 1; j < sortedIds.length; j++) {
      const b = sortedIds[j];
      if (b.startsWith(prefix)) {
        addEdge(a, b, 6);
      } else {
        break;
      }
    }
  }

  // 3. Content EntityLinks (directional in content, but stored bidirectionally)
  for (const [targetId, sources] of Object.entries(contentInbound)) {
    for (const source of sources) {
      addEdge(source.id, targetId, 5);
    }
  }

  // 4. Content similarity from redundancy scores
  for (const page of pages) {
    if (!page.redundancy?.similarPages) continue;
    for (const sp of page.redundancy.similarPages) {
      addEdge(page.id, sp.id, (sp.similarity / 100) * 3);
    }
  }

  // 5. Shared tags — weighted by specificity (rarer tags are more informative)
  for (const entity of entities) {
    if (!entity.tags?.length) continue;
    for (const tag of entity.tags) {
      const tagEntities = tagIndex[tag] || [];
      const specificity = 1 / Math.log2(tagEntities.length + 2);
      for (const te of tagEntities) {
        if (te.id !== entity.id) {
          addEdge(entity.id, te.id, specificity * 2);
        }
      }
    }
  }

  // Convert to output: apply quality boost, then type-diverse selection.
  const MAX_PER_ENTITY = 25;
  const MIN_PER_TYPE = 2;

  const output = {};
  for (const [entityId, neighbors] of Object.entries(graph)) {
    const scored = [...neighbors.entries()]
      .map(([targetId, rawScore]) => {
        const targetPage = pageMap.get(targetId);
        const q = targetPage?.quality ?? 5;
        const imp = targetPage?.readerImportance ?? 50;
        const boost = 1 + q / 40 + imp / 400;
        const e = entityMap.get(targetId);
        const entry = {
          id: targetId,
          type: e?.type || 'concept',
          title: e?.title || targetId,
          score: Math.round(rawScore * boost * 100) / 100,
        };
        const lbl = labels[entityId]?.[targetId];
        if (lbl) entry.label = lbl;
        return entry;
      })
      .filter(entry => entry.score >= 1.0)
      .sort((a, b) => b.score - a.score);

    // Type-diverse selection: guarantee MIN_PER_TYPE from each type,
    // then fill remaining slots with highest-scoring entries.
    const selected = new Set();
    const byType = new Map();
    for (const entry of scored) {
      if (!byType.has(entry.type)) byType.set(entry.type, []);
      byType.get(entry.type).push(entry);
    }

    // Phase 1: take top MIN_PER_TYPE from each type
    for (const [, entries] of byType) {
      for (const entry of entries.slice(0, MIN_PER_TYPE)) {
        selected.add(entry.id);
      }
    }

    // Phase 2: fill remaining slots by score
    for (const entry of scored) {
      if (selected.size >= MAX_PER_ENTITY) break;
      selected.add(entry.id);
    }

    // Build final list in score order
    const result = scored.filter(e => selected.has(e.id)).slice(0, MAX_PER_ENTITY);

    if (result.length > 0) {
      output[entityId] = result;
    }
  }

  return output;
}

/**
 * Collect all link signals into a flat array for syncing to the wiki-server.
 * Mirrors the 5 signals used by computeRelatedGraph.
 */
export function collectLinkSignals(entities, pages, contentInbound, tagIndex, byStableId) {
  const links = [];
  const seen = new Set(); // Deduplicate (source, target, type)

  function addLink(sourceId, targetId, linkType, weight, relationship) {
    if (sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|${linkType}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ sourceId, targetId, linkType, weight, relationship: relationship || null });
  }

  // 1. Explicit YAML relatedEntries (resolve stableId refs to slugs)
  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const ref of entity.relatedEntries) {
        const targetId = (byStableId && byStableId[ref.id]) || ref.id;
        addLink(entity.id, targetId, 'yaml_related', 10, ref.relationship);
      }
    }
  }

  // 2. Name/prefix matching
  const sortedIds = entities.map(e => e.id).sort();
  for (let i = 0; i < sortedIds.length; i++) {
    const a = sortedIds[i];
    const prefix = a + '-';
    for (let j = i + 1; j < sortedIds.length; j++) {
      const b = sortedIds[j];
      if (b.startsWith(prefix)) {
        addLink(a, b, 'name_prefix', 6, null);
      } else {
        break;
      }
    }
  }

  // 3. Content EntityLinks
  for (const [targetId, sources] of Object.entries(contentInbound)) {
    for (const source of sources) {
      addLink(source.id, targetId, 'entity_link', 5, null);
    }
  }

  // 4. Content similarity from redundancy scores
  for (const page of pages) {
    if (!page.redundancy?.similarPages) continue;
    for (const sp of page.redundancy.similarPages) {
      const weight = (sp.similarity / 100) * 3;
      if (weight > 0) {
        addLink(page.id, sp.id, 'similarity', Math.round(weight * 100) / 100, null);
      }
    }
  }

  // 5. Shared tags
  for (const entity of entities) {
    if (!entity.tags?.length) continue;
    for (const tag of entity.tags) {
      const tagEntities = tagIndex[tag] || [];
      const specificity = 1 / Math.log2(tagEntities.length + 2);
      const weight = Math.round(specificity * 2 * 100) / 100;
      if (weight > 0) {
        for (const te of tagEntities) {
          if (te.id !== entity.id) {
            addLink(entity.id, te.id, 'shared_tag', weight, null);
          }
        }
      }
    }
  }

  return links;
}
