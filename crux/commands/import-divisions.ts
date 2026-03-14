/**
 * Import curated organizational divisions into wiki-server Postgres.
 *
 * Unlike grants, divisions have no external CSV source — they are a curated
 * list of known organizational units (funds, teams, departments, labs,
 * program areas) for major AI safety and EA organizations.
 *
 * Usage:
 *   pnpm crux import-divisions list              # Show all divisions
 *   pnpm crux import-divisions sync              # Sync to wiki-server
 *   pnpm crux import-divisions sync --dry-run    # Preview without writing
 */

import { generateId } from "../lib/grant-import/id.ts";
import { apiRequest, getServerUrl } from "../lib/wiki-server/client.ts";
import { ORG_IDS } from "../lib/grant-import/constants.ts";

// ---------------------------------------------------------------------------
// Division type (matches wiki-server SyncDivisionItemSchema)
// ---------------------------------------------------------------------------

interface DivisionDef {
  /** Deterministic ID seed — must be unique and stable across runs */
  idSeed: string;
  parentOrgId: string;
  name: string;
  divisionType: "fund" | "team" | "department" | "lab" | "program-area";
  status: "active" | "inactive" | "dissolved";
  startDate?: string;
  endDate?: string;
  source?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Curated division data
// ---------------------------------------------------------------------------

const DIVISIONS: DivisionDef[] = [
  // ---- Coefficient Giving / Open Philanthropy program areas ----
  {
    idSeed: "div|open-philanthropy|global-health-and-wellbeing",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Health and Wellbeing",
    divisionType: "program-area",
    status: "active",
    source: "https://coefficientgiving.org/funds/global-health-wellbeing-opportunities",
    notes: "Covers global health, farm animal welfare, and scientific research. 360+ grants; largest program area.",
  },
  {
    idSeed: "div|open-philanthropy|global-catastrophic-risks",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Catastrophic Risks",
    divisionType: "program-area",
    status: "active",
    source: "https://coefficientgiving.org/funds/global-catastrophic-risks-opportunities",
    notes: "Covers AI safety, biosecurity, and other GCR-related grantmaking. 250+ grants across cause areas.",
  },
  {
    idSeed: "div|coefficient-giving|navigating-transformative-ai",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Navigating Transformative AI",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/navigating-transformative-ai",
    notes:
      "480+ grants totaling ~$500M. Sub-areas: Technical Safety (Favaloro, O'Keeffe-O'Donovan), AI Governance (Muehlhauser), Short Timelines (Zabel). ~$63.6M in 2024 (~60% of all external AI safety funding).",
  },
  {
    idSeed: "div|coefficient-giving|biosecurity",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Biosecurity & Pandemic Preparedness",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/biosecurity-pandemic-preparedness",
    notes: "140+ grants totaling ~$260M. Led by Andrew Snyder-Beattie. Work began ~2015, five years before COVID-19.",
  },
  {
    idSeed: "div|coefficient-giving|farm-animal-welfare",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Farm Animal Welfare",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/farm-animal-welfare",
    notes: "Led by Lewis Bollard. Corporate cage-free campaigns, alt-protein research, advocacy.",
  },
  {
    idSeed: "div|coefficient-giving|science-rd",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Science and Global Health R&D",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/science-and-global-health-rd",
    notes: "330+ grants + 30+ social investments ($90M+). Led by Jacob Trefethen. Treatments, vaccines, diagnostics.",
  },
  {
    idSeed: "div|coefficient-giving|forecasting",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Forecasting",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/forecasting",
    notes: "30+ grants totaling ~$50M. Led by Benjamin Tereick. Forecasting infrastructure and research.",
  },
  {
    idSeed: "div|coefficient-giving|effective-giving-careers",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Effective Giving & Careers",
    divisionType: "fund",
    status: "active",
    source: "https://coefficientgiving.org/funds/effective-giving-and-careers",
    notes: "Led by Melanie Basnak and Sam Donald. Support for CEA, 80,000 Hours, EA Funds, and community infrastructure.",
  },
  {
    idSeed: "div|coefficient-giving|abundance-growth",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Abundance & Growth",
    divisionType: "fund",
    status: "active",
    startDate: "2025-03",
    source: "https://coefficientgiving.org/funds/abundance-and-growth",
    notes: "$120M committed over 3 years. Led by Matt Clancy. Economic growth, scientific progress, US-focused.",
  },
  {
    idSeed: "div|coefficient-giving|lead-exposure",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Lead Exposure Action Fund (LEAF)",
    divisionType: "fund",
    status: "active",
    startDate: "2024",
    source: "https://coefficientgiving.org/funds/lead-exposure-action-fund",
    notes: "$100-125M raised; 20+ grants. Multi-donor pooled fund with Gates Foundation, UNICEF, others.",
  },
  {
    idSeed: "div|coefficient-giving|global-aid-policy",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Aid Policy",
    divisionType: "fund",
    status: "active",
    startDate: "2018",
    source: "https://coefficientgiving.org/funds/global-aid-policy",
    notes: "50+ grants totaling ~$30M. Led by Norma Altshuler. Encouraging generous and cost-effective international aid.",
  },
  {
    idSeed: "div|coefficient-giving|global-growth",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Growth",
    divisionType: "fund",
    status: "active",
    startDate: "2024-10",
    source: "https://coefficientgiving.org/funds/global-growth",
    notes: "$40M+ committed over 3 years. Led by Justin Sandefur. Policy research for economic growth in low/middle-income countries.",
  },
  {
    idSeed: "div|coefficient-giving|air-quality",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Air Quality",
    divisionType: "fund",
    status: "active",
    startDate: "2022",
    source: "https://coefficientgiving.org/funds/air-quality",
    notes: "40+ grants totaling ~$20M. Led by Santosh Harish. Focus on South Asia and high-pollution areas.",
  },
  {
    idSeed: "div|coefficient-giving|criminal-justice",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Criminal Justice Reform",
    divisionType: "fund",
    status: "dissolved",
    startDate: "2014",
    endDate: "2022",
    notes: "Focused on reducing incarceration; wound down in 2022. ~$200M total grants.",
  },

  // ---- EA Funds ----
  {
    idSeed: "div|ea-funds|long-term-future-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "Long-Term Future Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/far-future",
    notes:
      "Supports organizations working on improving the long-term future, especially reducing existential risks from advanced AI",
  },
  {
    idSeed: "div|ea-funds|animal-welfare-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "Animal Welfare Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/animal-welfare",
    notes: "Supports organizations working to improve animal welfare",
  },
  {
    idSeed: "div|ea-funds|ea-infrastructure-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "EA Infrastructure Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/ea-community",
    notes:
      "Supports organizations building the effective altruism community and infrastructure",
  },
  {
    idSeed: "div|ea-funds|global-health-fund",
    parentOrgId: ORG_IDS.CEA,
    name: "Global Health and Development Fund",
    divisionType: "fund",
    status: "active",
    source: "https://funds.effectivealtruism.org/funds/global-health",
    notes:
      "Supports evidence-based organizations working to improve global health and reduce poverty",
  },

  // ---- Survival and Flourishing Fund ----
  {
    idSeed: "div|sff|sff-main",
    parentOrgId: ORG_IDS.SFF,
    name: "Survival and Flourishing Fund (Main)",
    divisionType: "fund",
    status: "active",
    source: "https://survivalandflourishing.fund/",
    notes:
      "SFF's primary fund distributing grants via the S-Process simulation-based allocation. ~$152M cumulative since 2019. Three tracks since 2025: Main, Freedom, Fairness.",
  },
  {
    idSeed: "div|sff|initiative-committee",
    parentOrgId: ORG_IDS.SFF,
    name: "Initiative Committee",
    divisionType: "team",
    status: "active",
    startDate: "2024",
    source: "https://survivalandflourishing.fund/",
    notes:
      "Small group (Jaan Tallinn, SFF Advisors, 2-5 anonymous voters) that makes proactive grants outside the S-Process rounds.",
  },

  // ---- Future of Life Institute ----
  {
    idSeed: "div|fli|grants-program",
    parentOrgId: ORG_IDS.FLI,
    name: "FLI Grants Program",
    divisionType: "program-area",
    status: "active",
    source: "https://futureoflife.org/grant-program/",
    notes:
      "FLI's grantmaking arm. $25M+ distributed since 2015 across AI safety, nuclear risk, governance, and existential risk reduction.",
  },
  {
    idSeed: "div|fli|policy-advocacy",
    parentOrgId: ORG_IDS.FLI,
    name: "Policy & Advocacy",
    divisionType: "program-area",
    status: "active",
    source: "https://futureoflife.org/",
    notes:
      "Campaigns include Asilomar Principles (5,700+ signatories), 2023 Pause Letter (33,000+ signatories), AI Act advocacy. EU and UN engagement.",
  },
  {
    idSeed: "div|fli|fellowships",
    parentOrgId: ORG_IDS.FLI,
    name: "Fellowship Programs",
    divisionType: "program-area",
    status: "active",
    startDate: "2022",
    source: "https://futureoflife.org/grant-program/phd-fellowships/",
    notes:
      "Vitalik Buterin PhD and Postdoctoral Fellowships in AI Existential Safety. Run with BAIF. 14+ PhD fellows and 4+ postdocs at top universities.",
  },

  // ---- Schmidt Futures / Schmidt Sciences ----
  {
    idSeed: "div|schmidt|ai-advanced-computing",
    parentOrgId: ORG_IDS.SCHMIDT_FUTURES,
    name: "AI & Advanced Computing",
    divisionType: "program-area",
    status: "active",
    source: "https://www.schmidtsciences.org/",
    notes:
      "One of five Schmidt Sciences centers. Includes AI2050, AI in Science, and Science of Trustworthy AI programs. $125M+ AI commitment.",
  },
  {
    idSeed: "div|schmidt|climate",
    parentOrgId: ORG_IDS.SCHMIDT_FUTURES,
    name: "Climate",
    divisionType: "program-area",
    status: "active",
    source: "https://www.schmidtsciences.org/",
    notes: "One of five Schmidt Sciences centers. $45M for carbon cycle research. Focuses on bending the carbon curve.",
  },
  {
    idSeed: "div|schmidt|science-systems",
    parentOrgId: ORG_IDS.SCHMIDT_FUTURES,
    name: "Science Systems",
    divisionType: "program-area",
    status: "active",
    source: "https://www.schmidtsciences.org/",
    notes:
      "One of five Schmidt Sciences centers. Breaking down barriers to scientific discovery by supporting people, tools, and communities.",
  },

  // ---- Manifund ----
  {
    idSeed: "div|manifund|regranting",
    parentOrgId: ORG_IDS.MANIFUND,
    name: "Regranting Platform",
    divisionType: "program-area",
    status: "active",
    source: "https://manifund.org/about/regranting",
    notes:
      "Platform enabling individuals to receive tax-deductible donations for regranting. Provides fiscal sponsorship for individual regranters.",
  },
  {
    idSeed: "div|manifund|impact-certs",
    parentOrgId: ORG_IDS.MANIFUND,
    name: "Impact Certificates",
    divisionType: "program-area",
    status: "active",
    source: "https://manifund.org",
    notes:
      "Experimental impact certificate marketplace where project creators sell shares of their impact to retroactive funders.",
  },

  // ---- DeepMind ----
  {
    idSeed: "div|deepmind|safety",
    parentOrgId: ORG_IDS.DEEPMIND,
    name: "DeepMind Safety",
    divisionType: "team",
    status: "active",
    source: "https://deepmind.google/safety/",
    notes:
      "DeepMind's AI safety research team, focused on alignment, interpretability, and responsible development",
  },

  // ---- OpenAI ----
  {
    idSeed: "div|openai|safety-systems",
    parentOrgId: ORG_IDS.OPENAI,
    name: "Safety Systems",
    divisionType: "team",
    status: "active",
    source: "https://openai.com/safety/",
    notes:
      "Responsible for content policy, monitoring, and safety tooling for deployed models",
  },
  {
    idSeed: "div|openai|preparedness",
    parentOrgId: ORG_IDS.OPENAI,
    name: "Preparedness",
    divisionType: "team",
    status: "active",
    startDate: "2023-10",
    source: "https://openai.com/preparedness/",
    notes:
      "Tracks, evaluates, forecasts, and protects against catastrophic risks from frontier AI models. Led by Aleksander Madry (after Leopoldas Aschenbrenner left).",
  },
  {
    idSeed: "div|openai|superalignment",
    parentOrgId: ORG_IDS.OPENAI,
    name: "Superalignment",
    divisionType: "team",
    status: "dissolved",
    startDate: "2023-07",
    endDate: "2024-05",
    source: "https://openai.com/index/introducing-superalignment/",
    notes:
      "Led by Ilya Sutskever and Jan Leike. Aimed to solve alignment for superintelligent AI within 4 years using 20% of compute. Dissolved May 2024 after leadership departures.",
  },

  // ---- Anthropic ----
  {
    idSeed: "div|anthropic|alignment-science",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Alignment Science",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/research",
    notes:
      "Core alignment research team at Anthropic, working on interpretability, scalable oversight, and Constitutional AI",
  },
  {
    idSeed: "div|anthropic|trust-and-safety",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Trust and Safety",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/",
    notes:
      "Responsible for content moderation, abuse prevention, and usage policy enforcement",
  },
  {
    idSeed: "div|anthropic|policy",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Policy",
    divisionType: "team",
    status: "active",
    source: "https://www.anthropic.com/policy",
    notes:
      "AI policy research and government engagement; publishes policy briefs and participates in regulatory processes",
  },
  {
    idSeed: "div|anthropic|mechanistic-interpretability",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Mechanistic Interpretability",
    divisionType: "team",
    status: "active",
    startDate: "2021-01",
    source: "https://transformer-circuits.pub/2024/scaling-monosemanticity/",
    notes:
      "Led by Chris Olah. Understanding neural network internals through reverse-engineering; ~50 person team; MIT Tech Review 2026 Breakthrough Technology.",
  },
  {
    idSeed: "div|anthropic|constitutional-ai",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Constitutional AI",
    divisionType: "team",
    status: "active",
    startDate: "2022-12",
    source: "https://arxiv.org/abs/2212.08073",
    notes:
      "Training AI systems to follow principles through self-critique and RLAIF. Core alignment technique used in all Claude models.",
  },
  {
    idSeed: "div|anthropic|sleeper-agents",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "Sleeper Agents Research",
    divisionType: "team",
    status: "active",
    startDate: "2024-01",
    source: "https://arxiv.org/abs/2401.05566",
    notes:
      "Investigating whether AI systems can maintain hidden behaviors through training. Seminal paper on deceptive alignment.",
  },
  {
    idSeed: "div|anthropic|ai-welfare",
    parentOrgId: ORG_IDS.ANTHROPIC,
    name: "AI Welfare Research",
    divisionType: "team",
    status: "active",
    startDate: "2024-01",
    source: "https://www.anthropic.com/research",
    notes:
      "Investigating moral status and welfare considerations for AI systems. Kyle Fish hired as first full-time AI welfare researcher at a major AI lab.",
  },

  // ---- MIRI ----
  {
    idSeed: "div|miri|research",
    parentOrgId: ORG_IDS.MIRI,
    name: "MIRI Research",
    divisionType: "team",
    status: "active",
    source: "https://intelligence.org/research/",
    notes:
      "Core technical research on mathematical foundations of AI alignment, including agent foundations and decision theory",
  },

  // ---- GiveWell ----
  {
    idSeed: "div|givewell|research",
    parentOrgId: ORG_IDS.GIVEWELL,
    name: "GiveWell Research",
    divisionType: "team",
    status: "active",
    source: "https://www.givewell.org/research",
    notes:
      "Cost-effectiveness research team evaluating global health and development interventions. Recommends ~$500M+ annually in grants.",
  },
];

// ---------------------------------------------------------------------------
// Convert definitions to sync payloads
// ---------------------------------------------------------------------------

interface SyncDivision {
  id: string;
  parentOrgId: string;
  name: string;
  divisionType: string;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  source: string | null;
  notes: string | null;
}

function toSyncDivision(def: DivisionDef): SyncDivision {
  return {
    id: generateId(def.idSeed),
    parentOrgId: def.parentOrgId,
    name: def.name,
    divisionType: def.divisionType,
    status: def.status,
    startDate: def.startDate ?? null,
    endDate: def.endDate ?? null,
    source: def.source ?? null,
    notes: def.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList() {
  const items = DIVISIONS.map(toSyncDivision);
  console.log(`=== Known Divisions (${items.length}) ===\n`);

  // Group by parent org
  const byOrg = new Map<string, SyncDivision[]>();
  for (const item of items) {
    const existing = byOrg.get(item.parentOrgId) || [];
    existing.push(item);
    byOrg.set(item.parentOrgId, existing);
  }

  // Reverse lookup org names from ORG_IDS
  const idToLabel = new Map<string, string>();
  for (const [key, val] of Object.entries(ORG_IDS)) {
    if (!idToLabel.has(val)) {
      idToLabel.set(val, key);
    }
  }

  for (const [orgId, divisions] of byOrg) {
    const label = idToLabel.get(orgId) || orgId;
    console.log(`${label} (${orgId}):`);
    for (const d of divisions) {
      const statusBadge =
        d.status === "active"
          ? "\x1b[32mactive\x1b[0m"
          : d.status === "dissolved"
            ? "\x1b[31mdissolved\x1b[0m"
            : "\x1b[33minactive\x1b[0m";
      console.log(
        `  ${d.id}  ${d.name} [${d.divisionType}] ${statusBadge}`
      );
    }
    console.log("");
  }

  // Check for ID collisions
  const ids = items.map((d) => d.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    console.error("WARNING: ID collisions detected!");
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) console.error(`  Duplicate ID: ${id}`);
      seen.add(id);
    }
  }
}

async function cmdSync(dryRun: boolean) {
  const items = DIVISIONS.map(toSyncDivision);
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  console.log(`\nSyncing ${items.length} divisions to ${serverUrl}...`);

  if (dryRun) {
    console.log("  (dry run -- no data written)");
    for (const d of items) {
      console.log(`  ${d.id}  ${d.name} [${d.divisionType}]`);
    }
    return;
  }

  const result = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/divisions/sync",
    { items }
  );

  if (result.ok) {
    console.log(`Upserted ${result.data.upserted} divisions`);
  } else {
    throw new Error(`Division sync failed: ${result.message}`);
  }
}

// ---------------------------------------------------------------------------
// Crux command exports
// ---------------------------------------------------------------------------

type CommandResult = { exitCode?: number; output?: string };

async function listCommand(
  _args: string[],
  _options: Record<string, unknown>
): Promise<CommandResult> {
  cmdList();
  return { exitCode: 0 };
}

async function syncCommand(
  _args: string[],
  options: Record<string, unknown>
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  await cmdSync(dryRun);
  return { exitCode: 0 };
}

export const commands = {
  list: listCommand,
  sync: syncCommand,
  default: listCommand,
};

export function getHelp(): string {
  return `
Import Divisions — Sync curated organizational divisions to wiki-server

Commands:
  list               Show all known divisions (default)
  sync               Sync divisions to wiki-server Postgres
  sync --dry-run     Preview what would be synced without writing

Division Types:
  fund           Grant-making fund (e.g., Long-Term Future Fund)
  team           Internal team (e.g., Anthropic Alignment Science)
  department     Formal department
  lab            Research lab (e.g., DeepMind Safety)
  program-area   Thematic program area (e.g., Open Phil GCR)

Statuses:
  active         Currently operating
  inactive       Paused or dormant
  dissolved      No longer exists (e.g., OpenAI Superalignment)
`;
}
