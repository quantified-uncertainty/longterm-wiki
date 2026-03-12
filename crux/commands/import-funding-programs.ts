/**
 * Import curated funding programs into wiki-server Postgres.
 *
 * Funding programs represent structured giving activities: grant rounds,
 * RFPs, fellowships, prizes, and solicitations from AI safety and EA funders.
 *
 * Usage:
 *   pnpm crux import-funding-programs list              # Show all programs
 *   pnpm crux import-funding-programs sync              # Sync to wiki-server
 *   pnpm crux import-funding-programs sync --dry-run    # Preview without writing
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
// Division ID helper — must match the seeds used in import-divisions.ts
// ---------------------------------------------------------------------------

function divisionId(seed: string): string {
  return generateId(seed);
}

// ---------------------------------------------------------------------------
// Funding program type (matches wiki-server SyncFundingProgramItemSchema)
// ---------------------------------------------------------------------------

interface FundingProgramDef {
  /** Deterministic ID seed — must be unique and stable across runs */
  idSeed: string;
  orgId: string;
  divisionIdSeed?: string;
  name: string;
  description?: string;
  programType: "rfp" | "grant-round" | "fellowship" | "prize" | "solicitation" | "call";
  totalBudget?: number;
  currency?: string;
  status: "open" | "closed" | "awarded";
  source?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Curated funding program data
// ---------------------------------------------------------------------------

const PROGRAMS: FundingProgramDef[] = [
  // ---- Open Philanthropy focus areas ----
  {
    idSeed: "prog|open-philanthropy|ai-safety",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|open-philanthropy|global-catastrophic-risks",
    name: "AI Safety Grantmaking",
    description:
      "Open Philanthropy's ongoing AI safety grantmaking, covering technical alignment research, governance, and field-building",
    programType: "grant-round",
    status: "open",
    source: "https://www.openphilanthropy.org/focus/artificial-intelligence/",
    notes: "Largest funder of AI safety research by total dollars committed",
  },
  {
    idSeed: "prog|open-philanthropy|biosecurity",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|open-philanthropy|global-catastrophic-risks",
    name: "Biosecurity and Pandemic Preparedness",
    description:
      "Grantmaking for biosecurity, pandemic preparedness, and related policy work",
    programType: "grant-round",
    status: "open",
    source:
      "https://www.openphilanthropy.org/focus/biosecurity-and-pandemic-preparedness/",
  },
  {
    idSeed: "prog|open-philanthropy|global-health",
    orgId: ORG_IDS.OPEN_PHILANTHROPY,
    divisionIdSeed: "div|open-philanthropy|global-health-and-wellbeing",
    name: "Global Health and Wellbeing Grantmaking",
    description:
      "Open Philanthropy's grantmaking for global health, development, and farm animal welfare",
    programType: "grant-round",
    status: "open",
    source:
      "https://www.openphilanthropy.org/focus/global-health-and-wellbeing/",
  },

  // ---- EA Funds grant rounds ----
  {
    idSeed: "prog|ea-funds|ltff-grants",
    orgId: ORG_IDS.LTFF,
    divisionIdSeed: "div|ea-funds|long-term-future-fund",
    name: "Long-Term Future Fund Grant Rounds",
    description:
      "Recurring grant rounds supporting organizations and individuals working on reducing existential risks, especially from advanced AI",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/far-future",
    notes:
      "Multiple rounds per year; managed by a committee of fund managers",
  },
  {
    idSeed: "prog|ea-funds|awf-grants",
    orgId: ORG_IDS.CEA,
    divisionIdSeed: "div|ea-funds|animal-welfare-fund",
    name: "Animal Welfare Fund Grant Rounds",
    description:
      "Recurring grant rounds for animal welfare organizations and projects",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/animal-welfare",
  },
  {
    idSeed: "prog|ea-funds|eaif-grants",
    orgId: ORG_IDS.CEA,
    divisionIdSeed: "div|ea-funds|ea-infrastructure-fund",
    name: "EA Infrastructure Fund Grant Rounds",
    description:
      "Recurring grant rounds for EA community building and infrastructure",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/ea-community",
  },
  {
    idSeed: "prog|ea-funds|ghd-grants",
    orgId: ORG_IDS.CEA,
    divisionIdSeed: "div|ea-funds|global-health-fund",
    name: "Global Health and Development Fund Grant Rounds",
    description:
      "Recurring grant rounds for evidence-based global health and development interventions",
    programType: "grant-round",
    status: "open",
    source: "https://funds.effectivealtruism.org/funds/global-health",
  },

  // ---- Survival and Flourishing Fund ----
  {
    idSeed: "prog|sff|s-process",
    orgId: ORG_IDS.SFF,
    divisionIdSeed: "div|sff|sff-main",
    name: "S-Process Grants",
    description:
      "SFF's primary grantmaking mechanism using a simulation-based allocation process where recommenders independently rank applicants",
    programType: "grant-round",
    status: "open",
    source: "https://survivalandflourishing.fund/",
    notes:
      "Uses a novel mechanism where multiple recommenders submit rankings and a simulation allocates funds based on convergence",
  },
  {
    idSeed: "prog|sff|speculation-grants",
    orgId: ORG_IDS.SFF,
    divisionIdSeed: "div|sff|sff-main",
    name: "Speculation Grants",
    description:
      "Smaller, faster-turnaround grants from SFF for promising early-stage projects and individuals",
    programType: "grant-round",
    status: "open",
    source: "https://survivalandflourishing.fund/",
    notes:
      "Complementary to S-Process; allows faster funding decisions for smaller amounts",
  },

  // ---- FTX Future Fund (historical) ----
  {
    idSeed: "prog|ftx|general-grants",
    orgId: ORG_IDS.FTX_FUTURE_FUND,
    name: "FTX Future Fund General Grants",
    description:
      "FTX Future Fund's main grantmaking program across AI safety, biosecurity, values, and institutions. Ceased operations November 2022 after FTX collapse.",
    programType: "grant-round",
    status: "closed",
    source: "https://ftxfuturefund.org/",
    notes:
      "Operational Feb-Nov 2022. Committed approximately $160M before FTX collapse. Many grants were clawed back in bankruptcy proceedings.",
  },
  {
    idSeed: "prog|ftx|regranting-program",
    orgId: ORG_IDS.FTX_FUTURE_FUND,
    name: "FTX Future Fund Regranting Program",
    description:
      "Program allowing designated regranters to make independent funding decisions using FTX Future Fund capital",
    programType: "grant-round",
    status: "closed",
    source: "https://ftxfuturefund.org/",
    notes:
      "Notable regranters included Leopold Aschenbrenner, Nuno Sempere, and others. Program ceased with FTX collapse.",
  },

  // ---- Manifund ----
  {
    idSeed: "prog|manifund|regranters",
    orgId: ORG_IDS.MANIFUND,
    name: "Manifund Regranting",
    description:
      "Platform enabling individuals to receive tax-deductible donations for regranting to effective projects",
    programType: "grant-round",
    status: "open",
    source: "https://manifund.org/",
    notes: "Manifund provides fiscal sponsorship for individual regranters",
  },
  {
    idSeed: "prog|manifund|impact-certificates",
    orgId: ORG_IDS.MANIFUND,
    name: "Manifund Impact Certificates",
    description:
      "Experimental impact certificate marketplace where project creators sell shares of their impact to retroactive funders",
    programType: "grant-round",
    status: "open",
    source: "https://manifund.org/",
    notes: "Novel funding mechanism using impact certificates/retroactive public goods funding",
  },

  // ---- ACX Grants ----
  {
    idSeed: "prog|acx|grants-2022",
    orgId: ORG_IDS.ACX_GRANTS,
    name: "ACX Grants 2022",
    description:
      "First round of ACX Grants from Astral Codex Ten blog, funding a variety of projects in rationality, EA, and scientific research",
    programType: "grant-round",
    status: "awarded",
    source: "https://www.astralcodexten.com/p/acx-grants-results",
    notes: "40+ grants from $1K-$100K+",
  },
  {
    idSeed: "prog|acx|grants-2023",
    orgId: ORG_IDS.ACX_GRANTS,
    name: "ACX Grants 2023",
    description:
      "Second round of ACX Grants, continuing to fund projects in rationality, EA, and scientific research",
    programType: "grant-round",
    status: "awarded",
    source: "https://www.astralcodexten.com/p/announcing-acx-grants-2",
  },
];

// ---------------------------------------------------------------------------
// Convert definitions to sync payloads
// ---------------------------------------------------------------------------

interface SyncFundingProgram {
  id: string;
  orgId: string;
  divisionId: string | null;
  name: string;
  description: string | null;
  programType: string;
  totalBudget: number | null;
  currency: string;
  status: string | null;
  source: string | null;
  notes: string | null;
}

function toSyncProgram(def: FundingProgramDef): SyncFundingProgram {
  return {
    id: generateId(def.idSeed),
    orgId: def.orgId,
    divisionId: def.divisionIdSeed ? divisionId(def.divisionIdSeed) : null,
    name: def.name,
    description: def.description ?? null,
    programType: def.programType,
    totalBudget: def.totalBudget ?? null,
    currency: def.currency ?? "USD",
    status: def.status,
    source: def.source ?? null,
    notes: def.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList() {
  const items = PROGRAMS.map(toSyncProgram);
  console.log(`=== Known Funding Programs (${items.length}) ===\n`);

  // Group by org
  const byOrg = new Map<string, SyncFundingProgram[]>();
  for (const item of items) {
    const existing = byOrg.get(item.orgId) || [];
    existing.push(item);
    byOrg.set(item.orgId, existing);
  }

  // Reverse lookup org names from ORG_IDS
  const idToLabel = new Map<string, string>();
  for (const [key, val] of Object.entries(ORG_IDS)) {
    if (!idToLabel.has(val)) {
      idToLabel.set(val, key);
    }
  }

  for (const [orgId, programs] of byOrg) {
    const label = idToLabel.get(orgId) || orgId;
    console.log(`${label} (${orgId}):`);
    for (const p of programs) {
      const statusBadge =
        p.status === "open"
          ? "\x1b[32mopen\x1b[0m"
          : p.status === "closed"
            ? "\x1b[31mclosed\x1b[0m"
            : "\x1b[33mawarded\x1b[0m";
      const divBadge = p.divisionId
        ? ` div:${p.divisionId}`
        : "";
      console.log(
        `  ${p.id}  ${p.name} [${p.programType}] ${statusBadge}${divBadge}`
      );
    }
    console.log("");
  }

  // Check for ID collisions
  const ids = items.map((p) => p.id);
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
  const items = PROGRAMS.map(toSyncProgram);
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  console.log(`\nSyncing ${items.length} funding programs to ${serverUrl}...`);

  if (dryRun) {
    console.log("  (dry run -- no data written)");
    for (const p of items) {
      console.log(`  ${p.id}  ${p.name} [${p.programType}]`);
    }
    return;
  }

  const result = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/funding-programs/sync",
    { items }
  );

  if (result.ok) {
    console.log(`Upserted ${result.data.upserted} funding programs`);
  } else {
    throw new Error(`Funding program sync failed: ${result.message}`);
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
Import Funding Programs — Sync curated funding programs to wiki-server

Commands:
  list               Show all known funding programs (default)
  sync               Sync programs to wiki-server Postgres
  sync --dry-run     Preview what would be synced without writing

Program Types:
  rfp            Request for proposals
  grant-round    Recurring or one-time grant round
  fellowship     Fellowship program
  prize          Prize competition
  solicitation   Open solicitation
  call           Call for applications

Statuses:
  open           Currently accepting applications
  closed         No longer accepting (e.g., FTX Future Fund)
  awarded        Completed and awards made
`;
}
