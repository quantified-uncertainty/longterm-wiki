import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import type { EntityMatch, EntityMatcher } from "./types.ts";
import type { IdRegistryMaps } from "../../../apps/web/src/data/tablebase.ts";

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
    const pattern = new RegExp(`[,\\s]+${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
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

  // Load database.json for idRegistry (slug↔stableId) and typedEntities
  let db: {
    idRegistry?: IdRegistryMaps;
    typedEntities?: Array<{ id: string; stableId?: string; title?: string; aliases?: string[] }>;
  } = {};
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

  const slugToId: Record<string, string> = db.idRegistry?.stableIdBySlug || {};

  for (const e of db.typedEntities || []) {
    const slug = e.id;
    const stableId = e.stableId || slugToId[slug];
    if (!stableId) {
      continue; // Skip entities that cannot be resolved to a stableId
    }
    const match: EntityMatch = {
      stableId,
      slug,
      name: e.title || slug,
    };
    if (e.title) {
      nameMap.set(e.title.toLowerCase().trim(), match);
    }
    if (e.aliases) {
      for (const alias of e.aliases) {
        nameMap.set(alias.toLowerCase().trim(), match);
      }
    }
    if (slug) nameMap.set(slug.toLowerCase(), match);
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
