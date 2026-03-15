/**
 * KB Fact Lookup — find KB facts by source URL for a given entity.
 *
 * Used by the footnote conversion pipeline to prefer [^kb-factId] markers
 * when a footnote URL matches a KB fact's source field.
 *
 * Loads only the single entity YAML file rather than the full KB graph,
 * keeping the lookup lightweight for use during content improvement.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PROJECT_ROOT } from './content-types.ts';
import { normalizeUrlForDedup } from './footnote-parser.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'factbase', 'data', 'things');

interface RawKBFact {
  id: string;
  property: string;
  value: unknown;
  source?: string;
  [key: string]: unknown;
}

export interface KBFactMatch {
  factId: string;
  property: string;
  source: string;
}

/**
 * Build a map of normalized source URL → KB fact for a given entity.
 *
 * Returns an empty map if the entity has no KB YAML file or no facts with sources.
 * Errors are caught and logged — KB lookup is best-effort and should never
 * break the footnote conversion pipeline.
 */
export async function buildKBFactSourceMap(
  entityId: string,
): Promise<Map<string, KBFactMatch>> {
  const map = new Map<string, KBFactMatch>();

  try {
    const yamlPath = join(KB_DATA_DIR, `${entityId}.yaml`);
    const content = await readFile(yamlPath, 'utf-8');
    const parsed = parseYaml(content) as { facts?: RawKBFact[] };

    if (!parsed?.facts) return map;

    for (const fact of parsed.facts) {
      if (!fact.source || !fact.id) continue;
      const normalized = normalizeUrlForDedup(fact.source);
      // First fact wins for a given URL (most specific/earliest)
      if (!map.has(normalized)) {
        map.set(normalized, {
          factId: fact.id,
          property: fact.property,
          source: fact.source,
        });
      }
    }
  } catch (error: unknown) {
    // ENOENT is expected — not every page has a KB YAML file.
    // Other errors are logged as warnings but don't break the pipeline.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[factbase-fact-lookup] Failed to load KB facts for "${entityId}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return map;
}

/**
 * Look up a KB fact by source URL for a given entity.
 *
 * @param sourceMap - Pre-built source map from buildKBFactSourceMap()
 * @param url - The footnote URL to match
 * @returns The matching KB fact, or undefined if no match
 */
export function findKBFactByUrl(
  sourceMap: Map<string, KBFactMatch>,
  url: string,
): KBFactMatch | undefined {
  const normalized = normalizeUrlForDedup(url);
  return sourceMap.get(normalized);
}
