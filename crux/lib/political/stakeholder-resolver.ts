/**
 * Stakeholder Resolver
 *
 * Resolves stakeholder names in legislation YAML to entity IDs (stableIds or slugs).
 * Handles title prefixes ("Senator", "Rep.", "Governor"), parenthetical suffixes
 * ("(SIA)", "(Georgetown)"), and common name variations ("&" vs "and").
 *
 * Only resolves stakeholders that have a matching entity in the entity database.
 * Generic group names ("AI safety researchers", "Trump Administration") are left
 * unresolved — they don't correspond to a single entity.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeName } from "../name-utils.ts";

// ---- Types ----

export interface EntityRecord {
  id: string; // slug
  stableId: string;
  title: string;
  aliases: string[];
  type: string;
}

export interface StakeholderMatch {
  policyId: string;
  stakeholderName: string;
  matchedEntitySlug: string;
  matchedEntityStableId: string;
  matchedEntityTitle: string;
  method: string; // how the match was made
}

export interface ResolverResult {
  resolved: StakeholderMatch[];
  unresolved: Array<{ policyId: string; name: string }>;
  alreadyLinked: number;
  totalStakeholders: number;
}

// ---- Title prefixes to strip ----

const TITLE_PREFIXES = [
  "senator ",
  "sen. ",
  "representative ",
  "rep. ",
  "assemblymember ",
  "assemblywoman ",
  "assemblyman ",
  "governor ",
  "gov. ",
  "first lady ",
  "president ",
  "vice president ",
  "secretary ",
  "director ",
  "commissioner ",
  "chair ",
  "chairman ",
  "chairwoman ",
];

// ---- Core resolver ----

/**
 * Build name lookup tables from all entity YAML files.
 * Returns a map from normalized name -> EntityRecord.
 */
export function buildEntityLookup(
  dataDir: string,
): Map<string, EntityRecord> {
  const entitiesDir = join(dataDir, "entities");
  const files = readdirSync(entitiesDir).filter((f) => f.endsWith(".yaml"));
  const lookup = new Map<string, EntityRecord>();

  for (const file of files) {
    const raw = readFileSync(join(entitiesDir, file), "utf-8");
    const parsed = parseYaml(raw) as
      | Array<{
          id: string;
          stableId?: string;
          title: string;
          aliases?: string[];
          type?: string;
        }>
      | null;

    if (!Array.isArray(parsed)) continue;

    for (const entity of parsed) {
      if (!entity.id || !entity.title) continue;
      const record: EntityRecord = {
        id: entity.id,
        stableId: entity.stableId ?? "",
        title: entity.title,
        aliases: entity.aliases ?? [],
        type: entity.type ?? "",
      };

      // Index by normalized title
      const normalTitle = normalizeName(entity.title);
      if (normalTitle) lookup.set(normalTitle, record);

      // Index by slug
      lookup.set(entity.id.toLowerCase(), record);

      // Index by aliases
      for (const alias of entity.aliases ?? []) {
        const normalAlias = normalizeName(alias);
        if (normalAlias) lookup.set(normalAlias, record);
      }
    }
  }

  return lookup;
}

/**
 * Try to resolve a stakeholder name to an entity.
 * Returns the matched entity or null.
 */
export function resolveStakeholderName(
  name: string,
  lookup: Map<string, EntityRecord>,
): { entity: EntityRecord; method: string } | null {
  const normalized = normalizeName(name);

  // 1. Exact match on normalized name
  const exact = lookup.get(normalized);
  if (exact) return { entity: exact, method: "exact" };

  // 2. Strip title prefix: "Senator Ted Cruz" -> "ted cruz"
  for (const prefix of TITLE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length);
      const match = lookup.get(stripped);
      if (match) return { entity: match, method: "title-strip" };
    }
  }

  // 3. Strip parenthetical suffix: "Bureau of Industry and Security (BIS)" -> "bureau of industry and security"
  const noParen = normalized.replace(/\s*\([^)]*\)/, "").trim();
  if (noParen !== normalized) {
    const match = lookup.get(noParen);
    if (match) return { entity: match, method: "paren-strip" };
  }

  // 4. Handle "&" vs "and": "Center for Democracy & Technology" -> "center for democracy and technology"
  const withAnd = normalized.replace(/\s*&\s*/g, " and ");
  if (withAnd !== normalized) {
    const match = lookup.get(withAnd);
    if (match) return { entity: match, method: "ampersand" };
  }

  // 5. Handle parenthetical content as a separate lookup:
  //    "CSET (Georgetown)" -> try "cset"
  const parenContent = name.match(/^([^(]+)\s*\(/);
  if (parenContent) {
    const beforeParen = normalizeName(parenContent[1]);
    const match = lookup.get(beforeParen);
    if (match) return { entity: match, method: "before-paren" };
  }

  // 6. Suffix-backed lookup: "Public First Action (Anthropic-backed)" -> "public first action"
  const withoutBacked = noParen.replace(/\s*[-\s]backed$/, "").trim();
  if (withoutBacked !== noParen) {
    const match = lookup.get(withoutBacked);
    if (match) return { entity: match, method: "backed-strip" };
  }

  // 7. Try adding common suffixes: "R Street Institute coalition" -> "r street institute"
  const suffixStripped = normalized
    .replace(/\s+coalition$/, "")
    .replace(/\s+group$/, "")
    .replace(/\s+action$/, "")
    .trim();
  if (suffixStripped !== normalized) {
    const match = lookup.get(suffixStripped);
    if (match) return { entity: match, method: "suffix-strip" };
  }

  return null;
}

/**
 * Resolve all stakeholders in all policy entities.
 * Returns matches and unresolved names.
 */
export function resolveAllStakeholders(
  dataDir: string,
): ResolverResult {
  const lookup = buildEntityLookup(dataDir);

  const responsesPath = join(dataDir, "entities", "responses.yaml");
  const raw = readFileSync(responsesPath, "utf-8");
  const policies = parseYaml(raw) as Array<{
    id: string;
    title?: string;
    stakeholders?: Array<{
      name: string;
      entityId?: string;
      role?: string;
    }>;
  }>;

  const resolved: StakeholderMatch[] = [];
  const unresolved: Array<{ policyId: string; name: string }> = [];
  let alreadyLinked = 0;
  let totalStakeholders = 0;

  for (const policy of policies) {
    const stakeholders = policy.stakeholders ?? [];
    for (const s of stakeholders) {
      totalStakeholders++;

      // Skip already-linked stakeholders
      if (s.entityId) {
        alreadyLinked++;
        continue;
      }

      const result = resolveStakeholderName(s.name, lookup);
      if (result) {
        // Determine what entityId format to use — prefer stableId if available
        const entityId = result.entity.stableId || result.entity.id;
        resolved.push({
          policyId: policy.id,
          stakeholderName: s.name,
          matchedEntitySlug: result.entity.id,
          matchedEntityStableId: entityId,
          matchedEntityTitle: result.entity.title,
          method: result.method,
        });
      } else {
        unresolved.push({ policyId: policy.id, name: s.name });
      }
    }
  }

  return { resolved, unresolved, alreadyLinked, totalStakeholders };
}
