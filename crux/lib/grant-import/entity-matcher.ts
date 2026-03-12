import { readFileSync } from "fs";
import { resolve } from "path";
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

/** Manual name -> slug overrides for known orgs that don't match automatically */
export const MANUAL_GRANTEE_OVERRIDES: Record<string, string> = {
  // --- AI Safety Labs ---
  Anthropic: "anthropic",
  "Anthropic PBC": "anthropic",
  OpenAI: "openai",
  "OpenAI LP": "openai",
  "OpenAI Global, LLC": "openai",
  DeepMind: "deepmind",
  "Google DeepMind": "deepmind",
  "xAI": "xai",
  "xAI Corp": "xai",

  // --- AI Safety Research Orgs ---
  "Machine Intelligence Research Institute": "miri",
  MIRI: "miri",
  "Alignment Research Center": "arc",
  ARC: "arc",
  "ARC Evals": "arc-evals",
  "Model Evaluation and Threat Research": "metr",
  METR: "metr",
  "Center for AI Safety": "center-for-ai-safety",
  CAIS: "center-for-ai-safety",
  "Center for Human-Compatible AI": "chai",
  "Center for Human-Compatible Artificial Intelligence": "chai",
  CHAI: "chai",
  "Redwood Research": "redwood-research",
  "Apollo Research": "apollo-research",
  Conjecture: "conjecture",
  "FAR AI": "far-ai",
  "FAR.AI": "far-ai",
  "Palisade Research": "palisade-research",
  ControlAI: "controlai",
  "Control AI": "controlai",
  Goodfire: "goodfire",
  "Seldon Lab": "seldon-lab",
  SSI: "ssi",
  "Safe Superintelligence": "ssi",
  "Safe Superintelligence Inc.": "ssi",

  // --- AI Safety Training/Community ---
  "MATS Research": "mats",
  MATS: "mats",
  "ML Alignment Theory Scholars": "mats",
  BlueDot: "bluedot-impact",
  "BlueDot Impact": "bluedot-impact",
  Constellation: "constellation",
  "AI Safety Support": "ai-safety-support",
  LessWrong: "lesswrong",
  Lighthaven: "lighthaven",

  // --- Policy/Governance Orgs ---
  "Center for Security and Emerging Technology": "cset",
  CSET: "cset",
  "Future of Humanity Institute": "fhi",
  FHI: "fhi",
  "Centre for the Study of Existential Risk": "cser",
  CSER: "cser",
  GovAI: "govai",
  "Centre for Governance of AI (GovAI)": "govai",
  "Centre for Governance of AI": "govai",
  "Center for Governance of AI": "govai",
  "Institute for AI Policy and Strategy": "iaps",
  IAPS: "iaps",
  "Future of Life Institute": "fli",
  FLI: "fli",
  "Centre for Long-Term Resilience": "centre-for-long-term-resilience",
  CLTR: "centre-for-long-term-resilience",
  "Centre for Long Term Resilience": "centre-for-long-term-resilience",
  "UK AI Safety Institute": "uk-aisi",
  "UK AISI": "uk-aisi",
  "US AI Safety Institute": "us-aisi",
  "US AISI": "us-aisi",
  RAND: "rand",
  "RAND Corporation": "rand",
  "Global Partnership on AI": "gpai",
  GPAI: "gpai",
  "NIST AI": "nist-ai",
  "Frontier Model Forum": "frontier-model-forum",
  "Pause AI": "pause-ai",
  PauseAI: "pause-ai",
  "Council on Strategic Risks": "council-on-strategic-risks",
  "Secure AI Project": "secure-ai-project",
  "Swift Centre": "swift-centre",

  // --- EA Orgs ---
  "Centre for Effective Altruism": "cea",
  CEA: "cea",
  "Effective Ventures Foundation": "cea",
  "Effective Ventures": "cea",
  "80,000 Hours": "80000-hours",
  "80000 Hours": "80000-hours",
  "80 000 Hours": "80000-hours",
  "Eighty Thousand Hours": "80000-hours",
  "Giving What We Can": "giving-what-we-can",
  GWWC: "giving-what-we-can",
  "Founders Pledge": "founders-pledge",
  "Longview Philanthropy": "longview-philanthropy",
  "Rethink Priorities": "rethink-priorities",
  "1Day Sooner": "1day-sooner",
  "1DaySooner": "1day-sooner",
  "1DaySooner and Rethink Priorities": "1day-sooner",
  "EA Global": "ea-global",

  // --- Funders/Philanthropies ---
  "Open Philanthropy": "coefficient-giving",
  "Open Philanthropy Project": "coefficient-giving",
  "Open Phil": "coefficient-giving",
  "Survival and Flourishing Fund": "survival-and-flourishing-fund",
  SFF: "survival-and-flourishing-fund",
  "Survival and Flourishing .Fund": "survival-and-flourishing-fund",
  "Good Ventures": "good-ventures",
  "Good Ventures Foundation": "good-ventures",
  GiveWell: "givewell",
  GiveDirectly: "givedirectly",
  "Against Malaria Foundation": "against-malaria-foundation",
  AMF: "against-malaria-foundation",
  Manifund: "manifund",
  "Long-Term Future Fund": "ltff",
  "Long Term Future Fund": "ltff",
  LTFF: "ltff",
  "Schmidt Futures": "schmidt-futures",
  "Hewlett Foundation": "hewlett-foundation",
  "William and Flora Hewlett Foundation": "hewlett-foundation",
  "MacArthur Foundation": "macarthur-foundation",
  "John D. and Catherine T. MacArthur Foundation": "macarthur-foundation",
  "Chan Zuckerberg Initiative": "chan-zuckerberg-initiative",
  CZI: "chan-zuckerberg-initiative",
  "FTX Future Fund": "ftx-future-fund",
  "FTX Foundation": "ftx-future-fund",
  "Astralis Foundation": "astralis-foundation",

  // --- Forecasting/Epistemic ---
  Metaculus: "metaculus",
  "Quantified Uncertainty Research Institute": "quri",
  QURI: "quri",
  "Forecasting Research Institute": "fri",
  FRI: "fri",
  Elicit: "elicit",
  Ought: "elicit",
  "Manifold Markets": "manifold",
  Manifold: "manifold",
  "Good Judgment Project": "good-judgment",
  "Good Judgment Inc": "good-judgment",
  "Good Judgment Open": "good-judgment",
  Samotsvety: "samotsvety",
  Polymarket: "polymarket",
  Metaforecast: "metaforecast",
  Kalshi: "kalshi",

  // --- Biosecurity ---
  "Nuclear Threat Initiative": "nti-bio",
  "NTI | Bio": "nti-bio",
  "NTI Bio": "nti-bio",
  NTI: "nti-bio",
  SecureBio: "securebio",
  "Secure Bio": "securebio",
  SecureDNA: "securedna",
  "Secure DNA": "securedna",
  "Blueprint Biosecurity": "blueprint-biosecurity",
  "Johns Hopkins Center for Health Security": "johns-hopkins-center-for-health-security",
  "Johns Hopkins Bloomberg School of Public Health": "johns-hopkins-center-for-health-security",
  IBBIS: "ibbis",
  "International Biosecurity and Biosafety Initiative for Science": "ibbis",
  "Coalition for Epidemic Preparedness Innovations": "coalition-for-epidemic-preparedness-innovations",
  CEPI: "coalition-for-epidemic-preparedness-innovations",
  "Red Queen Bio": "red-queen-bio",
  "Center for Applied Rationality": "center-for-applied-rationality",
  CFAR: "center-for-applied-rationality",

  // --- Research/Analysis ---
  "AI Impacts": "ai-impacts",
  "Epoch AI": "epoch-ai",
  Epoch: "epoch-ai",
  "ARB Research": "arb-research",

  // --- Tech Companies ---
  Microsoft: "microsoft",
  "Microsoft Corporation": "microsoft",
  NVIDIA: "nvidia",
  "Nvidia Corporation": "nvidia",
  Meta: "meta-ai",
  "Meta AI": "meta-ai",
  "Meta Platforms": "meta-ai",
  "Meta Platforms, Inc.": "meta-ai",

  // --- People (common grant recipients) ---
  "Paul Christiano": "paul-christiano",
  "Nuno Sempere": "nuno-sempere",
  "Leopold Aschenbrenner": "leopold-aschenbrenner",

  // --- Other ---
  "FutureSearch": "futuresearch",
  Sentinel: "sentinel",
  "Squiggle": "squiggle",
};

export function buildEntityMatcher(): EntityMatcher {
  const nameMap = new Map<string, EntityMatch>();

  // Load KB data from kb-data.json (database.json strips the kb field)
  let kbData: { slugToEntityId?: Record<string, string>; entities?: Record<string, { name?: string; aliases?: string[] }> } = {};
  const kbDataPath = resolve("apps/web/src/data/kb-data.json");
  try {
    kbData = JSON.parse(readFileSync(kbDataPath, "utf8"));
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(
        `kb-data.json not found — run 'pnpm build-data:content' first. Entity matching will be limited to manual overrides.`
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
