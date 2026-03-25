/**
 * Political Races Command Handlers
 *
 * Manage political races and candidates tracked for AI policy relevance.
 *
 * Usage:
 *   crux tb races list                       List all races
 *   crux tb races show <id>                  Show race details + candidates
 *   crux tb races seed                       Seed 2026 initial data
 *   crux tb races stats                      Show summary statistics
 */

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../lib/command-types.ts";
import {
  apiRequest,
  getServerUrl,
} from "../lib/wiki-server/client.ts";

interface CommandOptions extends BaseOptions {
  status?: string;
  level?: string;
  state?: string;
  ci?: boolean;
  limit?: string;
}

// ---- list command ----

async function listCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.level) params.set("level", options.level);
  if (options.state) params.set("state", options.state);
  if (options.limit) params.set("limit", options.limit);

  const result = await apiRequest<{
    races: Array<{
      id: string;
      name: string;
      status: string;
      electionDate: string | null;
      state: string | null;
      district: string | null;
      level: string;
      aiAngle: string | null;
    }>;
    total: number;
  }>("GET", `/api/political-races/all?${params}`);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  const { races, total } = result.data;

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  if (races.length === 0) {
    return {
      exitCode: 0,
      output: "No political races found.\nSeed data with: crux tb races seed",
    };
  }

  const lines = races.map((r) => {
    const date = r.electionDate ?? "TBD";
    const statusIcon =
      r.status === "resolved" ? "\u2705" :
      r.status === "active" ? "\uD83D\uDD35" :
      r.status === "upcoming" ? "\u23F3" : "\u274C";
    return `  ${statusIcon} ${r.name} (${date}) [${r.status}]`;
  });

  return {
    exitCode: 0,
    output: `Political Races (${total} total)\n\n${lines.join("\n")}`,
  };
}

// ---- show command ----

async function showCommand(
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const id = args[0];
  if (!id) {
    return { exitCode: 1, output: "Usage: crux tb races show <race-id>" };
  }

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const result = await apiRequest<{
    id: string;
    name: string;
    raceType: string;
    party: string | null;
    level: string;
    state: string | null;
    district: string | null;
    electionDate: string | null;
    status: string;
    outcome: string | null;
    aiAngle: string | null;
    aiAngleSummary: string | null;
    candidates: Array<{
      id: string;
      candidateDisplayName: string;
      status: string;
      aiStance: string | null;
      pacDisplayName: string | null;
      pacAmount: number | null;
      voteShare: number | null;
    }>;
  }>("GET", `/api/political-races/${id}`);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const r = result.data;
  const lines = [
    `${r.name}`,
    `  Type: ${r.raceType} | Level: ${r.level} | Status: ${r.status}`,
    r.district ? `  District: ${r.district}` : null,
    r.electionDate ? `  Election: ${r.electionDate}` : null,
    r.aiAngle ? `  AI Angle: ${r.aiAngle}` : null,
    r.outcome ? `  Outcome: ${r.outcome}` : null,
    "",
    `  Candidates (${r.candidates.length}):`,
    ...r.candidates.map((c) => {
      const share = c.voteShare != null ? ` (${(c.voteShare * 100).toFixed(0)}%)` : "";
      const pac = c.pacDisplayName ? ` | PAC: ${c.pacDisplayName}` : "";
      const amount = c.pacAmount != null ? ` ($${(c.pacAmount / 1e6).toFixed(1)}M)` : "";
      const stance = c.aiStance ? ` [${c.aiStance}]` : "";
      return `    - ${c.candidateDisplayName}${share} [${c.status}]${stance}${pac}${amount}`;
    }),
  ].filter(Boolean);

  return { exitCode: 0, output: lines.join("\n") };
}

// ---- stats command ----

async function statsCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const result = await apiRequest<{
    races: { total: number; upcoming: number; active: number; resolved: number };
    candidates: { total: number };
  }>("GET", "/api/political-races/stats");

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const { races, candidates } = result.data;
  return {
    exitCode: 0,
    output: [
      "Political Races Stats",
      `  Total races: ${races.total}`,
      `    Upcoming: ${races.upcoming}`,
      `    Active: ${races.active}`,
      `    Resolved: ${races.resolved}`,
      `  Total candidates: ${candidates.total}`,
    ].join("\n"),
  };
}

// ---- seed command ----

async function seedCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  console.log("Seeding 2026 political races data...\n");

  // ---- Races ----
  const races = [
    {
      id: "TSXwV8b755",
      name: "NY-12 Democratic Primary 2026",
      raceType: "primary" as const,
      party: "democrat",
      level: "federal_house" as const,
      state: "NY",
      district: "NY-12",
      electionDate: "2026-06-23",
      status: "upcoming" as const,
      aiAngle: "Flagship AI regulation race: RAISE Act author Alex Bores vs anti-regulation PAC-backed challengers",
      aiAngleSummary: "The NY-12 Democratic primary is the highest-profile race in the 2026 AI policy battle. Alex Bores, author of the RAISE Act, faces challengers backed by Leading the Future ($125M anti-regulation PAC). Public First Action ($20M, Anthropic-funded) supports Bores. Polymarket has prediction markets on this race.",
      source: "https://www.nytimes.com/2026/03/15/us/politics/ai-pac-spending-midterms.html",
    },
    {
      id: "LDge8ou24V",
      name: "NC-4 Democratic Primary 2026",
      raceType: "primary" as const,
      party: "democrat",
      level: "federal_house" as const,
      state: "NC",
      district: "NC-4",
      electionDate: "2026-03-03",
      status: "resolved" as const,
      outcome: "aJJNryIYDC",
      outcomeDetails: "Incumbent Valerie Foushee won the primary",
      aiAngle: "Think Big PAC spent against incumbent; Foushee won despite PAC opposition",
    },
    {
      id: "ZyQ5x9tybH",
      name: "IL-2 Democratic Primary 2026",
      raceType: "primary" as const,
      party: "democrat",
      level: "federal_house" as const,
      state: "IL",
      district: "IL-2",
      electionDate: "2026-03-17",
      status: "resolved" as const,
      outcomeDetails: "Jesse Jackson Jr. lost comeback attempt",
      aiAngle: "American Mission PAC backed Jackson Jr.; he lost despite PAC spending",
    },
    {
      id: "TXjvrAw4pC",
      name: "IL-8 Democratic Primary 2026",
      raceType: "primary" as const,
      party: "democrat",
      level: "federal_house" as const,
      state: "IL",
      district: "IL-8",
      electionDate: "2026-03-17",
      status: "resolved" as const,
      outcome: "PnwPk4Vcau",
      outcomeDetails: "Melissa Bean won the primary",
      aiAngle: "Anti-regulation PAC-backed candidate won the primary",
    },
    {
      id: "Tm1uIiblgl",
      name: "TX-10 Republican Primary 2026",
      raceType: "primary" as const,
      party: "republican",
      level: "federal_house" as const,
      state: "TX",
      district: "TX-10",
      electionDate: "2026-05-26",
      status: "active" as const,
      aiAngle: "Anti-regulation candidate backed by tech PAC spending",
    },
    {
      id: "fmor5oDhMK",
      name: "Nebraska Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "NE",
      district: "NE-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Senate race with AI policy implications; Ricketts has tech-friendly positions",
    },
    {
      id: "WVvIzjS9NL",
      name: "Tennessee Governor 2026",
      raceType: "general" as const,
      party: null,
      level: "state_governor" as const,
      state: "TN",
      district: "TN-Gov",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Gubernatorial race with state-level AI policy implications",
    },
    {
      id: "51a0on9XH1",
      name: "California Kids AI Safety Act",
      raceType: "ballot_measure" as const,
      party: null,
      level: "ballot_measure" as const,
      state: "CA",
      electionDate: "2026-11-03",
      status: "upcoming" as const,
      measureTitle: "Kids AI Safety Act",
      measureDescription: "Ballot measure to regulate AI systems used by minors in California",
      aiAngle: "Direct AI regulation ballot measure targeting AI systems and minors",
    },
  ];

  const raceResult = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/political-races/sync",
    { items: races }
  );

  if (!raceResult.ok) {
    return { exitCode: 1, output: `Error syncing races: ${raceResult.message}` };
  }

  console.log(`  Races upserted: ${raceResult.data.upserted}`);

  // ---- Candidates ----
  const candidates = [
    // NY-12
    {
      id: "fxl5cRngKV",
      raceId: "TSXwV8b755",
      candidateEntityId: "W2B4vrLpsU",
      candidateDisplayName: "Alex Bores",
      status: "running" as const,
      party: "democrat",
      aiStance: "pro_regulation" as const,
      pacEntityId: "NeUHBH9hGa",
      pacDisplayName: "Public First Action",
      pacAmount: 5000000,
      pacPosition: "support" as const,
      endorsements: "RAISE Act author, Anthropic-backed PAC support",
    },
    {
      id: "YbGr4jFPfq",
      raceId: "TSXwV8b755",
      candidateEntityId: "YKtqDKysGb",
      candidateDisplayName: "Rebecca Lasher",
      status: "running" as const,
      party: "democrat",
      aiStance: "anti_regulation" as const,
      pacEntityId: "iqEF0amsJM",
      pacDisplayName: "Think Big PAC",
      pacAmount: 8000000,
      pacPosition: "support" as const,
    },
    {
      id: "caw46R0ZMD",
      raceId: "TSXwV8b755",
      candidateEntityId: "6b2Vi6bhfX",
      candidateDisplayName: "Brad Schlossberg",
      status: "running" as const,
      party: "democrat",
      aiStance: "neutral" as const,
    },
    {
      id: "zIP2VOi2f2",
      raceId: "TSXwV8b755",
      candidateEntityId: "6lQRx57F7M",
      candidateDisplayName: "Mike Conway",
      status: "running" as const,
      party: "democrat",
      aiStance: "neutral" as const,
    },
    // NC-4
    {
      id: "py3bfUWyRp",
      raceId: "LDge8ou24V",
      candidateEntityId: "aJJNryIYDC",
      candidateDisplayName: "Valerie Foushee",
      isIncumbent: true,
      isWinner: true,
      status: "won" as const,
      party: "democrat",
      aiStance: "neutral" as const,
    },
    // IL-2
    {
      id: "9UEXcsNoEs",
      raceId: "ZyQ5x9tybH",
      candidateEntityId: "69tAH5XWON",
      candidateDisplayName: "Jesse Jackson Jr.",
      status: "lost" as const,
      party: "democrat",
      aiStance: "anti_regulation" as const,
      pacEntityId: "GGcOTR25tl",
      pacDisplayName: "American Mission PAC",
      pacAmount: 3000000,
      pacPosition: "support" as const,
    },
    // IL-8
    {
      id: "oS2G8YGDOL",
      raceId: "TXjvrAw4pC",
      candidateEntityId: "PnwPk4Vcau",
      candidateDisplayName: "Melissa Bean",
      isWinner: true,
      status: "won" as const,
      party: "democrat",
      aiStance: "anti_regulation" as const,
    },
    // TX-10
    {
      id: "8VK1JjVxdR",
      raceId: "Tm1uIiblgl",
      candidateEntityId: "Zs43I3aG72",
      candidateDisplayName: "Jake Gober",
      status: "running" as const,
      party: "republican",
      aiStance: "anti_regulation" as const,
    },
    // NE Senate
    {
      id: "UPY0UhmHv8",
      raceId: "fmor5oDhMK",
      candidateEntityId: "E6W6VILiNn",
      candidateDisplayName: "Pete Ricketts",
      isIncumbent: true,
      status: "running" as const,
      party: "republican",
      aiStance: "anti_regulation" as const,
    },
    // TN Governor
    {
      id: "s6sZkb16IO",
      raceId: "WVvIzjS9NL",
      candidateEntityId: "enf2UNKyDx",
      candidateDisplayName: "Marsha Blackburn",
      status: "running" as const,
      party: "republican",
      aiStance: "mixed" as const,
    },
    // CA ballot measure sides
    {
      id: "t7iy3eb2x2",
      raceId: "51a0on9XH1",
      candidateDisplayName: "For",
      status: "running" as const,
      aiStance: "pro_regulation" as const,
    },
    {
      id: "4nGjL5y6jX",
      raceId: "51a0on9XH1",
      candidateDisplayName: "Against",
      status: "running" as const,
      aiStance: "anti_regulation" as const,
    },
  ];

  const candidateResult = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/political-races/candidates/sync",
    { items: candidates }
  );

  if (!candidateResult.ok) {
    return { exitCode: 1, output: `Error syncing candidates: ${candidateResult.message}` };
  }

  console.log(`  Candidates upserted: ${candidateResult.data.upserted}`);

  return {
    exitCode: 0,
    output: `\nSeed complete: ${raceResult.data.upserted} races, ${candidateResult.data.upserted} candidates`,
  };
}

// ---- Dispatch ----

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  list: listCommand,
  show: showCommand,
  stats: statsCommand,
  seed: seedCommand,
};

export const help = `Political Races — track AI-relevant political races

Commands:
  list                        List all tracked races
  show <id>                   Show race details + candidates
  stats                       Summary statistics
  seed                        Seed 2026 initial race data

Options:
  --status=<status>           Filter by status (upcoming, active, resolved)
  --level=<level>             Filter by level (federal_house, federal_senate, etc.)
  --state=<ST>                Filter by state abbreviation
  --ci                        JSON output for CI/scripting
`;
