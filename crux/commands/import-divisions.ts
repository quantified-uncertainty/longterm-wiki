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
import { FUNDER_IDS } from "../lib/grant-import/constants.ts";

// ---------------------------------------------------------------------------
// Org entity stableIds (from kb-data.json slugToEntityId mapping)
// ---------------------------------------------------------------------------

const ORG_IDS = {
  ...FUNDER_IDS,
  OPEN_PHILANTHROPY: "ULjDXpSLCI", // Coefficient Giving / Open Philanthropy
  ANTHROPIC: "mK9pX3rQ7n",
  OPENAI: "1LcLlMGLbw",
  DEEPMIND: "A4XoubikkQ",
  MIRI: "puAffUjWSS",
} as const;

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
  // ---- Open Philanthropy program areas ----
  {
    idSeed: "div|open-philanthropy|global-health-and-wellbeing",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Health and Wellbeing",
    divisionType: "program-area",
    status: "active",
    source: "https://www.openphilanthropy.org/focus/global-health-and-wellbeing/",
    notes: "Covers global health, farm animal welfare, and scientific research",
  },
  {
    idSeed: "div|open-philanthropy|global-catastrophic-risks",
    parentOrgId: ORG_IDS.OPEN_PHILANTHROPY,
    name: "Global Catastrophic Risks",
    divisionType: "program-area",
    status: "active",
    source: "https://www.openphilanthropy.org/focus/global-catastrophic-risks/",
    notes: "Covers AI safety, biosecurity, and other GCR-related grantmaking",
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
    name: "Survival and Flourishing Fund",
    divisionType: "fund",
    status: "active",
    source: "https://survivalandflourishing.fund/",
    notes:
      "SFF uses a simulation-based allocation process (S-Process) to distribute grants to organizations working on existential risk reduction",
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
