import { readFileSync } from "fs";
import { resolve } from "path";
import type { EntityMatch, EntityMatcher } from "./types.ts";

/** Manual name -> slug overrides for known orgs that don't match automatically */
export const MANUAL_GRANTEE_OVERRIDES: Record<string, string> = {
  "Center for Security and Emerging Technology": "cset",
  CSET: "cset",
  "Machine Intelligence Research Institute": "miri",
  MIRI: "miri",
  "Future of Humanity Institute": "fhi",
  "Centre for the Study of Existential Risk": "cser",
  GiveWell: "givewell",
  "Alignment Research Center": "arc",
  ARC: "arc",
  "Center for AI Safety": "center-for-ai-safety",
  "Center for Human-Compatible AI": "chai",
  CHAI: "chai",
  "Centre for Effective Altruism": "cea",
  "80,000 Hours": "80000-hours",
  "80000 Hours": "80000-hours",
  "Redwood Research": "redwood-research",
  Anthropic: "anthropic",
  OpenAI: "openai",
  "Survival and Flourishing Fund": "survival-and-flourishing-fund",
  BlueDot: "bluedot-impact",
  "BlueDot Impact": "bluedot-impact",
  Constellation: "constellation",
  "MATS Research": "mats",
  MATS: "mats",
  "Johns Hopkins Center for Health Security": "johns-hopkins-center-for-health-security",
  "Nuclear Threat Initiative": "nti-bio",
  "NTI | Bio": "nti-bio",
  Metaculus: "metaculus",
  "Center for Applied Rationality": "center-for-applied-rationality",
  "Longview Philanthropy": "longview-philanthropy",
  SecureBio: "securebio",
  Elicit: "elicit",
  "AI Safety Support": "ai-safety-support",
  "FAR AI": "far-ai",
  "Institute for AI Policy and Strategy": "iaps",
  RAND: "rand",
  "RAND Corporation": "rand",
  Manifund: "manifund",
  GovAI: "govai",
  "Centre for Governance of AI (GovAI)": "govai",
  "Centre for Governance of AI": "govai",
  "Founders Pledge": "founders-pledge",
  "Good Ventures": "good-ventures",
  "Open Philanthropy": "coefficient-giving",
  GiveDirectly: "givedirectly",
  "Effective Ventures Foundation": "cea",
  "Against Malaria Foundation": "against-malaria-foundation",
  // FTX Future Fund grantees
  Ought: "elicit",
  "Manifold Markets": "manifold",
  "Rethink Priorities": "rethink-priorities",
  "Good Judgment Project": "good-judgment",
  "Giving What We Can": "giving-what-we-can",
  "Council on Strategic Risks": "council-on-strategic-risks",
  "1Day Sooner": "1day-sooner",
  "Quantified Uncertainty Research Institute": "quri",
  "AI Impacts": "ai-impacts",
};

export function buildEntityMatcher(): EntityMatcher {
  const nameMap = new Map<string, EntityMatch>();

  // Load KB data from kb-data.json (database.json strips the kb field)
  const kbDataPath = resolve("apps/web/src/data/kb-data.json");
  const kbData = JSON.parse(readFileSync(kbDataPath, "utf8"));
  const slugToId: Record<string, string> = kbData.slugToEntityId || {};
  const idToSlug = new Map<string, string>();
  for (const [slug, id] of Object.entries(slugToId)) {
    idToSlug.set(id, slug);
  }

  if (kbData.entities) {
    for (const [eid, entity] of Object.entries(
      kbData.entities as Record<string, { name?: string; aliases?: string[] }>
    )) {
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
  const dbPath = resolve("apps/web/src/data/database.json");
  const db = JSON.parse(readFileSync(dbPath, "utf8"));
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
 * Match a grantee name to an entity, checking manual overrides first.
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

  const overrideSlug = overrides[name];
  if (overrideSlug) {
    const match = matcher.match(overrideSlug);
    if (match) return match.stableId;
  }
  const match = matcher.match(name);
  return match?.stableId ?? null;
}
