/**
 * Political Data Command Handlers
 *
 * Manage political scores, offices, campaign finance, and verify external profile links.
 *
 * Usage:
 *   crux tb political stats                          Show summary statistics
 *   crux tb political scores [--entity=<id>]         List scorecard ratings
 *   crux tb political scores ingest [--source=X]     Ingest scorecard data from external sources
 *   crux tb political offices [--entity=<id>]        List political offices
 *   crux tb political finance ingest [--cycle=YYYY]  Ingest FEC campaign finance data
 *   crux tb political finance list [--entity=X]      List campaign finance records
 *   crux tb political finance stats                  Campaign finance summary
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
  getServerUrl,
} from "../lib/wiki-server/client.ts";
import {
  getScoreStats, getOfficeStats, getVoteStats, getFinanceStats,
  syncOffices,
  getAllScores, getScoresByEntity,
  getAllOffices, getOfficesByEntity,
  getAllVotes, getVotesByEntity, getVotesByLegislation,
  getAllFinance, getFinanceByEntity,
} from "../lib/wiki-server/political.ts";
import {
  getSource,
  getAvailableSources,
  getAllSources,
  syncScoresToServer,
} from "../lib/political/scorecard-ingest.ts";
import {
  fetchFecData,
  syncFinanceToServer,
} from "../lib/political/sources/fec.ts";
import { parseOffice } from "../lib/political/office-parser.ts";
import { resolveAllStakeholders } from "../lib/political/stakeholder-resolver.ts";
import {
  buildSampleVotes,
  syncVotesToServer,
} from "../lib/political/votes-ingest.ts";

interface CommandOptions extends BaseOptions {
  entity?: string;
  ci?: boolean;
  limit?: string;
  source?: string;
  year?: string;
  cycle?: string;
  legislation?: string;
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

  const [scoresResult, officesResult, votesResult, financeResult] = await Promise.all([
    getScoreStats(),
    getOfficeStats(),
    getVoteStats(),
    getFinanceStats(),
  ]);

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        scores: scoresResult.ok ? scoresResult.data : null,
        offices: officesResult.ok ? officesResult.data : null,
        votes: votesResult.ok ? votesResult.data : null,
        finance: financeResult.ok ? financeResult.data : null,
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

  lines.push("");

  if (votesResult.ok) {
    const v = votesResult.data;
    lines.push(
      "  Votes:",
      `    Total: ${v.total}`,
      `    Politicians: ${v.politicians}`,
      `    Legislation: ${v.legislation}`,
    );
    if (Object.keys(v.breakdown).length > 0) {
      lines.push("    Breakdown:");
      for (const [vote, count] of Object.entries(v.breakdown)) {
        lines.push(`      ${vote}: ${count}`);
      }
    }
  } else {
    lines.push(`  Votes: Error - ${votesResult.message}`);
  }

  lines.push("");

  if (financeResult.ok) {
    const f = financeResult.data;
    lines.push(
      "  Campaign Finance:",
      `    Total records: ${f.total}`,
      `    Total raised: $${(f.totalRaisedSum / 1_000_000).toFixed(1)}M`,
      `    Politicians tracked: ${f.politicians}`,
      `    Election cycles: ${f.cycles}`,
    );
  } else {
    lines.push(`  Campaign Finance: Error - ${financeResult.message}`);
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

  const result = options.entity
    ? await getScoresByEntity(options.entity)
    : await getAllScores({ limit: options.limit ? parseInt(options.limit, 10) : undefined });

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

  const result = options.entity
    ? await getOfficesByEntity(options.entity)
    : await getAllOffices({ limit: options.limit ? parseInt(options.limit, 10) : 200 });

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

  const result = await syncOffices(offices as Array<Record<string, unknown>>);

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

// ---- votes command (dispatches to list, ingest, or stats subcommand) ----

async function votesCommand(
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const subcommand = args[0];

  if (subcommand === "ingest") {
    return votesIngestCommand(args.slice(1), options);
  }
  if (subcommand === "stats") {
    return votesStatsCommand(options);
  }

  // Default: list votes
  return votesListCommand(options);
}

// ---- votes list (default) ----

async function votesListCommand(
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const limitNum = options.limit ? parseInt(options.limit, 10) : undefined;

  const result = options.entity
    ? await getVotesByEntity(options.entity, { limit: limitNum })
    : options.legislation
      ? await getVotesByLegislation(options.legislation, { limit: limitNum })
      : await getAllVotes({ limit: limitNum });

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const { votes, total } = result.data;
  const breakdown = 'breakdown' in result.data ? (result.data as { breakdown?: Record<string, number> }).breakdown : undefined;
  if (votes.length === 0) {
    return { exitCode: 0, output: "No political votes found." };
  }

  const lines: string[] = [];

  if (breakdown) {
    lines.push("Vote Breakdown:");
    for (const [vote, count] of Object.entries(breakdown)) {
      lines.push(`  ${vote}: ${count}`);
    }
    lines.push("");
  }

  lines.push(`Votes (${total} total)`, "");

  for (const v of votes) {
    const name = v.politician?.name ?? v.politicianDisplayName ?? "Unknown";
    const legTitle = v.legislationTitle ?? v.legislationEntityId ?? "Unknown";
    const date = v.voteDate ?? "no date";
    const chamber = v.chamber ?? "";
    lines.push(`  ${name} | ${v.vote.toUpperCase()} | ${legTitle} | ${chamber} ${date}`);
  }

  return { exitCode: 0, output: lines.join("\n") };
}

// ---- votes ingest ----

async function votesIngestCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const dryRun = !!options.dryRun;
  const legislationFilter = options.legislation;
  const dataDir = join(process.cwd(), "data");

  const lines: string[] = [
    "Vote Data Ingestion",
    dryRun ? "Mode: DRY RUN (no data will be synced)" : "Mode: LIVE (will sync to wiki-server)",
    "",
  ];

  try {
    const result = buildSampleVotes(dataDir, legislationFilter);

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        lines.push(`Warning: ${w}`);
      }
    }

    lines.push(
      `Legislation matched: ${result.legislationCount}`,
      `Politicians matched: ${result.politicianCount}`,
      `Vote records built: ${result.records.length}`,
      "",
    );

    if (result.records.length === 0) {
      lines.push("No vote records to sync.");
      return { exitCode: 0, output: lines.join("\n") };
    }

    // Show preview
    const preview = result.records.slice(0, 10);
    lines.push("Preview:");
    for (const r of preview) {
      lines.push(
        `  ${r.politicianDisplayName} | ${r.vote.toUpperCase()} | ${r.legislationTitle.substring(0, 40)} | ${r.chamber}`
      );
    }
    if (result.records.length > 10) {
      lines.push(`  ... and ${result.records.length - 10} more`);
    }
    lines.push("");

    if (!dryRun) {
      const syncResult = await syncVotesToServer(result.records);

      if (syncResult.errors.length > 0) {
        for (const err of syncResult.errors) {
          lines.push(`Sync error: ${err}`);
        }
      }

      lines.push(
        `Synced: ${syncResult.upserted}/${syncResult.totalRecords} records in ${syncResult.batches} batch(es)`,
      );

      if (options.ci) {
        return {
          exitCode: syncResult.errors.length > 0 ? 1 : 0,
          output: JSON.stringify({
            legislationCount: result.legislationCount,
            politicianCount: result.politicianCount,
            totalRecords: result.records.length,
            upserted: syncResult.upserted,
            dryRun,
            hasErrors: syncResult.errors.length > 0,
          }, null, 2),
        };
      }
    } else {
      lines.push("Sync: Skipped (dry run)");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`Error: ${msg}`);
    return { exitCode: 1, output: lines.join("\n") };
  }

  return { exitCode: 0, output: lines.join("\n") };
}

// ---- votes stats ----

async function votesStatsCommand(
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const result = await getVoteStats();

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const s = result.data;
  const lines = [
    "Political Votes Stats",
    "",
    `  Total votes: ${s.total}`,
    `  Politicians: ${s.politicians}`,
    `  Legislation: ${s.legislation}`,
    `  Chambers: ${s.chambers}`,
    "",
    "  Vote Breakdown:",
  ];

  for (const [vote, count] of Object.entries(s.breakdown)) {
    lines.push(`    ${vote}: ${count}`);
  }

  return { exitCode: 0, output: lines.join("\n") };
}

// ---- finance command (dispatches to ingest, list, or stats subcommand) ----

async function financeCommand(
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const subcommand = args[0];

  if (subcommand === "ingest") {
    return financeIngestCommand(args.slice(1), options);
  }
  if (subcommand === "stats") {
    return financeStatsCommand(options);
  }
  if (subcommand === "list" || !subcommand) {
    return financeListCommand(options);
  }

  return {
    exitCode: 1,
    output: `Unknown finance subcommand: "${subcommand}". Use: ingest, list, stats`,
  };
}

// ---- finance ingest ----

async function financeIngestCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const cycleStr = options.cycle as string | undefined;
  const dryRun = !!options.dryRun;

  // Default to current election cycle (even year)
  const currentYear = new Date().getFullYear();
  const defaultCycle = currentYear % 2 === 0 ? currentYear : currentYear + 1;
  const cycle = cycleStr ? parseInt(cycleStr, 10) : defaultCycle;

  if (isNaN(cycle) || cycle < 1990 || cycle > 2100) {
    return {
      exitCode: 1,
      output: `Error: Invalid cycle "${cycleStr}". Must be an even year between 1990 and 2100.`,
    };
  }

  if (cycle % 2 !== 0) {
    return {
      exitCode: 1,
      output: `Error: FEC election cycles are even years (e.g. 2024, 2026). Got: ${cycle}`,
    };
  }

  const lines: string[] = [
    `FEC Campaign Finance Ingestion — Cycle: ${cycle}`,
    dryRun ? "Mode: DRY RUN (no data will be synced)" : "Mode: LIVE (will sync to wiki-server)",
    "",
  ];

  try {
    const fetchResult = await fetchFecData(cycle);

    if (fetchResult.warnings.length > 0) {
      for (const w of fetchResult.warnings) {
        lines.push(`  Warning: ${w}`);
      }
    }

    if (fetchResult.usedSampleData) {
      lines.push("  Data: Sample data (FEC API could not be reached)");
    } else {
      lines.push("  Data: Live data from FEC API");
    }

    lines.push(`  Records fetched: ${fetchResult.records.length}`);

    if (fetchResult.records.length === 0) {
      lines.push("  No records to sync.");
      return { exitCode: 0, output: lines.join("\n") };
    }

    // Show preview
    const preview = fetchResult.records.slice(0, 10);
    lines.push("", "  Preview:");
    for (const r of preview) {
      const raised = r.totalRaised
        ? `$${(r.totalRaised / 1_000_000).toFixed(1)}M`
        : "N/A";
      const entityMatch = r.politicianEntityId ? " [matched]" : "";
      lines.push(
        `    ${r.politicianDisplayName} (${r.party ?? "?"}-${r.state ?? "?"}) | ${r.officeType ?? "?"} | Raised: ${raised}${entityMatch}`,
      );
    }
    if (fetchResult.records.length > 10) {
      lines.push(`    ... and ${fetchResult.records.length - 10} more`);
    }

    // Count entity matches
    const matched = fetchResult.records.filter(
      (r) => r.politicianEntityId != null,
    ).length;
    lines.push(
      "",
      `  Entity matches: ${matched}/${fetchResult.records.length}`,
    );

    // Sync to wiki-server (unless dry run)
    if (!dryRun) {
      lines.push("");
      const syncResult = await syncFinanceToServer(fetchResult.records);

      if (syncResult.errors.length > 0) {
        for (const err of syncResult.errors) {
          lines.push(`  Sync error: ${err}`);
        }
      }

      lines.push(
        `  Synced: ${syncResult.upserted}/${syncResult.totalRecords} records ` +
        `in ${syncResult.batches} batch(es)`,
      );
    } else {
      lines.push("", "  Sync: Skipped (dry run)");
    }

    if (options.ci) {
      return {
        exitCode: 0,
        output: JSON.stringify(
          {
            cycle,
            totalRecords: fetchResult.records.length,
            entityMatches: matched,
            usedSampleData: fetchResult.usedSampleData,
            dryRun,
          },
          null,
          2,
        ),
      };
    }

    return { exitCode: 0, output: lines.join("\n") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `Error: ${msg}` };
  }
}

// ---- finance list ----

async function financeListCommand(
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const result = options.entity
    ? await getFinanceByEntity(options.entity)
    : await getAllFinance({
        limit: options.limit ? parseInt(options.limit, 10) : 200,
        cycle: options.cycle,
      });

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const { records, total } = result.data;
  if (records.length === 0) {
    return { exitCode: 0, output: "No campaign finance records found." };
  }

  const lines = records.map((r) => {
    const name = r.politician?.name ?? r.politicianDisplayName ?? "Unknown";
    const raised = r.totalRaised
      ? `$${(r.totalRaised / 1_000_000).toFixed(1)}M`
      : "N/A";
    const spent = r.totalSpent
      ? `$${(r.totalSpent / 1_000_000).toFixed(1)}M`
      : "N/A";
    const party = r.party ? `[${r.party.charAt(0)}]` : "";
    return `  ${name} ${party} | ${r.officeType ?? "?"} ${r.state ?? ""} | Cycle ${r.cycle} | Raised: ${raised} | Spent: ${spent}`;
  });

  return {
    exitCode: 0,
    output: `Campaign Finance Records (${total} total)\n\n${lines.join("\n")}`,
  };
}

// ---- finance stats ----

async function financeStatsCommand(
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: "Error: LONGTERMWIKI_SERVER_URL not configured" };
  }

  const result = await getFinanceStats();

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const s = result.data;
  const lines = [
    "Campaign Finance Stats",
    "",
    `  Total records: ${s.total}`,
    `  Total raised (all records): $${(s.totalRaisedSum / 1_000_000).toFixed(1)}M`,
    `  Politicians tracked: ${s.politicians}`,
    `  Election cycles: ${s.cycles}`,
  ];

  if (s.topFundraisers.length > 0) {
    lines.push("", "  Top Fundraisers:");
    for (const t of s.topFundraisers.slice(0, 10)) {
      const name = t.politician?.name ?? t.politicianDisplayName ?? "Unknown";
      const raised = t.totalRaised
        ? `$${(t.totalRaised / 1_000_000).toFixed(1)}M`
        : "N/A";
      const party = t.party ? `[${t.party.charAt(0)}]` : "";
      lines.push(
        `    ${name} ${party} | ${t.officeType ?? "?"} ${t.state ?? ""} | ${raised}`,
      );
    }
  }

  return { exitCode: 0, output: lines.join("\n") };
}

// ---- exports ----

export const commands = {
  stats: statsCommand,
  scores: scoresCommand,
  offices: officesCommand,
  votes: votesCommand,
  finance: financeCommand,
  "verify-links": verifyLinksCommand,
  "seed-offices": seedOfficesCommand,
  "resolve-stakeholders": resolveStakeholdersCommand,
};

export function getHelp(): string {
  return [
    "Political Data Management",
    "",
    "Manage political scores, offices, votes, campaign finance, and verify external profile links.",
    "",
    "Usage:",
    "  crux tb political stats                             Show summary statistics",
    "  crux tb political scores [--entity=<id>]            List scorecard ratings",
    "  crux tb political scores ingest [--source=X]        Ingest scorecard data from external sources",
    "  crux tb political offices [--entity=<id>]           List political offices",
    "  crux tb political votes [--entity=X] [--legislation=X]  List voting records",
    "  crux tb political votes ingest [--legislation=X]    Fetch and sync vote data",
    "  crux tb political votes stats                       Vote summary statistics",
    "  crux tb political finance ingest [--cycle=YYYY]     Ingest FEC campaign finance data",
    "  crux tb political finance list [--entity=X]         List campaign finance records",
    "  crux tb political finance stats                     Campaign finance summary",
    "  crux tb political verify-links                      Verify all politician source URLs",
    "  crux tb political seed-offices                      Seed office data from YAML entities",
    "  crux tb political resolve-stakeholders              Resolve legislation stakeholder names to entity IDs",
    "",
    "Scores Ingest Options:",
    "  --source=<id>         Source to ingest from (lcv, humane-world, council-livable-world)",
    "                        Omit to ingest from all sources",
    "  --year=<YYYY>         Year to fetch (default: current year)",
    "  --dry-run             Preview without syncing to wiki-server",
    "",
    "Finance Options:",
    "  --cycle=<YYYY>        Election cycle year (default: current even year)",
    "  --dry-run             Preview without syncing to wiki-server",
    "",
    "Votes Options:",
    "  --legislation=<id>    Filter by legislation entity ID",
    "  --dry-run             Preview without syncing to wiki-server",
    "",
    "General Options:",
    "  --entity=<stableId>   Filter by politician entity",
    "  --limit=<N>           Max results (default: 200)",
    "  --ci                  JSON output for CI/scripting",
  ].join("\n");
}
