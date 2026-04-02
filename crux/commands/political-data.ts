/**
 * Political Data Command Handlers
 *
 * Manage political scores, offices, and verify external profile links.
 *
 * Usage:
 *   crux tb political stats                    Show summary statistics
 *   crux tb political scores [--entity=<id>]   List scorecard ratings
 *   crux tb political offices [--entity=<id>]  List political offices
 *   crux tb political verify-links             Verify all politician source URLs
 *   crux tb political seed-offices             Seed office data from YAML entities
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../lib/command-types.ts";
import {
  apiRequest,
  getServerUrl,
} from "../lib/wiki-server/client.ts";

interface CommandOptions extends BaseOptions {
  entity?: string;
  ci?: boolean;
  limit?: string;
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

  const [scoresResult, officesResult] = await Promise.all([
    apiRequest<{ total: number; scorerOrgs: number; politicians: number }>(
      "GET", "/api/political-scores/stats"
    ),
    apiRequest<{ total: number; incumbents: number; candidates: number; former: number }>(
      "GET", "/api/political-offices/stats"
    ),
  ]);

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        scores: scoresResult.ok ? scoresResult.data : null,
        offices: officesResult.ok ? officesResult.data : null,
      }, null, 2),
    };
  }

  const lines = ["Political Data Stats", ""];

  if (scoresResult.ok) {
    const s = scoresResult.data;
    lines.push(
      "  Scores:",
      `    Total: ${s.total}`,
      `    Scorer orgs: ${s.scorerOrgs}`,
      `    Politicians tracked: ${s.politicians}`,
    );
  } else {
    lines.push(`  Scores: Error - ${scoresResult.message}`);
  }

  lines.push("");

  if (officesResult.ok) {
    const o = officesResult.data;
    lines.push(
      "  Offices:",
      `    Total: ${o.total}`,
      `    Incumbents: ${o.incumbents}`,
      `    Candidates: ${o.candidates}`,
      `    Former: ${o.former}`,
    );
  } else {
    lines.push(`  Offices: Error - ${officesResult.message}`);
  }

  return { exitCode: 0, output: lines.join("\n") };
}

// ---- scores command ----

async function scoresCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const params = new URLSearchParams();
  if (options.entity) params.set("politicianEntityId", options.entity);
  if (options.limit) params.set("limit", options.limit);

  const endpoint = options.entity
    ? `/api/political-scores/by-entity/${options.entity}`
    : `/api/political-scores/all?${params}`;

  const result = await apiRequest<{
    scores: Array<{
      id: string;
      politicianDisplayName: string | null;
      politician: { name: string | null } | null;
      scorerOrg: string;
      score: number;
      maxScore: number;
      year: number;
      scoreType: string | null;
    }>;
    total: number;
  }>("GET", endpoint);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const { scores, total } = result.data;
  if (scores.length === 0) {
    return { exitCode: 0, output: "No political scores found." };
  }

  const lines = scores.map((s) => {
    const name = s.politician?.name ?? s.politicianDisplayName ?? "Unknown";
    const pct = s.maxScore > 0 ? `${((s.score / s.maxScore) * 100).toFixed(0)}%` : String(s.score);
    return `  ${name} | ${s.scorerOrg} ${s.year} | ${pct}${s.scoreType ? ` (${s.scoreType})` : ""}`;
  });

  return {
    exitCode: 0,
    output: `Political Scores (${total} total)\n\n${lines.join("\n")}`,
  };
}

// ---- offices command ----

async function officesCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const endpoint = options.entity
    ? `/api/political-offices/by-entity/${options.entity}`
    : `/api/political-offices/all?limit=${options.limit ?? "200"}`;

  const result = await apiRequest<{
    offices: Array<{
      id: string;
      politicianDisplayName: string | null;
      politician: { name: string | null } | null;
      officeType: string;
      jurisdiction: string;
      district: string | null;
      party: string | null;
      status: string;
    }>;
    total: number;
  }>("GET", endpoint);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const { offices, total } = result.data;
  if (offices.length === 0) {
    return { exitCode: 0, output: "No political offices found." };
  }

  const lines = offices.map((o) => {
    const name = o.politician?.name ?? o.politicianDisplayName ?? "Unknown";
    const dist = o.district ? ` (${o.district})` : "";
    const party = o.party ? ` [${o.party.charAt(0).toUpperCase()}]` : "";
    return `  ${name}${party} | ${o.officeType} | ${o.jurisdiction}${dist} [${o.status}]`;
  });

  return {
    exitCode: 0,
    output: `Political Offices (${total} total)\n\n${lines.join("\n")}`,
  };
}

// ---- verify-links command ----

async function verifyLinksCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const dataDir = join(process.cwd(), "data", "entities");
  const peopleYaml = readFileSync(join(dataDir, "people.yaml"), "utf-8");
  const people = parseYaml(peopleYaml) as Array<{
    id: string;
    title: string;
    tags?: string[];
    sources?: Array<{ title: string; url?: string }>;
  }>;

  const politicians = people.filter(
    (p) => p.tags && p.tags.includes("politics")
  );

  console.log(`Verifying source URLs for ${politicians.length} politicians...\n`);

  let verified = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ entity: string; url: string; status: number | string }> = [];

  for (const p of politicians) {
    const sources = p.sources ?? [];
    for (const src of sources) {
      if (!src.url) {
        skipped++;
        continue;
      }

      try {
        const response = await fetch(src.url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10_000),
          headers: { "User-Agent": "LongtermWiki-LinkChecker/1.0" },
          redirect: "follow",
        });

        if (response.ok) {
          verified++;
        } else {
          failed++;
          failures.push({
            entity: p.id,
            url: src.url,
            status: response.status,
          });
          console.log(`  \u274C ${p.id}: ${src.url} (${response.status})`);
        }
      } catch (err) {
        // Try GET as fallback (some servers reject HEAD)
        try {
          const response = await fetch(src.url, {
            method: "GET",
            signal: AbortSignal.timeout(10_000),
            headers: { "User-Agent": "LongtermWiki-LinkChecker/1.0" },
            redirect: "follow",
          });
          if (response.ok) {
            verified++;
          } else {
            failed++;
            failures.push({
              entity: p.id,
              url: src.url,
              status: response.status,
            });
            console.log(`  \u274C ${p.id}: ${src.url} (${response.status})`);
          }
        } catch (getErr) {
          failed++;
          const msg = getErr instanceof Error ? getErr.message : String(getErr);
          failures.push({ entity: p.id, url: src.url, status: msg });
          console.log(`  \u274C ${p.id}: ${src.url} (${msg})`);
        }
      }
    }
  }

  if (options.ci) {
    return {
      exitCode: failed > 0 ? 1 : 0,
      output: JSON.stringify({ verified, failed, skipped, failures }, null, 2),
    };
  }

  const lines = [
    "Link Verification Results",
    "",
    `  \u2705 Verified: ${verified}`,
    `  \u274C Failed: ${failed}`,
    `  \u23ED Skipped: ${skipped}`,
  ];

  if (failures.length > 0) {
    lines.push("", "Failed URLs:");
    for (const f of failures) {
      lines.push(`  ${f.entity}: ${f.url} (${f.status})`);
    }
  }

  return { exitCode: failed > 0 ? 1 : 0, output: lines.join("\n") };
}

// ---- seed-offices command ----

async function seedOfficesCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const dataDir = join(process.cwd(), "data", "entities");
  const peopleYaml = readFileSync(join(dataDir, "people.yaml"), "utf-8");
  const people = parseYaml(peopleYaml) as Array<{
    id: string;
    stableId?: string;
    title: string;
    tags?: string[];
    description?: string;
  }>;

  const politicians = people.filter(
    (p) => p.tags && p.tags.includes("politics") && p.stableId
  );

  // Infer office data from descriptions
  const offices: Array<{
    id: string;
    politicianEntityId: string;
    politicianDisplayName: string;
    officeType: string;
    jurisdiction: string;
    district: string | null;
    party: string | null;
    status: "incumbent" | "candidate" | "former";
  }> = [];

  function deterministicId(input: string): string {
    // Deterministic 10-char ID from input string — makes seed-offices idempotent
    const hash = createHash("sha256").update(input).digest("base64url");
    return hash.substring(0, 10);
  }

  for (const p of politicians) {
    const desc = p.description ?? "";
    let officeType = "other";
    let jurisdiction = "US";
    let district: string | null = null;
    let party: string | null = null;
    let status: "incumbent" | "candidate" | "former" = "candidate";

    // Infer office type
    if (/U\.S\. Senator/i.test(desc)) officeType = "senator";
    else if (/U\.S\. Representative/i.test(desc)) officeType = "representative";
    else if (/State Senator/i.test(desc)) officeType = "state_senator";
    else if (/State Assembl/i.test(desc)) officeType = "state_representative";
    else if (/Governor/i.test(desc)) officeType = "governor";
    else if (/Attorney General/i.test(desc)) officeType = "attorney_general";

    // Infer district
    const districtMatch = desc.match(/\b([A-Z]{2})-(\d+)\b/);
    if (districtMatch) district = districtMatch[0];

    // Infer state
    const statePatterns: [RegExp, string][] = [
      [/Nebraska/i, "NE"], [/Tennessee/i, "TN"], [/Maine/i, "ME"],
      [/Texas/i, "TX"], [/Georgia/i, "GA"], [/Florida/i, "FL"],
      [/Michigan/i, "MI"], [/North Carolina/i, "NC"], [/New York/i, "NY"],
      [/New Jersey/i, "NJ"], [/Illinois/i, "IL"],
    ];
    for (const [pattern, abbr] of statePatterns) {
      if (pattern.test(desc)) { jurisdiction = abbr; break; }
    }

    // Infer party
    if (desc.includes("(D)") || /Democrat/i.test(desc)) party = "democratic";
    else if (desc.includes("(R)") || /Republican/i.test(desc)) party = "republican";

    // Infer status
    if (/incumbent/i.test(desc) || /U\.S\. Senator from/i.test(desc) || /U\.S\. Representative for/i.test(desc)) {
      status = "incumbent";
    } else if (/former/i.test(desc) || /lost/i.test(desc)) {
      status = "former";
    }

    offices.push({
      id: deterministicId(`office:${p.stableId}:${officeType}:${jurisdiction}:${district ?? ''}`),
      politicianEntityId: p.stableId!,
      politicianDisplayName: p.title,
      officeType,
      jurisdiction,
      district,
      party,
      status,
    });
  }

  console.log(`Seeding ${offices.length} political offices...\n`);

  const result = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/political-offices/sync",
    { items: offices },
  );

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  return {
    exitCode: 0,
    output: `Seeded ${result.data.upserted} political offices from YAML entity descriptions.`,
  };
}

// ---- exports ----

export const commands = {
  stats: statsCommand,
  scores: scoresCommand,
  offices: officesCommand,
  "verify-links": verifyLinksCommand,
  "seed-offices": seedOfficesCommand,
};

export function getHelp(): string {
  return [
    "Political Data Management",
    "",
    "Manage political scores, offices, and verify external profile links.",
    "",
    "Usage:",
    "  crux tb political stats                       Show summary statistics",
    "  crux tb political scores [--entity=<id>]      List scorecard ratings",
    "  crux tb political offices [--entity=<id>]     List political offices",
    "  crux tb political verify-links                Verify all politician source URLs",
    "  crux tb political seed-offices                Seed office data from YAML entities",
    "",
    "Options:",
    "  --entity=<stableId>   Filter by politician entity",
    "  --limit=<N>           Max results (default: 200)",
    "  --ci                  JSON output for CI/scripting",
  ].join("\n");
}
