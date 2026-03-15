import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import type { EntityMatch, EntityMatcher } from "./types.ts";

/**
 * Suffixes to strip from grantee names during normalization.
 * Order matters: longer suffixes should come first to avoid partial matches.
 * Patterns are matched case-insensitively at the end of the name, optionally
 * preceded by a comma or space.
 */
const STRIP_SUFFIXES = [
  "incorporated",
  "corporation",
  "foundation",
  "limited",
  "inc.",
  "inc",
  "llc",
  "ltd.",
  "ltd",
  "l.l.c.",
  "corp.",
  "corp",
  "co.",
  "gmbh",
  "plc",
  "ngo",
  "a.s.",
  "b.v.",
  "pty",
];

/**
 * Normalize a grantee name by stripping common corporate/legal suffixes
 * and extra whitespace. This helps match "OpenAI, Inc." to "OpenAI".
 */
export function normalizeGranteeName(name: string): string {
  let normalized = name.trim();

  for (const suffix of STRIP_SUFFIXES) {
    // Match suffix at end of string, optionally preceded by comma/space
    const pattern = new RegExp(`[,\\s]+${suffix.replace(/\./g, "\\.")}\\s*$`, "i");
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, "").trim();
      break; // Only strip one suffix
    }
  }

  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Load manual grantee name -> slug overrides from the YAML data file.
 * The YAML file is the single source of truth for these mappings.
 */
function loadGranteeOverrides(): Record<string, string> {
  const overridesPath = resolve("data/grant-import/grantee-overrides.yaml");
  const raw = readFileSync(overridesPath, "utf8");
  const parsed = parseYaml(raw) as { overrides: Record<string, string> };
  return parsed.overrides;
}

/** Manual name -> slug overrides for known orgs that don't match automatically */
export const MANUAL_GRANTEE_OVERRIDES: Record<string, string> = loadGranteeOverrides();

export function buildEntityMatcher(): EntityMatcher {
  const nameMap = new Map<string, EntityMatch>();

  // Load FactBase data from factbase-data.json (database.json strips the kb field)
  let kbData: { slugToEntityId?: Record<string, string>; entities?: Record<string, { name?: string; aliases?: string[] }> } = {};
  const kbDataPath = resolve("apps/web/src/data/factbase-data.json");
  try {
    kbData = JSON.parse(readFileSync(kbDataPath, "utf8"));
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(
        `factbase-data.json not found — run 'pnpm build-data:content' first. Entity matching will be limited to manual overrides.`
      );
    } else {
      throw e;
    }
  }

  const slugToId: Record<string, string> = kbData.slugToEntityId || {};
  const idToSlug = new Map<string, string>();
  for (const [slug, id] of Object.entries(slugToId)) {
    idToSlug.set(id, slug);
  }

  if (kbData.entities) {
    for (const [eid, entity] of Object.entries(kbData.entities)) {
      const slug = idToSlug.get(eid) || "";
      const match: EntityMatch = {
        stableId: eid,
        slug,
        name: entity.name || slug,
      };
      if (entity.name)
        nameMap.set(entity.name.toLowerCase().trim(), match);
      if (entity.aliases) {
        for (const alias of entity.aliases) {
          nameMap.set(alias.toLowerCase().trim(), match);
        }
      }
      if (slug) nameMap.set(slug.toLowerCase(), match);
    }
  }

  // Also load typedEntities from database.json for non-KB entities
  let db: { typedEntities?: Array<{ id: string; title?: string }> } = {};
  const dbPath = resolve("apps/web/src/data/database.json");
  try {
    db = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(
        `database.json not found — run 'pnpm build-data:content' first. Entity matching will be limited to manual overrides.`
      );
    } else {
      throw e;
    }
  }

  for (const e of db.typedEntities || []) {
    const slug = e.id;
    const stableId = slugToId[slug] || slug;
    const match: EntityMatch = {
      stableId,
      slug,
      name: e.title || slug,
    };
    if (e.title && !nameMap.has(e.title.toLowerCase().trim())) {
      nameMap.set(e.title.toLowerCase().trim(), match);
    }
    if (slug && !nameMap.has(slug.toLowerCase())) {
      nameMap.set(slug.toLowerCase(), match);
    }
  }

  return {
    allNames: nameMap,
    match: (name: string) => {
      const lower = name.toLowerCase().trim();
      return nameMap.get(lower) || null;
    },
  };
}

/**
 * Match a grantee name to an entity, checking manual overrides first,
 * then trying the entity matcher directly, then trying again after
 * normalizing the name (stripping corporate suffixes like Inc., LLC, etc.).
 *
 * Returns the entity stableId if matched, null otherwise.
 */
export function matchGrantee(
  name: string,
  matcher: EntityMatcher,
  extraOverrides?: Record<string, string>,
): string | null {
  const overrides = extraOverrides
    ? { ...MANUAL_GRANTEE_OVERRIDES, ...extraOverrides }
    : MANUAL_GRANTEE_OVERRIDES;

  // 1. Try exact override lookup
  const overrideSlug = overrides[name];
  if (overrideSlug) {
    const match = matcher.match(overrideSlug);
    if (match) return match.stableId;
  }

  // 2. Try direct entity matcher lookup
  const directMatch = matcher.match(name);
  if (directMatch) return directMatch.stableId;

  // 3. Try after normalizing (strip Inc., LLC, etc.)
  const normalized = normalizeGranteeName(name);
  if (normalized !== name) {
    // Check override with normalized name
    const normalizedOverrideSlug = overrides[normalized];
    if (normalizedOverrideSlug) {
      const match = matcher.match(normalizedOverrideSlug);
      if (match) return match.stableId;
    }
    // Check direct match with normalized name
    const normalizedMatch = matcher.match(normalized);
    if (normalizedMatch) return normalizedMatch.stableId;
  }

  return null;
}
