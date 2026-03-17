/**
 * Shared KB loading and entity resolution utilities.
 *
 * Used by CLI commands (kb.ts, kb-verify.ts) that need to load the KB graph
 * and resolve user-provided entity identifiers (ID, filename/slug, or name).
 */

import { join } from 'path';
import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { PROJECT_ROOT } from './content-types.ts';
import { loadKB } from '../../packages/factbase/src/loader.ts';
import { computeInverses } from '../../packages/factbase/src/inverse.ts';
import type { Graph } from '../../packages/factbase/src/graph.ts';
import type { Entity } from '../../packages/factbase/src/types.ts';

const FACTBASE_DATA_DIR = join(PROJECT_ROOT, 'packages', 'factbase', 'data');
const ENTITIES_DIR = join(PROJECT_ROOT, 'data', 'entities');

/** @deprecated Use FACTBASE_DATA_DIR */
export const KB_DATA_DIR = FACTBASE_DATA_DIR;
export { FACTBASE_DATA_DIR };

// ── Entity type alias map (same as build-data.mjs) ──────────────────────
const ENTITY_TYPE_ALIASES: Record<string, string> = {
  lab: 'organization',
  'lab-academic': 'organization',
  'lab-research': 'organization',
  'lab-frontier': 'organization',
  researcher: 'person',
  response: 'approach',
  factor: 'risk',
};

function resolveType(raw: string): string {
  return ENTITY_TYPE_ALIASES[raw] ?? raw;
}

/**
 * Build a TableBase entity map from data/entities/*.yaml files.
 * Each YAML file contains an array of entity objects with at minimum
 * { id, stableId, type, title }.
 *
 * Returns a Map keyed by stableId, matching the shape loadKB() expects.
 */
export function buildTableBaseEntityMap(): Map<string, Entity> {
  const entityMap = new Map<string, Entity>();

  let files: string[];
  try {
    files = readdirSync(ENTITIES_DIR).filter((f) => f.endsWith('.yaml'));
  } catch {
    // entities directory doesn't exist — return empty map
    return entityMap;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(ENTITIES_DIR, file), 'utf-8');
      const data = parseYaml(content);
      if (!Array.isArray(data)) continue;

      for (const entry of data) {
        if (!entry.stableId) continue;
        entityMap.set(entry.stableId, {
          id: entry.stableId,
          stableId: entry.stableId,
          type: resolveType(entry.type) || entry.type,
          name: entry.title || entry.id,
          ...(entry.wikiId && { wikiPageId: entry.wikiId, wikiId: entry.wikiId }),
        });
      }
    } catch {
      // Skip unparseable files
    }
  }

  return entityMap;
}

/** Loaded KB with filenameMap for reverse lookups. */
export interface LoadedKB {
  graph: Graph;
  filenameMap: Map<string, string>;
  /** Reverse map: filename → entityId */
  idByFilename: Map<string, string>;
}

/**
 * Load the KB graph with inverses computed and filename maps built.
 * Automatically builds the TableBase entity map from data/entities/*.yaml
 * so that `entity: <stableId>` format YAML files are properly resolved.
 */
export async function loadGraphFull(): Promise<LoadedKB> {
  const entities = buildTableBaseEntityMap();
  const { graph, filenameMap } = await loadKB(FACTBASE_DATA_DIR, { entities });
  computeInverses(graph);
  const idByFilename = new Map<string, string>();
  for (const [entityId, filename] of filenameMap) {
    idByFilename.set(filename, entityId);
  }
  return { graph, filenameMap, idByFilename };
}

/**
 * Load just the KB graph (convenience wrapper).
 */
export async function loadGraph(): Promise<Graph> {
  const { graph } = await loadGraphFull();
  return graph;
}

/**
 * Resolve a user-provided entity identifier (ID, filename/slug, stableId, or name).
 * Returns the entity or undefined.
 */
export function resolveEntity(
  identifier: string,
  kb: LoadedKB,
): Entity | undefined {
  // Direct ID lookup
  const byId = kb.graph.getEntity(identifier);
  if (byId) return byId;

  // Filename/slug lookup (e.g., "anthropic" → entity ID via filenameMap)
  const idFromFilename = kb.idByFilename.get(identifier);
  if (idFromFilename) {
    return kb.graph.getEntity(idFromFilename);
  }

  // Case-insensitive name match
  const lower = identifier.toLowerCase();
  return kb.graph.getAllEntities().find((e) => e.name.toLowerCase() === lower);
}
