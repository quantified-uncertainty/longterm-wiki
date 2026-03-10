/**
 * Shared KB loading and entity resolution utilities.
 *
 * Used by CLI commands (kb.ts, kb-verify.ts) that need to load the KB graph
 * and resolve user-provided entity identifiers (ID, filename/slug, or name).
 */

import { join } from 'path';
import { PROJECT_ROOT } from './content-types.ts';
import { loadKB } from '../../packages/kb/src/loader.ts';
import { computeInverses } from '../../packages/kb/src/inverse.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity } from '../../packages/kb/src/types.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

export { KB_DATA_DIR };

/** Loaded KB with filenameMap for reverse lookups. */
export interface LoadedKB {
  graph: Graph;
  filenameMap: Map<string, string>;
  /** Reverse map: filename → entityId */
  idByFilename: Map<string, string>;
}

/**
 * Load the KB graph with inverses computed and filename maps built.
 */
export async function loadGraphFull(): Promise<LoadedKB> {
  const { graph, filenameMap } = await loadKB(KB_DATA_DIR);
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

  // StableId lookup (deprecated but still supported)
  const byStableId = kb.graph.getEntityByStableId(identifier);
  if (byStableId) return byStableId;

  // Case-insensitive name match
  const lower = identifier.toLowerCase();
  return kb.graph.getAllEntities().find((e) => e.name.toLowerCase() === lower);
}
