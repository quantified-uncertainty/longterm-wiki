/**
 * Political Data Command Handlers
 *
 * Manage political scores, offices, and verify external profile links.
 *
 * Usage:
 *   crux tb political stats                          Show summary statistics
 *   crux tb political scores [--entity=<id>]         List scorecard ratings
 *   crux tb political scores ingest [--source=X]     Ingest scorecard data from external sources
 *   crux tb political offices [--entity=<id>]        List political offices
 *   crux tb political verify-links                   Verify all politician source URLs
 *   crux tb political seed-offices                   Seed office data from YAML entities
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../lib/command-types.ts";
import { writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import {
  apiRequest,
  getServerUrl,
} from "../lib/wiki-server/client.ts";
import {
  getSource,
  getAvailableSources,
  getAllSources,
  syncScoresToServer,
} from "../lib/political/scorecard-ingest.ts";
import { parseOffice } from "../lib/political/office-parser.ts";
import { resolveAllStakeholders } from "../lib/political/stakeholder-resolver.ts";

interface CommandOptions extends BaseOptions {
  entity?: string;
  ci?: boolean;
  limit?: string;
  source?: string;
  year?: string;
  dryRun?: boolean;
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

// ---- scores command (dispatches to list or ingest subcommand) ----

async function scoresCommand(
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const subcommand = args[0];

  if (subcommand === "ingest") {
    return scoresIngestCommand(args.slice(1), options);
  }

  // Default: list scores
  return scoresListCommand(options);
}

// ---- scores list (default) ----

async function scoresListCommand(
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

// ---- scores ingest ----

async function scoresIngestCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const sourceId = options.source as string | undefined;
  const yearStr = options.year as string | undefined;
  const dryRun = !!options.dryRun;

  const currentYear = new Date().getFullYear();
  const year = yearStr ? parseInt(yearStr, 10) : currentYear;

  if (isNaN(year) || year < 1900 || year > 2100) {
    return {
      exitCode: 1,
      output: `Error: Invalid year "${yearStr}". Must be between 1900 and 2100.`,
    };
  }

  // Determine which sources to fetch
  const availableSources = getAvailableSources();

  if (sourceId && !availableSources.includes(sourceId)) {
    return {
      exitCode: 1,
      output: [
        `Error: Unknown source "${sourceId}".`,
        `Available sources: ${availableSources.join(", ")}`,
      ].join("\n"),
    };
  }

  const sourcesToFetch = sourceId
    ? [getSource(sourceId)!]
    : getAllSources();

  const lines: string[] = [
    `Scorecard Ingestion — Year: ${year}`,
    `Sources: ${sourcesToFetch.map((s) => s.id).join(", ")}`,
    dryRun ? "Mode: DRY RUN (no data will be synced)" : "Mode: LIVE (will sync to wiki-server)",
    "",
  ];

  let totalRecords = 0;
  let totalUpserted = 0;
  let hasErrors = false;

  for (const source of sourcesToFetch) {
    lines.push(`--- ${source.name} ---`);

    try {
      const fetchResult = await source.fetch(year);

      if (fetchResult.warnings.length > 0) {
        for (const w of fetchResult.warnings) {
          lines.push(`  Warning: ${w}`);
        }
      }

      if (fetchResult.usedSampleData) {
        lines.push("  Data: Sample data (source could not be scraped)");
      } else {
        lines.push("  Data: Live data from source");
      }

      lines.push(`  Records fetched: ${fetchResult.records.length}`);

      if (fetchResult.records.length === 0) {
        lines.push("  No records to sync.");
        lines.push("");
        continue;
      }

      totalRecords += fetchResult.records.length;

      // Show preview of first few records
      const preview = fetchResult.records.slice(0, 5);
      lines.push("  Preview:");
      for (const r of preview) {
        const pct =
          r.maxScore > 1
            ? `${((r.score / r.maxScore) * 100).toFixed(0)}%`
            : r.score === 1
              ? "Endorsed"
              : `${r.score}/${r.maxScore}`;
        lines.push(`    ${r.politicianDisplayName} | ${pct} | ${r.notes ?? ""}`);
      }
      if (fetchResult.records.length > 5) {
        lines.push(`    ... and ${fetchResult.records.length - 5} more`);
      }

      // Sync to wiki-server (unless dry run)
      if (!dryRun) {
        const syncResult = await syncScoresToServer(fetchResult.records);

        if (syncResult.errors.length > 0) {
          hasErrors = true;
          for (const err of syncResult.errors) {
            lines.push(`  Sync error: ${err}`);
          }
        }

        lines.push(
          `  Synced: ${syncResult.upserted}/${syncResult.totalRecords} records ` +
          `in ${syncResult.batches} batch(es)`,
        );
        totalUpserted += syncResult.upserted;
      } else {
        lines.push("  Sync: Skipped (dry run)");
      }
    } catch (err) {
      hasErrors = true;
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`  Error: ${msg}`);
    }

    lines.push("");
  }

  // Summary
  lines.push("=== Summary ===");
  lines.push(`  Total records fetched: ${totalRecords}`);
  if (!dryRun) {
    lines.push(`  Total records synced: ${totalUpserted}`);
  }
  if (hasErrors) {
    lines.push("  Status: Completed with errors");
  } else {
    lines.push("  Status: Success");
  }

  if (options.ci) {
    return {
      exitCode: hasErrors ? 1 : 0,
      output: JSON.stringify({
        year,
        sources: sourcesToFetch.map((s) => s.id),
        totalRecords,
        totalUpserted,
        dryRun,
        hasErrors,
      }, null, 2),
    };
  }

  return {
    exitCode: hasErrors ? 1 : 0,
    output: lines.join("\n"),
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

// ---- seed-offices command (uses office-parser) ----

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

  function generateId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 10; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  const offices: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];

  for (const p of politicians) {
    const desc = p.description ?? "";
    const parsed = parseOffice(desc, p.id);

    if (!parsed) {
      skipped.push(p.id);
      continue;
    }

    offices.push({
      id: generateId(),
      politicianEntityId: p.stableId!,
      politicianDisplayName: p.title,
      officeType: parsed.officeType,
      jurisdiction: parsed.jurisdiction,
      district: parsed.district,
      party: parsed.party,
      status: parsed.status,
      termStart: parsed.termStart,
      termEnd: parsed.termEnd,
    });
  }

  if (options.dryRun) {
    const lines = [`Parsed ${offices.length} offices from ${politicians.length} politicians (${skipped.length} skipped)`, ""];
    for (const o of offices.slice(0, 15)) {
      lines.push(`  ${o.politicianDisplayName} | ${o.officeType} | ${o.jurisdiction} ${o.district ?? ""} | ${o.party ?? "?"} [${o.status}]`);
    }
    if (offices.length > 15) lines.push(`  ... and ${offices.length - 15} more`);
    if (skipped.length > 0) lines.push("", `Skipped (no office parsed): ${skipped.join(", ")}`);
    return { exitCode: 0, output: lines.join("\n") };
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

  const lines = [
    `Seeded ${result.data.upserted} political offices from ${politicians.length} politician descriptions.`,
  ];
  if (skipped.length > 0) {
    lines.push(`Skipped ${skipped.length} (no office parsed): ${skipped.join(", ")}`);
  }
  return { exitCode: 0, output: lines.join("\n") };
}

// ---- resolve-stakeholders command ----

async function resolveStakeholdersCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const dataDir = join(process.cwd(), "data");
  const result = resolveAllStakeholders(dataDir);

  const lines = [
    "Stakeholder Resolution Results",
    "",
    `  Total stakeholders: ${result.totalStakeholders}`,
    `  Already linked: ${result.alreadyLinked}`,
    `  Newly resolved: ${result.resolved.length}`,
    `  Unresolved: ${result.unresolved.length}`,
    "",
  ];

  if (result.resolved.length > 0) {
    lines.push("Resolved matches:");
    for (const m of result.resolved) {
      lines.push(`  ${m.policyId}: "${m.stakeholderName}" → ${m.matchedEntityTitle} (${m.matchedEntitySlug}) [${m.method}]`);
    }
    lines.push("");
  }

  if (result.unresolved.length > 0) {
    lines.push("Unresolved:");
    for (const u of result.unresolved) {
      lines.push(`  ${u.policyId}: "${u.name}"`);
    }
    lines.push("");
  }

  if (options.dryRun || result.resolved.length === 0) {
    if (result.resolved.length > 0) {
      lines.push("Dry run — no changes written. Run without --dry-run to apply.");
    }
    return { exitCode: 0, output: lines.join("\n") };
  }

  // Apply changes to responses.yaml
  const responsesPath = join(dataDir, "entities", "responses.yaml");
  const raw = readFileSync(responsesPath, "utf-8");
  const policies = parseYaml(raw) as Array<{
    id: string;
    stakeholders?: Array<{ name: string; entityId?: string; role?: string }>;
    [key: string]: unknown;
  }>;

  // Build lookup: policyId+stakeholderName -> entityId
  const matchLookup = new Map<string, string>();
  for (const m of result.resolved) {
    matchLookup.set(`${m.policyId}::${m.stakeholderName}`, m.matchedEntityStableId);
  }

  let applied = 0;
  for (const policy of policies) {
    for (const s of policy.stakeholders ?? []) {
      if (s.entityId) continue;
      const key = `${policy.id}::${s.name}`;
      const entityId = matchLookup.get(key);
      if (entityId) {
        s.entityId = entityId;
        applied++;
      }
    }
  }

  writeFileSync(responsesPath, stringifyYaml(policies, { lineWidth: 120 }));

  lines.push(`Applied ${applied} entity ID links to responses.yaml.`);

  return { exitCode: 0, output: lines.join("\n") };
}

// ---- exports ----

export const commands = {
  stats: statsCommand,
  scores: scoresCommand,
  offices: officesCommand,
  "verify-links": verifyLinksCommand,
  "seed-offices": seedOfficesCommand,
  "resolve-stakeholders": resolveStakeholdersCommand,
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
    "  crux tb political scores ingest [--source=X]  Ingest scorecard data from external sources",
    "  crux tb political offices [--entity=<id>]     List political offices",
    "  crux tb political verify-links                Verify all politician source URLs",
    "  crux tb political seed-offices                Seed office data from YAML entities",
    "  crux tb political resolve-stakeholders        Resolve legislation stakeholder names to entity IDs",
    "",
    "Scores Ingest Options:",
    "  --source=<id>         Source to ingest from (lcv, humane-world, council-livable-world)",
    "                        Omit to ingest from all sources",
    "  --year=<YYYY>         Year to fetch (default: current year)",
    "  --dry-run             Preview without syncing to wiki-server",
    "",
    "General Options:",
    "  --entity=<stableId>   Filter by politician entity",
    "  --limit=<N>           Max results (default: 200)",
    "  --ci                  JSON output for CI/scripting",
  ].join("\n");
}
