// Multi-file entity loader for `data/entities/*.yaml`.
//
// Used by benchmark + improve-entity commands so a slug can resolve from
// any entity type file (responses.yaml, organizations.yaml, ai-models.yaml,
// etc.) without hardcoding a single path. Mirrors the `findEntity` helper
// in `crux/commands/research-improve-entity.ts` (QUA-876) and replaces the
// hardcoded `responses.yaml` reads in the benchmark commands (QUA-936).

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const ROOT = path.resolve(import.meta.dirname, "../../..");
export const DEFAULT_ENTITIES_DIR = path.join(ROOT, "data/entities");

export interface EntityWithType {
  id: string;
  type: string;
  [k: string]: unknown;
}

/**
 * Load every entity from every `*.yaml` file in `entitiesDir`.
 *
 * Files that don't parse as YAML or aren't a top-level array are skipped
 * with a warn log — gate validators (`validate-yaml-schema` etc.) are
 * authoritative for file health, but a silent skip would mask the
 * presence-of-the-bug here (e.g. "12 entities scored" vs "8 scored, 4
 * silently dropped because foo.yaml has a syntax error"). Per
 * `error-handling.md`, log warnings instead of swallowing.
 */
export function loadAllEntities(entitiesDir: string = DEFAULT_ENTITIES_DIR): EntityWithType[] {
  const out: EntityWithType[] = [];
  for (const f of fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yaml"))) {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(path.join(entitiesDir, f), "utf8"));
    } catch (e) {
      console.warn(
        `[entity-loader] skipping ${f}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!Array.isArray(parsed)) {
      console.warn(`[entity-loader] skipping ${f}: top-level value is not an array`);
      continue;
    }
    for (const e of parsed) {
      if (
        e &&
        typeof e === "object" &&
        typeof (e as { id?: unknown }).id === "string" &&
        typeof (e as { type?: unknown }).type === "string"
      ) {
        out.push(e as EntityWithType);
      }
    }
  }
  return out;
}

/** Return the first entity whose `id` matches `slug`, or `null`. */
export function findEntity(
  slug: string,
  entitiesDir: string = DEFAULT_ENTITIES_DIR,
): EntityWithType | null {
  return loadAllEntities(entitiesDir).find((e) => e.id === slug) ?? null;
}
