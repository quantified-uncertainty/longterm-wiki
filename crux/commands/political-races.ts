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

  // ---- Races (25 original + 8 new = 33 total) ----
  const races = [
    // === FEDERAL HOUSE ===
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
      aiAngleSummary: "The NY-12 Democratic primary is the highest-profile race in the 2026 AI policy battle. Alex Bores, author of the RAISE Act, faces challengers backed by Leading the Future ($125M anti-regulation PAC). Think Big PAC spent $1.95M opposing Bores. Jobs and Democracy PAC (Anthropic-backed via Public First Action) supports Bores with $450K. Polymarket has prediction markets: Lasher 47-52%, Bores 19-22%.",
      source: "https://techcrunch.com/2026/03/03/ai-companies-are-spending-millions-to-thwart-this-former-tech-execs-congressional-bid/",
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
      outcomeDetails: "Foushee won by <1% (49.18% vs 48.22%) with $1.6M Jobs and Democracy PAC support",
      aiAngle: "Jobs and Democracy PAC (Anthropic-backed) spent $1.6M supporting Foushee. Co-Chair of House Democratic Commission on AI.",
      source: "https://prospect.org/2026/02/25/ai-anthropic-claude-super-pac-valerie-foushee-congress-north-carolina/",
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
      outcomeDetails: "Jesse Jackson Jr. lost comeback attempt despite $1.4M Think Big PAC support",
      aiAngle: "Think Big PAC spent $1.4M backing Jackson Jr.; he lost despite PAC spending",
      source: "https://fortune.com/2026/03/18/ai-crypto-illinois-primary-spending-fairshake-think-big-pac/",
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
      outcomeDetails: "Melissa Bean won with $1.1M Think Big PAC support",
      aiAngle: "Think Big PAC spent $1.1M backing Bean; anti-regulation candidate won",
      source: "https://fortune.com/2026/03/18/ai-crypto-illinois-primary-spending-fairshake-think-big-pac/",
    },
    {
      id: "Tm1uIiblgl",
      name: "TX-10 Republican Primary 2026",
      raceType: "primary" as const,
      party: "republican",
      level: "federal_house" as const,
      state: "TX",
      district: "TX-10",
      electionDate: "2026-03-03",
      status: "resolved" as const,
      outcome: "jJ0yCaVU9E",
      outcomeDetails: "Chris Gober won primary with American Mission PAC support ($500K+)",
      aiAngle: "First candidate backed by Leading the Future's GOP arm. Gober is former Elon Musk attorney and America PAC director.",
      source: "https://www.axios.com/2026/03/05/openai-primaries-spending-house-candidates",
    },
    {
      id: "liBzC5keD5",
      name: "NC-1 Republican Primary 2026",
      raceType: "primary" as const,
      party: "republican",
      level: "federal_house" as const,
      state: "NC",
      district: "NC-1",
      electionDate: "2026-03-03",
      status: "resolved" as const,
      outcome: "mGJWs0I9DR",
      outcomeDetails: "Laurie Buckhout won with $500K American Mission PAC support",
      aiAngle: "American Mission PAC spent $500K; Buckhout is former DOD deputy assistant secretary for cyber policy. Faces Don Davis (D) in competitive fall race.",
      source: "https://www.wunc.org/politics/2026-03-03/laurie-buckhout-wins-gop-congressional-primary-rep-don-davis",
    },
    {
      id: "N3TLHE9u95",
      name: "NJ-5 General Election 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_house" as const,
      state: "NJ",
      district: "NJ-5",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Jobs and Democracy PAC (Anthropic-backed) spent $300K supporting Gottheimer. He co-chairs House Democratic Commission on AI.",
      source: "https://www.nbcnews.com/politics/2026-election/ads-ai-industry-are-flooding-2026-election-artificial-intelligence-rcna260782",
    },
    {
      id: "ljwYiP8HPI",
      name: "TX-9 Republican Primary Runoff 2026",
      raceType: "runoff" as const,
      party: "republican",
      level: "federal_house" as const,
      state: "TX",
      district: "TX-9",
      electionDate: "2026-05-26",
      status: "upcoming" as const,
      aiAngle: "Defending Our Values PAC (Anthropic-backed) supporting Alex Mealer. Pro-regulation PAC backing a Republican candidate.",
      source: "https://www.nbcnews.com/politics/2026-election/ads-ai-industry-are-flooding-2026-election-artificial-intelligence-rcna260782",
    },
    {
      id: "RMMie6xbBt",
      name: "TX-35 Republican Primary Runoff 2026",
      raceType: "runoff" as const,
      party: "republican",
      level: "federal_house" as const,
      state: "TX",
      district: "TX-35",
      electionDate: "2026-05-26",
      status: "upcoming" as const,
      aiAngle: "Defending Our Values PAC (Anthropic-backed via Public First Action) backed De La Cruz as part of pro-regulation Republican slate. Key House battleground.",
      source: "https://sanantonioreport.org/texas-35-congressional-district-primary-election-results/",
    },
    // === FEDERAL SENATE ===
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
      aiAngle: "Defending Our Values PAC (Anthropic-backed) launched six-figure ad buy supporting Ricketts and his AI chip export legislation. Ricketts on Senate Commerce Committee.",
      source: "https://www.cnbc.com/2026/02/12/anthropic-gives-20-million-to-group-pushing-for-ai-regulations-.html",
    },
    {
      id: "rqsHoGm69I",
      name: "Texas Senate Republican Runoff 2026",
      raceType: "runoff" as const,
      party: "republican",
      level: "federal_senate" as const,
      state: "TX",
      district: "TX-Sen",
      electionDate: "2026-05-26",
      status: "upcoming" as const,
      aiAngle: "Cornyn (Commerce Committee) vs Paxton. Paxton led coalition opposing federal AI preemption of state laws. Both campaigns used AI-generated attack ads.",
      source: "https://www.texastribune.org/2026/02/19/texas-2026-primaries-ai-ads-candidates-crockett-cornyn-paxton/",
    },
    {
      id: "iyaXMdA4w0",
      name: "Michigan Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "MI",
      district: "MI-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "McMorrow built campaign on AI/kids safety regulation. Rogers (R) backs AI deregulation framework. Key toss-up Senate seat.",
      source: "https://www.axios.com/2026/02/09/senate-mallory-mcmorrow-michigan-kids-online-safety",
    },
    {
      id: "8mcyqvWkfB",
      name: "North Carolina Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "NC",
      district: "NC-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "NC was biggest AI PAC battleground state. Race projected most expensive in history ($500M-$1B). Balance-of-power implications for AI legislation.",
      source: "https://www.wunc.org/politics/2026-03-09/democrat-roy-cooper-defy-north-carolina-winning-streak-senate-race",
    },
    {
      id: "p01cOr273G",
      name: "Georgia Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "GA",
      district: "GA-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Mike Collins used AI deepfake of Ossoff in attack ad. Swing state Senate battle for AI legislation control.",
      source: "https://www.cbsnews.com/atlanta/news/georgia-rep-mike-collins-campaign-uses-ai-generated-deepfake-of-senator-jon-ossoff-in-tight-senate-showdown/",
    },
    {
      id: "1VZyeYdjFS",
      name: "Maine Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "ME",
      district: "ME-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Top Democratic pickup target. Collins' bipartisan tech policy record. Seat shift could determine Senate control over AI legislation. Rated Toss-Up.",
      source: "https://centerforpolitics.org/crystalball/senate-rating-change-maine-moves-from-leans-republican-to-toss-up/",
    },
    // === GOVERNORS ===
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
      aiAngle: "Defending Our Values PAC (Anthropic-backed) running ads promoting Blackburn's children's online safety legislation record.",
      source: "https://www.cnbc.com/2026/02/12/anthropic-gives-20-million-to-group-pushing-for-ai-regulations-.html",
    },
    {
      id: "lR6nDhxJlc",
      name: "Florida Governor 2026",
      raceType: "general" as const,
      party: null,
      level: "state_governor" as const,
      state: "FL",
      district: "FL-Gov",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Leading the Future pledged $5M for Donalds. He opposes DeSantis-backed AI regulation. Will determine Florida's AI regulatory posture.",
      source: "https://www.nbcnews.com/politics/2026-election/super-pac-backed-ai-titans-pledges-5-million-boost-byron-donalds-run-f-rcna258612",
    },
    // === ADDITIONAL SENATE (competitive / third-party dynamics) ===
    {
      id: "aK5eNaT026",
      name: "Alaska Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "AK",
      district: "AK-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Low AI policy salience. Sullivan is mainstream R with no strong AI position. Peltola focused on resource/fisheries issues. Ranked-choice voting neutralizes spoiler effect.",
      notes: "Uses ranked-choice voting (top-4 jungle primary Aug 18). Spoiler dynamics mitigated by RCV.",
      source: "https://centerforpolitics.org/crystalball/alaska-senate-race-comes-onto-the-competitive-board-with-peltolas-entry/",
    },
    {
      id: "nH5eNaT026",
      name: "New Hampshire Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "NH",
      district: "NH-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Low direct AI policy relevance. Open seat (Shaheen retiring). Lean D. Key for overall Senate control which determines AI legislation prospects.",
      source: "https://ballotpedia.org/United_States_Senate_election_in_New_Hampshire,_2026",
    },
    {
      id: "iA5eNaT026",
      name: "Iowa Senate 2026",
      raceType: "general" as const,
      party: null,
      level: "federal_senate" as const,
      state: "IA",
      district: "IA-Sen",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Low direct AI policy relevance. Open seat (Ernst retiring). Lean R but competitive. Key for overall Senate control.",
      source: "https://en.wikipedia.org/wiki/2026_United_States_Senate_elections",
    },
    // === ADDITIONAL GOVERNORS (democratic resilience) ===
    {
      id: "mI5Gov2026",
      name: "Michigan Governor 2026",
      raceType: "general" as const,
      party: null,
      level: "state_governor" as const,
      state: "MI",
      district: "MI-Gov",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Trifecta control at stake. Governor controls election admin in critical swing state. Michigan has independent redistricting commission but governor influences other democratic guardrails.",
      notes: "Democratic backsliding relevance: HIGH. Controls election certification, voter access laws. 2024 margin <3%.",
      source: "https://www.cookpolitical.com/ratings/governor-race-ratings",
    },
    {
      id: "wI5Gov2026",
      name: "Wisconsin Governor 2026",
      raceType: "general" as const,
      party: null,
      level: "state_governor" as const,
      state: "WI",
      district: "WI-Gov",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Low direct AI relevance. Critical for democratic resilience: governor's veto protects recently restored fair legislative maps. A Republican governor could sign new gerrymandered maps.",
      notes: "Democratic backsliding relevance: VERY HIGH. Veto power over redistricting is the firewall for fair maps.",
      source: "https://www.cookpolitical.com/ratings/governor-race-ratings",
    },
    {
      id: "gA5Gov2026",
      name: "Georgia Governor 2026",
      raceType: "general" as const,
      party: null,
      level: "state_governor" as const,
      state: "GA",
      district: "GA-Gov",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Low direct AI relevance. Democratic backsliding flashpoint: Raffensperger (who resisted pressure to overturn 2020 results) is running. Race is referendum on election integrity.",
      notes: "Democratic backsliding relevance: VERY HIGH. Raffensperger candidacy = direct referendum on election integrity norms.",
      source: "https://centerforpolitics.org/crystalball/handicapping-the-2026-state-legislative-map-a-first-look/",
    },
    {
      id: "aZ5Gov2026",
      name: "Arizona Governor 2026",
      raceType: "general" as const,
      party: null,
      level: "state_governor" as const,
      state: "AZ",
      district: "AZ-Gov",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Low direct AI relevance. Governor controls election certification in state where 2022 certification was contested. Lean D.",
      notes: "Democratic backsliding relevance: HIGH. Controls election certification process that was contested in 2022.",
      source: "https://www.cookpolitical.com/ratings/governor-race-ratings",
    },
    {
      id: "iA5Gov2026",
      name: "Iowa Governor 2026",
      raceType: "general" as const,
      party: null,
      level: "state_governor" as const,
      state: "IA",
      district: "IA-Gov",
      electionDate: "2026-11-03",
      status: "active" as const,
      aiAngle: "Low direct AI relevance. Open seat (Reynolds retiring). Dem recruit Rob Sand (State Auditor) has strong cross-party approval. Tariff-hit economy may favor Democrats.",
      source: "https://centerforpolitics.org/crystalball/the-governors-part-two-familiar-battlegrounds-dot-2026-map-but-watch-for-upsets-in-open-seats/",
    },
    // === BALLOT MEASURES ===
    {
      id: "51a0on9XH1",
      name: "California Parents & Kids Safe AI Act",
      raceType: "ballot_measure" as const,
      party: null,
      level: "ballot_measure" as const,
      state: "CA",
      electionDate: "2026-11-03",
      status: "upcoming" as const,
      measureTitle: "Parents & Kids Safe AI Act",
      measureDescription: "Requires AI chatbot developers to use age-estimation, apply protective filters for under-18 users, mandate annual independent safety audits reported to CA AG, prohibit targeted advertising and data sharing for minors, and ban emotional manipulation of kids by AI.",
      aiAngle: "Joint initiative by OpenAI and Common Sense Media. First state-level AI chatbot audit regime. Signature deadline June 24, 2026.",
      source: "https://www.axios.com/2026/01/09/openai-kids-safety-california-ballot-measure",
    },
    {
      id: "eDtnnUSs86",
      name: "California Charitable Research Oversight Board",
      raceType: "ballot_measure" as const,
      party: null,
      level: "ballot_measure" as const,
      state: "CA",
      electionDate: "2026-11-03",
      status: "upcoming" as const,
      measureTitle: "Oversight of Nonprofit Research Organizations",
      measureDescription: "Creates a Charitable Research Oversight Board within DOJ. Establishes charitable encumbrance requiring assets of qualifying orgs be used per original charitable purposes. Can reverse nonprofit-to-for-profit conversions after Jan 1 2024. Requires board approval before expanding advanced AI capabilities.",
      aiAngle: "Directly targets OpenAI's nonprofit-to-for-profit conversion. Filed by Suchir Balaji's mother. Backed by CANI Coalition (50+ orgs) and SF Foundation.",
      source: "https://sfstandard.com/2025/12/03/open-ai-suchi-balaji-poornima-rao-nonprofit-ballot-measure/",
    },
    {
      id: "jH4sV9WMpw",
      name: "California AI & Smartphone Safety for Minors",
      raceType: "ballot_measure" as const,
      party: null,
      level: "ballot_measure" as const,
      state: "CA",
      electionDate: "2026-11-03",
      status: "upcoming" as const,
      measureTitle: "AI Safety and Smartphone Restrictions for Minors",
      measureDescription: "Mandates risk assessments and warning labels for AI products used by minors. Bans AI chatbots simulating human relationships with children. Extends data protection to all under-18. Enables private litigation for AI-caused harm. Bans personal device use at school.",
      aiAngle: "Original Common Sense Media standalone initiative. More restrictive than the joint OpenAI/CSM measure. Enables private lawsuits for AI harm.",
      source: "https://news.ballotpedia.org/2025/12/11/five-ballot-initiatives-filed-in-california-to-regulate-artificial-intelligence-and-its-developers/",
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

  // ---- Candidates (32 original + 12 new = 44 total) ----
  const candidates = [
    // === NY-12 ===
    { id: "fxl5cRngKV", raceId: "TSXwV8b755", candidateEntityId: "W2B4vrLpsU", candidateDisplayName: "Alex Bores", status: "running" as const, party: "democrat", aiStance: "pro_regulation" as const, pacEntityId: "cI2xccoTjv", pacDisplayName: "Jobs and Democracy PAC", pacAmount: 450000, pacPosition: "support" as const, endorsements: "RAISE Act author, Anthropic-backed PAC support" },
    { id: "0E1k0wanh7", raceId: "TSXwV8b755", candidateEntityId: "bxc9r4rOAn", candidateDisplayName: "Micah Lasher", status: "running" as const, party: "democrat", aiStance: "anti_regulation" as const, pacEntityId: "iqEF0amsJM", pacDisplayName: "Think Big PAC", pacAmount: 1950000, pacPosition: "support" as const },
    { id: "e5mWtEcmiK", raceId: "TSXwV8b755", candidateEntityId: "XIHqP2pPI0", candidateDisplayName: "Jack Schlossberg", status: "running" as const, party: "democrat", aiStance: "neutral" as const },
    { id: "zIP2VOi2f2", raceId: "TSXwV8b755", candidateEntityId: "6lQRx57F7M", candidateDisplayName: "Mike Conway", status: "running" as const, party: "democrat", aiStance: "neutral" as const },
    // === NC-4 Primary (resolved) ===
    { id: "py3bfUWyRp", raceId: "LDge8ou24V", candidateEntityId: "aJJNryIYDC", candidateDisplayName: "Valerie Foushee", isIncumbent: true, isWinner: true, voteShare: 0.4918, status: "won" as const, party: "democrat", aiStance: "pro_regulation" as const, pacEntityId: "cI2xccoTjv", pacDisplayName: "Jobs and Democracy PAC", pacAmount: 1600000, pacPosition: "support" as const, endorsements: "Co-Chair House Democratic Commission on AI" },
    { id: "w7zvVwCUeD", raceId: "LDge8ou24V", candidateEntityId: "L9zuCKRaWC", candidateDisplayName: "Nida Allam", voteShare: 0.4822, status: "lost" as const, party: "democrat", aiStance: "neutral" as const },
    // === IL-2 (resolved) ===
    { id: "9UEXcsNoEs", raceId: "ZyQ5x9tybH", candidateEntityId: "69tAH5XWON", candidateDisplayName: "Jesse Jackson Jr.", status: "lost" as const, party: "democrat", aiStance: "anti_regulation" as const, pacEntityId: "iqEF0amsJM", pacDisplayName: "Think Big PAC", pacAmount: 1400000, pacPosition: "support" as const },
    // === IL-8 (resolved) ===
    { id: "oS2G8YGDOL", raceId: "TXjvrAw4pC", candidateEntityId: "PnwPk4Vcau", candidateDisplayName: "Melissa Bean", isWinner: true, status: "won" as const, party: "democrat", aiStance: "anti_regulation" as const, pacEntityId: "iqEF0amsJM", pacDisplayName: "Think Big PAC", pacAmount: 1100000, pacPosition: "support" as const },
    // === TX-10 (resolved) ===
    { id: "8VK1JjVxdR", raceId: "Tm1uIiblgl", candidateEntityId: "jJ0yCaVU9E", candidateDisplayName: "Chris Gober", isWinner: true, status: "won" as const, party: "republican", aiStance: "anti_regulation" as const, pacEntityId: "GGcOTR25tl", pacDisplayName: "American Mission PAC", pacAmount: 500000, pacPosition: "support" as const },
    // === NC-1 (resolved) ===
    { id: "FdYZHiykAT", raceId: "liBzC5keD5", candidateEntityId: "mGJWs0I9DR", candidateDisplayName: "Laurie Buckhout", isWinner: true, status: "won" as const, party: "republican", aiStance: "anti_regulation" as const, pacEntityId: "GGcOTR25tl", pacDisplayName: "American Mission PAC", pacAmount: 500000, pacPosition: "support" as const },
    // === NJ-5 ===
    { id: "jl5SoRnp71", raceId: "N3TLHE9u95", candidateEntityId: "tVEKHxyInn", candidateDisplayName: "Josh Gottheimer", isIncumbent: true, status: "running" as const, party: "democrat", aiStance: "pro_regulation" as const, pacEntityId: "cI2xccoTjv", pacDisplayName: "Jobs and Democracy PAC", pacAmount: 300000, pacPosition: "support" as const, endorsements: "Co-chair House Democratic Commission on AI, AI Workforce Training Act" },
    // === TX-9 Runoff ===
    { id: "H5FLUzbYiq", raceId: "ljwYiP8HPI", candidateEntityId: "upZRDVRpEj", candidateDisplayName: "Alex Mealer", status: "running" as const, party: "republican", aiStance: "pro_regulation" as const, pacEntityId: "r3zkBIfezx", pacDisplayName: "Defending Our Values PAC", pacPosition: "support" as const },
    // === TX-35 Runoff ===
    { id: "wnH40S6yiD", raceId: "RMMie6xbBt", candidateEntityId: "cuRfFRqEWH", candidateDisplayName: "Carlos De La Cruz", status: "running" as const, party: "republican", aiStance: "pro_regulation" as const, pacEntityId: "r3zkBIfezx", pacDisplayName: "Defending Our Values PAC", pacPosition: "support" as const, endorsements: "Trump-endorsed, Air Force veteran" },
    // === NE Senate ===
    { id: "UPY0UhmHv8", raceId: "fmor5oDhMK", candidateEntityId: "E6W6VILiNn", candidateDisplayName: "Pete Ricketts", isIncumbent: true, status: "running" as const, party: "republican", aiStance: "mixed" as const, pacEntityId: "r3zkBIfezx", pacDisplayName: "Defending Our Values PAC", pacPosition: "support" as const, endorsements: "Senate Commerce Committee, AI chip export legislation" },
    // === TX Senate Runoff ===
    { id: "HcUTyPKrXC", raceId: "rqsHoGm69I", candidateEntityId: "4TO1jXYozt", candidateDisplayName: "John Cornyn", isIncumbent: true, status: "running" as const, party: "republican", aiStance: "mixed" as const, endorsements: "Senate Commerce Committee member" },
    { id: "07bt2Vs6h4", raceId: "rqsHoGm69I", candidateEntityId: "bIat5xswtM", candidateDisplayName: "Ken Paxton", status: "running" as const, party: "republican", aiStance: "pro_regulation" as const, notes: "Led 16 TX state senators opposing federal AI preemption. Used AI deepfake in attack ad." },
    // === MI Senate ===
    { id: "NTV2WwJUbp", raceId: "iyaXMdA4w0", candidateEntityId: "MufHpHOmRJ", candidateDisplayName: "Mallory McMorrow", status: "running" as const, party: "democrat", aiStance: "pro_regulation" as const, endorsements: "Campaign built on AI/kids safety regulation" },
    { id: "nzto8klwDn", raceId: "iyaXMdA4w0", candidateEntityId: "Wxqv54AslU", candidateDisplayName: "Haley Stevens", status: "running" as const, party: "democrat", aiStance: "mixed" as const },
    { id: "rxUkgtZjGD", raceId: "iyaXMdA4w0", candidateEntityId: "rTJq3v2HV6", candidateDisplayName: "Mike Rogers", status: "running" as const, party: "republican", aiStance: "anti_regulation" as const, endorsements: "Trump-endorsed, endorsed White House AI deregulation framework" },
    // === NC Senate ===
    { id: "7b6nUs9it5", raceId: "8mcyqvWkfB", candidateEntityId: "uOwPoVTf2h", candidateDisplayName: "Roy Cooper", status: "running" as const, party: "democrat", aiStance: "neutral" as const },
    { id: "SlNqSTfjXz", raceId: "8mcyqvWkfB", candidateEntityId: "7ucfe1TgTW", candidateDisplayName: "Michael Whatley", status: "running" as const, party: "republican", aiStance: "neutral" as const, endorsements: "Former RNC Chair, Trump-endorsed" },
    // === GA Senate ===
    { id: "rTzuF1tpfG", raceId: "p01cOr273G", candidateEntityId: "N2rG9yPZ9K", candidateDisplayName: "Jon Ossoff", isIncumbent: true, status: "running" as const, party: "democrat", aiStance: "neutral" as const, notes: "Subject of AI deepfake attack ad by opponent" },
    { id: "VZPP4xzOKw", raceId: "p01cOr273G", candidateDisplayName: "Mike Collins", status: "running" as const, party: "republican", aiStance: "neutral" as const, notes: "Used AI deepfake of Ossoff in attack ad" },
    // === ME Senate ===
    { id: "U8hQu1gcoX", raceId: "1VZyeYdjFS", candidateEntityId: "5NoqE8uJSr", candidateDisplayName: "Susan Collins", isIncumbent: true, status: "running" as const, party: "republican", aiStance: "mixed" as const, notes: "Only R incumbent in a state Harris won. Top D pickup target." },
    { id: "mE3pL8Rich", raceId: "1VZyeYdjFS", candidateDisplayName: "Tim Rich", status: "running" as const, aiStance: "neutral" as const, notes: "Independent candidate. Hotelier. Maine has strong independent tradition (Angus King won governorship as independent). Could pull from either side." },
    // === NC Senate — third-party candidates ===
    { id: "nC3pBrayLb", raceId: "8mcyqvWkfB", candidateDisplayName: "Shannon Bray", status: "running" as const, party: "libertarian", aiStance: "neutral" as const, notes: "Libertarian nominee. NC historically decided by thin margins — Tillis never won a majority. Could draw libertarian-leaning voters from either side. Key spoiler risk." },
    { id: "nC3pMcGnGr", raceId: "8mcyqvWkfB", candidateDisplayName: "Brian McGinnis", status: "running" as const, party: "green", aiStance: "neutral" as const, notes: "Green Party nominee. Presence alongside Libertarian creates cross-cutting third-party dynamics in a toss-up race." },
    // === AK Senate ===
    { id: "aK3pPeltla", raceId: "aK5eNaT026", candidateDisplayName: "Mary Peltola", status: "running" as const, party: "democrat", aiStance: "neutral" as const, notes: "Former House member, first Alaska Native in Congress. Won 2022 special election. Leads Sullivan in some polls (49-47%). Ranked-choice voting mitigates spoiler concerns." },
    { id: "aK3pSullvn", raceId: "aK5eNaT026", candidateDisplayName: "Dan Sullivan", isIncumbent: true, status: "running" as const, party: "republican", aiStance: "neutral" as const, notes: "Mainstream R incumbent. Trump won AK by 13 points but Peltola has shown crossover appeal." },
    // === NH Senate ===
    { id: "nH3pPappas", raceId: "nH5eNaT026", candidateDisplayName: "Chris Pappas", status: "running" as const, party: "democrat", aiStance: "neutral" as const, notes: "Current House member. First major candidate to enter the race." },
    { id: "nH3pSununu", raceId: "nH5eNaT026", candidateDisplayName: "John Sununu", status: "running" as const, party: "republican", aiStance: "neutral" as const, notes: "Former US Senator (lost to Shaheen 2008). Brother of Gov. Chris Sununu who declined to run." },
    { id: "nH3pBrownR", raceId: "nH5eNaT026", candidateDisplayName: "Scott Brown", status: "running" as const, party: "republican", aiStance: "neutral" as const, notes: "Former MA Senator. Was 2014 nominee, narrowly lost to Shaheen." },
    // === IA Senate ===
    // Candidates TBD — primaries not yet held. Ernst retiring creates open seat.
    // === MI Governor ===
    // Candidates TBD — primaries not yet held.
    // === WI Governor ===
    // Candidates TBD — primaries not yet held. Current gov is D.
    // === GA Governor ===
    { id: "gA3pRaffns", raceId: "gA5Gov2026", candidateDisplayName: "Brad Raffensperger", status: "running" as const, party: "republican", aiStance: "neutral" as const, notes: "Sec. of State who resisted Trump's pressure to overturn 2020 results. His candidacy is a direct referendum on election integrity norms." },
    // === AZ Governor ===
    // Candidates TBD — primaries not yet held. Lean D.
    // === IA Governor ===
    { id: "iA3pSandDm", raceId: "iA5Gov2026", candidateDisplayName: "Rob Sand", status: "running" as const, party: "democrat", aiStance: "neutral" as const, notes: "Iowa State Auditor. Surprisingly strong approval among Independents and Republicans. Strong D recruit in R-trending state." },
    // === TN Governor ===
    { id: "s6sZkb16IO", raceId: "WVvIzjS9NL", candidateEntityId: "enf2UNKyDx", candidateDisplayName: "Marsha Blackburn", status: "running" as const, party: "republican", aiStance: "pro_regulation" as const, pacEntityId: "r3zkBIfezx", pacDisplayName: "Defending Our Values PAC", pacPosition: "support" as const, endorsements: "Co-sponsor Future of AI Innovation Act, children's online safety legislation" },
    // === FL Governor ===
    { id: "7rzBYbMvsy", raceId: "lR6nDhxJlc", candidateEntityId: "5mkCGqtYnA", candidateDisplayName: "Byron Donalds", status: "running" as const, party: "republican", aiStance: "anti_regulation" as const, pacEntityId: "pg7Ym4EQ9A", pacDisplayName: "Leading the Future", pacAmount: 5000000, pacPosition: "support" as const, endorsements: "Trump-endorsed, opposes DeSantis AI regulation" },
    // === CA Ballot Measures ===
    { id: "t7iy3eb2x2", raceId: "51a0on9XH1", candidateDisplayName: "For (OpenAI + Common Sense Media)", status: "running" as const, aiStance: "pro_regulation" as const, notes: "OpenAI held $10M in campaign committee" },
    { id: "4nGjL5y6jX", raceId: "51a0on9XH1", candidateDisplayName: "Against (CITED, Tech Oversight CA)", status: "running" as const, aiStance: "anti_regulation" as const, notes: "Critics say measure defines harm too narrowly, shields AI companies" },
    { id: "eAlRYrMWIJ", raceId: "eDtnnUSs86", candidateDisplayName: "For (CANI Coalition)", status: "running" as const, aiStance: "pro_regulation" as const, notes: "Backed by SF Foundation and 50+ organizations" },
    { id: "6C2vi0IKQe", raceId: "eDtnnUSs86", candidateDisplayName: "Against (OpenAI)", status: "running" as const, aiStance: "anti_regulation" as const },
    { id: "A2d7Kgnw0b", raceId: "jH4sV9WMpw", candidateDisplayName: "For (Common Sense Media)", status: "running" as const, aiStance: "pro_regulation" as const },
    { id: "RUsej9M8Lc", raceId: "jH4sV9WMpw", candidateDisplayName: "Against", status: "running" as const, aiStance: "anti_regulation" as const },
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
