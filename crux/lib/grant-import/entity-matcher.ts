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
  "Machine Intelligence Research Institute (MIRI)": "miri",
  MIRI: "miri",
  "Alignment Research Center": "arc",
  "Alignment Research Center (Evals Team)": "arc",
  ARC: "arc",
  "ARC Evals": "arc-evals",
  "Alignment Research Center (Evals Team)": "arc-evals",
  "Model Evaluation and Threat Research": "metr",
  "Model Evaluation & Threat Research (METR)": "metr",
  METR: "metr",
  "Center for AI Safety": "cais",
  CAIS: "cais",
  "Center for AI Safety (CAIS)": "cais",
  "Center for AI Safety Action Fund": "cais",
  "Center for AI Safety Action Fund, Inc.": "cais",
  "Center for AI Safety, Action Fund": "cais",
  "Center for AI Safety Action Fund (CAIS AF)": "cais",
  "Center for Human-Compatible AI": "chai",
  "Center for Human-Compatible Artificial Intelligence": "chai",
  CHAI: "chai",
  "BERI-CHAI Collaboration": "chai",
  "Dr. Andrew Critch at CHAI, UC Berkeley": "chai",
  "Redwood Research": "redwood-research",
  "Redwood Research Group Inc.": "redwood-research",
  "Apollo Research": "apollo-research",
  "Apollo Academic Surveys": "apollo-research",
  Conjecture: "conjecture",
  "FAR AI": "far-ai",
  "FAR.AI": "far-ai",
  "Palisade Research": "palisade-research",
  ControlAI: "controlai",
  "Control AI": "controlai",
  Goodfire: "goodfire",
  "Seldon Lab": "seldon-lab",
  "Seldon Labs": "seldon-lab",
  SSI: "ssi",
  "Safe Superintelligence": "ssi",
  "Safe Superintelligence Inc.": "ssi",
  "Berkeley Existential Risk Initiative": "beri",
  "Berkeley Existential Risk Initiative (BERI)": "beri",
  "Berkeley Existential Risks Initiative": "beri",
  BERI: "beri",
  "BERI-CHAI Collaboration": "beri",
  "BERI-FHI Collaboration": "beri",
  "BERI-CLTC Collaboration": "beri",
  "BERI-SERI Collaboration": "beri",
  "BERI-CSER Collaboration": "beri",
  "BERI-SRL Collaboration": "beri",
  "BERI-DMIP Collaboration": "beri",
  "BERI-ALL Collaboration": "beri",
  "BERI/CSER Collaboration": "beri",
  "Global Catastrophic Risk Institute": "global-catastrophic-risk-institute",
  "Global Catastrophic Risks Institute": "global-catastrophic-risk-institute",
  "Alliance to Feed the Earth in Disasters (ALLFED)": "allfed",
  "Alliance to Feed the Earth in Disasters": "allfed",
  ALLFED: "allfed",
  "Alignment Research Engineer Accelerator": "arena-alignment",
  "Apart Research": "apart-research",
  SaferAI: "saferai",
  "AI Safety Camp": "ai-safety-camp",
  "London Initiative for Safe AI": "london-initiative-safe-ai",
  "Stanford Existential Risks Initiative": "stanford-existential-risks-initiative",
  "Stanford Existential Risk Initiative": "stanford-existential-risks-initiative",
  "Existential Risk Observatory": "existential-risk-observatory",
  "Pivotal Research": "pivotal-research",
  "Center on Long-Term Risk": "center-on-long-term-risk",
  "Centre for the Governance of AI": "govai",
  "Centre for the Governance of AI (GovAI)": "govai",
  "Centre for the Governance of AI, Future of Humanity Institute": "govai",
  "Median Group": "median-group",
  "Modeling Cooperation": "modeling-cooperation",

  // --- AI Safety Training/Community ---
  "MATS Research": "mats",
  MATS: "mats",
  "ML Alignment Theory Scholars": "mats",
  "ML Alignment & Theory Scholars Research (MATS Research)": "mats",
  "SERI ML Alignment Theory Scholars Program": "mats",
  "MATS London Ltd": "mats",
  "SERI ML Alignment & Theory Scholars": "mats",
  BlueDot: "bluedot-impact",
  "BlueDot Impact": "bluedot-impact",
  Constellation: "constellation",
  "AI Safety Support": "ai-safety-support",
  LessWrong: "lesswrong",
  "LessWrong 2.0": "lesswrong",
  Lighthaven: "lighthaven",
  "Lightcone Infrastructure": "lighthaven",
  "Lightcone Infrastructure Inc.": "lighthaven",
  "Stampy / AISafety.info": "stampy-aisafety-info",
  "AI Safety Info": "stampy-aisafety-info",
  "Cambridge Boston Alignment Initiative": "cambridge-boston-alignment-initiative",

  // --- Policy/Governance Orgs ---
  "Center for Security and Emerging Technology": "cset",
  CSET: "cset",
  "Future of Humanity Institute": "fhi",
  FHI: "fhi",
  "Future of Humanity Institute, Research Scholars Programme": "fhi",
  "Future of Humanity Institute: Research Scholars Programme": "fhi",
  "Future of Humanity Foundation": "fhi",
  "BERI-FHI Collaboration": "fhi",
  "Centre for the Study of Existential Risk": "cser",
  CSER: "cser",
  "Centre for the Study of Existential Risk, University of Cambridge": "cser",
  "BERI-CSER Collaboration": "cser",
  "BERI/CSER Collaboration": "cser",
  GovAI: "govai",
  "Centre for Governance of AI (GovAI)": "govai",
  "Centre for Governance of AI": "govai",
  "Center for Governance of AI": "govai",
  "Centre for the Governance of AI": "govai",
  "Centre for the Governance of AI (GovAI)": "govai",
  "Centre for the Governance of AI, Future of Humanity Institute": "govai",
  "Centre for the Governance of AI.": "govai",
  "Institute for AI Policy and Strategy": "iaps",
  IAPS: "iaps",
  "The Institute for AI Policy and Strategy (IAPS)": "iaps",
  "Future of Life Institute": "fli",
  FLI: "fli",
  "Centre for Long-Term Resilience": "centre-for-long-term-resilience",
  CLTR: "centre-for-long-term-resilience",
  "Centre for Long Term Resilience": "centre-for-long-term-resilience",
  "Centre for Long-Term Resilience (CLTR)": "centre-for-long-term-resilience",
  "The Centre for Long-Term Resilience (CLTR)": "centre-for-long-term-resilience",
  "The Centre for Long-Term Resilience (Alpenglow Group Limited)":
    "centre-for-long-term-resilience",
  "Alpenglow Group Limited": "centre-for-long-term-resilience",
  Alpenglow: "centre-for-long-term-resilience",
  "UK AI Safety Institute": "uk-aisi",
  "UK AISI": "uk-aisi",
  "US AI Safety Institute": "us-aisi",
  "US AISI": "us-aisi",
  RAND: "rand",
  "RAND Corporation": "rand",
  "RAND Corporation [Technology and Security Policy Center]": "rand",
  "Global Partnership on AI": "gpai",
  GPAI: "gpai",
  "NIST AI": "nist-ai",
  "Frontier Model Forum": "frontier-model-forum",
  "Pause AI": "pause-ai",
  PauseAI: "pause-ai",
  "PauseAI US": "pause-ai",
  "Council on Strategic Risks": "council-on-strategic-risks",
  "Secure AI Project": "secure-ai-project",
  "Swift Centre": "swift-centre",
  "Center for Global Development": "center-for-global-development",
  "Center for Global Development Europe": "center-for-global-development",
  "Legal Priorities Project": "legal-priorities-project",
  "Global Priorities Institute": "global-priorities-institute",
  "Simon Institute for Longterm Governance": "simon-institute",
  "Center for a New American Security": "cnas",
  "Federation of American Scientists": "federation-of-american-scientists",
  "Institute for Progress": "institute-for-progress",
  "Foundation for American Innovation": "foundation-for-american-innovation",
  "Foundation for American Innovation (FAI)": "foundation-for-american-innovation",
  "Niskanen Center": "niskanen-center",
  "Carnegie Endowment for International Peace": "carnegie-endowment",
  "Oxford China Policy Lab": "oxford-china-policy-lab",
  "Bipartisan Commission on Biodefense": "bipartisan-commission-biodefense",
  "Blue Ribbon Study Panel on Biodefense": "bipartisan-commission-biodefense",
  "Georgetown Center for Global Health Science and Security": "georgetown-cghss",
  "Georgetown University Initiative on Innovation, Development, and Evaluation": "georgetown-university",
  "Vera Institute of Justice": "vera-institute",
  "The Future Society": "the-future-society",
  "The Future Society, Inc.": "the-future-society",
  "The Future Society (TFS)": "the-future-society",
  "Collective Intelligence Project": "collective-intelligence-project",

  // --- EA Orgs ---
  "Centre for Effective Altruism": "cea",
  CEA: "cea",
  "Centre for Effective Altruism (CEA)": "cea",
  "Effective Ventures Foundation": "cea",
  "Effective Ventures": "cea",
  "Effective Ventures Foundation USA": "cea",
  "Effective Altruism Foundation": "cea",
  "The Effective Altruism Foundation": "cea",
  "Effective Altruism Funds": "cea",
  "EA Infrastructure Fund": "cea",
  "Community Health and Special Projects team at the Centre for Effective Altruism":
    "cea",
  "Online Team at the Centre for Effective Altruism": "cea",
  "The Events team at the Centre for Effective Altruism": "cea",
  "Wytham Abbey": "cea",
  "Centre for Effective Altruism,Effective Ventures Foundation USA": "cea",
  "80,000 Hours": "80000-hours",
  "80000 Hours": "80000-hours",
  "80 000 Hours": "80000-hours",
  "Eighty Thousand Hours": "80000-hours",
  "Giving What We Can": "giving-what-we-can",
  GWWC: "giving-what-we-can",
  "Founders Pledge": "founders-pledge",
  "Longview Philanthropy": "longview-philanthropy",
  "Rethink Priorities": "rethink-priorities",
  "Rethink Priorities (RP) [AI Strategy Team]": "rethink-priorities",
  "Rethink Priorities (RP) [Worldview Investigation Team]": "rethink-priorities",
  "Rethink Priorities, Worldview Investigations Team": "rethink-priorities",
  "The AI Governance & Strategy team within Rethink Priorities": "rethink-priorities",
  "The Rethink Priorities Existential Security Team (XST)": "rethink-priorities",
  "1Day Sooner": "1day-sooner",
  "1DaySooner": "1day-sooner",
  "1DaySooner and Rethink Priorities": "1day-sooner",
  "EA Global": "ea-global",
  "Effective Altruism Norway": "ea-norway",
  "Czech Association for Effective Altruism (CZEA)": "czea",
  "Czech Association for Effective Altruism": "czea",
  CZEA: "czea",
  "Effektiv Altruism Sverige (EA Sweden)": "ea-sweden",
  "Effective Altruism Funds": "ea-funds",
  "Charity Entrepreneurship": "charity-entrepreneurship",
  "Charity Entrepreneurship (CE)": "charity-entrepreneurship",
  "Effective Altruism Geneva": "ea-geneva",
  "Effective Altruism Poland": "ea-poland",
  "The Polish Foundation for Effective Altruism": "ea-poland",
  "The Polish Foundation for Effective Altruism (previously EA Poland)": "ea-poland",
  "Effective Altruism Netherlands (EAN)": "ea-netherlands",
  "Effective Altruism Singapore": "ea-singapore",
  "Effective Altruism Finland Ry": "ea-finland",
  "Effective Altruism Finland ry": "ea-finland",
  "Effective Altruism Israel": "ea-israel",
  "Effective Altruism Foundation": "ea-foundation",
  "The Effective Altruism Foundation": "ea-foundation",
  "Effective Altruism New Zealand": "ea-new-zealand",
  "Effective Altruism Australia": "ea-australia",
  "Effective Altruism Denmark": "ea-denmark",
  "Effective Altruism Austria": "ea-austria",
  "Effective Ventures Foundation USA": "effective-ventures-usa",
  "Cambridge Effective Altruism CIC": "cambridge-ea",
  "Effective Altruism and Consulting Network (EACN)": "ea-funds",
  "One for the World": "one-for-the-world",
  "Non-Trivial": "non-trivial",
  "Non-Trivial (fiscally sponsored by Effective Ventures Foundation)": "non-trivial",
  "Probably Good": "probably-good",
  "Atlas Fellowship": "atlas-fellowship",
  "High Impact Engineers": "high-impact-engineers",
  "High Impact Athletes": "high-impact-athletes",
  "Generation Pledge": "generation-pledge",
  CEEALAR: "ceealar",
  "Ambitious Impact": "ambitious-impact",
  "Training for Good": "training-for-good",
  "Effective Institutions Project": "effective-institutions-project",
  "Effective Institutions Project (EIP)": "effective-institutions-project",
  "Sentience Institute": "sentience-institute",
  "Arcadia Impact": "arcadia-impact",
  "The Unjournal": "the-unjournal",
  "Charter Cities Institute": "charter-cities-institute",
  "The Charter Cities Institute": "charter-cities-institute",
  "Center for Innovative Governance Research (dba Charter Cities Institute)": "charter-cities-institute",
  "Our World in Data": "our-world-in-data",
  IDinsight: "idinsight",
  "Innovations for Poverty Action": "innovations-for-poverty-action",
  "Convergent Research": "convergent-research",
  "Foresight Institute": "foresight-institute",

  // --- Funders/Philanthropies ---
  "Open Philanthropy": "coefficient-giving",
  "Open Philanthropy Project": "coefficient-giving",
  "Open Phil": "coefficient-giving",
  "Open Phil AI Fellowship": "coefficient-giving",
  "Survival and Flourishing Fund": "sff",
  SFF: "sff",
  "Survival and Flourishing .Fund": "sff",
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
  "The Quantified Uncertainty Research Institute": "quri",
  QURI: "quri",
  "Forecasting Research Institute": "fri",
  FRI: "fri",
  Elicit: "elicit",
  Ought: "elicit",
  "Manifold Markets": "manifold",
  Manifold: "manifold",
  "Good Judgment Project": "good-judgment",
  "Good Judgment Inc": "good-judgment",
  "Good Judgment Inc.": "good-judgment",
  "Good Judgment Open": "good-judgment",
  Samotsvety: "samotsvety",
  Polymarket: "polymarket",
  Metaforecast: "metaforecast",
  Kalshi: "kalshi",
  Hypermind: "good-judgment",

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
  "Center for Applied Rationality (CFAR)": "center-for-applied-rationality",
  CFAR: "center-for-applied-rationality",
  "Center for Applied Rationality (CFAR)": "center-for-applied-rationality",

  // --- Research/Analysis ---
  "AI Impacts": "ai-impacts",
  "Epoch AI": "epoch-ai",
  Epoch: "epoch-ai",
  "Epoch Artificial Intelligence, Inc.": "epoch-ai",
  "ARB Research": "arb-research",
  "The Good Food Institute": "good-food-institute",

  // --- Tech Companies ---
  Microsoft: "microsoft",
  "Microsoft Corporation": "microsoft",
  NVIDIA: "nvidia",
  "Nvidia Corporation": "nvidia",
  Meta: "meta-ai",
  "Meta AI": "meta-ai",
  "Meta Platforms": "meta-ai",
  "Meta Platforms, Inc.": "meta-ai",

  // --- Universities ---
  "University of California, Berkeley": "uc-berkeley",
  "UC Berkeley": "uc-berkeley",
  "Effective Altruism at UC Berkeley": "uc-berkeley",
  "EA Berkeley": "uc-berkeley",
  "Center for Effective Global Action at UC Berkeley": "uc-berkeley",
  "Stanford University": "stanford-university",
  "Center for International Security and Cooperation": "stanford-university",
  "University of Oxford": "university-of-oxford",
  "Harvard University": "harvard-university",
  "Harvard Effective Altruism": "harvard-university",
  "University of Pennsylvania": "university-of-pennsylvania",
  "Yale University": "yale-university",
  "Yale University School of Medicine": "yale-university",
  "University of Southern California": "usc",
  "Princeton University": "princeton-university",
  "New York University": "nyu",
  "New York University, Stern School of Business": "nyu",
  "Effective Altruism at New York University": "nyu",
  "University of Washington": "university-of-washington",
  "University of Washington (Institute for Protein Design)": "university-of-washington",
  "University of Chicago": "university-of-chicago",
  "Massachusetts Institute of Technology": "mit",
  MIT: "mit",
  "Massachusetts Institute of Technology Media Lab": "mit",
  "MIT Synthetic Neurobiology Group": "mit",
  "Columbia University": "columbia-university",
  "Columbia EA": "columbia-university",
  "Carnegie Mellon University": "carnegie-mellon-university",
  "Georgetown University": "georgetown-university",
  "University of Michigan": "university-of-michigan",
  "University of Maryland": "university-of-maryland",
  "University of California, Davis": "uc-davis",
  "University of California, San Francisco": "uc-san-francisco",
  Dartmouth: "dartmouth-college",
  "Dartmouth College": "dartmouth-college",
  "Rutgers University": "rutgers-university",
  "Cornell University": "cornell-university",
  "Johns Hopkins University": "johns-hopkins-university",
  "Johns Hopkins University - 11/2/2022": "johns-hopkins-university",
  "Duke University": "duke-university",
  "University of Toronto": "university-of-toronto",
  "Georgia Institute of Technology": "georgia-tech",
  "Purdue University": "purdue-university",
  "Washington University in St. Louis": "washu",
  "University of Edinburgh": "university-of-edinburgh",
  "University of Edinburgh and Harvard University": "university-of-edinburgh",
  "University of Cambridge": "university-of-cambridge",
  "Brown University": "brown-university",
  "Brown Effective Altruism": "brown-university",
  "Northeastern University": "northeastern-university",
  "University of Notre Dame": "university-of-notre-dame",
  "University of Glasgow": "university-of-glasgow",
  "University of Utah": "university-of-utah",
  "University of California, Los Angeles": "uc-los-angeles",
  "Effective Altruism at UCLA": "uc-los-angeles",
  "University of Ottawa": "university-of-ottawa",

  // --- People (common grant recipients) ---
  "Paul Christiano": "paul-christiano",
  "Nuno Sempere": "nuno-sempere",
  "Leopold Aschenbrenner": "leopold-aschenbrenner",

  // --- Other ---
  "FutureSearch": "futuresearch",
  Sentinel: "sentinel",
  "Squiggle": "squiggle",
  "Topos Institute": "topos-institute",
  Topos: "topos-institute",
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
