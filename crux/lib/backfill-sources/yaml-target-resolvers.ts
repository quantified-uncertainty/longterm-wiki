/**
 * Build sid → YAML-file maps for the two table types we dual-write to.
 *
 * Facts (FactBase): one file per entity in packages/factbase/data/fb-entities/.
 *   Two header formats coexist: `entity: sid_xxx` (current, ~538 files) and
 *   the legacy `thing: { id: <slug> }` (~13 files). The legacy ones don't
 *   carry the sid in the header — we skip them and let the caller fall back
 *   to PG-only writes for those (rare).
 *
 * Policy stakeholders (TableBase entities): each `data/entities/*.yaml` is
 *   a YAML array of entity objects, one of which may have `stableId: sid_xxx`.
 *   We scan all 17-ish files and build the index in one pass.
 *
 * Both indexes are built once at the start of an apply run (cheap — ~550
 *   YAML headers parsed) and reused per-record. No mutation, no caching
 *   across runs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const FACTBASE_DIR_DEFAULT = 'packages/factbase/data/fb-entities';
const ENTITIES_DIR_DEFAULT = 'data/entities';

export interface FactbaseEntityIndex {
  /** Map from FactBase entity sid (sid_xxx) → absolute YAML file path. */
  sidToFilepath: Map<string, string>;
  /** Number of files we couldn't index (legacy `thing:` format or parse fail). */
  unindexedCount: number;
}

export interface PolicyEntityIndex {
  /** Map from TableBase entity sid (sid_xxx) → absolute YAML file path. */
  sidToFilepath: Map<string, string>;
  /** Number of YAML files that failed to parse. */
  parseFailureCount: number;
}

/**
 * Scan fb-entities/*.yaml; return sid → filepath map.
 *
 * Only the first line of each file is read for the common `entity: sid_xxx`
 * shape; legacy `thing:` files require a full parse, which we skip (the
 * write path will fall back to PG-only for those).
 */
export function buildFactbaseEntityIndex(
  factbaseDir: string = FACTBASE_DIR_DEFAULT,
): FactbaseEntityIndex {
  const sidToFilepath = new Map<string, string>();
  let unindexedCount = 0;

  const files = readdirSync(factbaseDir).filter(f => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(factbaseDir, file);
    try {
      const content = readFileSync(filepath, 'utf-8');
      const firstLine = content.split('\n', 1)[0];
      const m = firstLine.match(/^entity:\s*(sid_[A-Za-z0-9]+)\s*$/);
      if (m) {
        sidToFilepath.set(m[1], filepath);
      } else {
        unindexedCount++;
      }
    } catch {
      unindexedCount++;
    }
  }

  return { sidToFilepath, unindexedCount };
}

/**
 * Scan data/entities/*.yaml; return policy entity sid → filepath map.
 *
 * Each file is a YAML array of entity objects. We parse the whole array
 * (cheap — these files are small and there are only ~17 of them) and index
 * every object that has both `type: policy` and `stableId: sid_xxx`.
 *
 * Non-policy types are skipped — only policy entities have `stakeholders:`
 * arrays, so indexing the rest would be dead weight.
 */
export function buildPolicyEntityIndex(
  entitiesDir: string = ENTITIES_DIR_DEFAULT,
): PolicyEntityIndex {
  const sidToFilepath = new Map<string, string>();
  let parseFailureCount = 0;

  const files = readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(entitiesDir, file);
    try {
      const content = readFileSync(filepath, 'utf-8');
      const parsed = parseYaml(content);
      if (!Array.isArray(parsed)) continue;
      for (const entity of parsed) {
        if (
          entity &&
          typeof entity === 'object' &&
          entity.type === 'policy' &&
          typeof entity.stableId === 'string' &&
          entity.stableId.startsWith('sid_')
        ) {
          sidToFilepath.set(entity.stableId, filepath);
        }
      }
    } catch {
      parseFailureCount++;
    }
  }

  return { sidToFilepath, parseFailureCount };
}
