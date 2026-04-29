/**
 * Ingest OECD AI Incident Monitor (AIM) snapshot.
 *
 * Usage:
 *   pnpm crux oecd-aim ingest                       # full historical pull
 *   pnpm crux oecd-aim ingest --dry-run             # fetch + transform; no sync
 *   pnpm crux oecd-aim ingest --from=YYYY-MM-DD     # custom start (default: 2020-04-29)
 *   pnpm crux oecd-aim ingest --to=YYYY-MM-DD       # custom end (default: today UTC)
 *   pnpm crux oecd-aim ingest --limit=200           # cap incidents processed (smoke test)
 *   pnpm crux oecd-aim ingest --with-articles       # also fetch detail endpoint per incident
 *   pnpm crux oecd-aim ingest --batch=N             # sync batch size (default 100)
 *   pnpm crux oecd-aim probe                         # verify the upstream API is reachable
 *
 * License (no explicit open-data license at oecd.ai):
 *   Conservative — metadata + link-out only. Article body fields are
 *   stripped defensively in `crux/lib/oecd-aim/transform.ts` and
 *   `validate-oecd-aim-no-article-body.ts` enforces the rule.
 *
 * Phase 7 of QUA-687 (QUA-696). Companion to `pnpm crux aiid ingest`.
 */

import type { CommandResult } from "../lib/command-types.ts";
import {
  AIM_EARLIEST_DATE,
  fetchAllIncidents,
  fetchIncidentDetail,
  type FetchOptions,
} from "../lib/oecd-aim/fetch.ts";
import {
  transformIncident,
  type AiIncidentSyncItem,
  type OecdAimArticleRaw,
} from "../lib/oecd-aim/transform.ts";
import { syncAiIncidents } from "../lib/wiki-server/ai-incidents.ts";

const DEFAULT_BATCH = 100;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function syncItemsInBatches(
  items: AiIncidentSyncItem[],
  batchSize: number,
  log: (line: string) => void,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const res = await syncAiIncidents(chunk);
    if (!res.ok) {
      throw new Error(
        `OECD AIM sync batch failed at offset ${i}: ${res.message}`,
      );
    }
    total += res.data.upserted;
    log(
      `  Batch ${Math.floor(i / batchSize) + 1}: upserted ${res.data.upserted}/${chunk.length}`,
    );
  }
  return total;
}

async function runIngest(
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  const dryRun = options["dry-run"] === true || options.dryRun === true;
  const withArticles =
    options["with-articles"] === true || options.withArticles === true;
  const batchSizeRaw =
    options.batch === undefined ? DEFAULT_BATCH : Number(options.batch);
  if (!Number.isInteger(batchSizeRaw) || batchSizeRaw <= 0) {
    return { exitCode: 1, output: "--batch must be a positive integer" };
  }
  const batchSize = batchSizeRaw;
  const limitN =
    options.limit === undefined ? undefined : Number(options.limit);
  if (
    limitN !== undefined &&
    (!Number.isInteger(limitN) || limitN < 0)
  ) {
    return { exitCode: 1, output: "--limit must be a non-negative integer" };
  }

  const fromDate = (options.from as string | undefined) ?? AIM_EARLIEST_DATE;
  const toDate = (options.to as string | undefined) ?? todayUTC();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return { exitCode: 1, output: `--from must be YYYY-MM-DD: got ${fromDate}` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { exitCode: 1, output: `--to must be YYYY-MM-DD: got ${toDate}` };
  }
  if (toDate < fromDate) {
    return {
      exitCode: 1,
      output: `--to (${toDate}) must be ≥ --from (${fromDate})`,
    };
  }

  const fetchOpts: FetchOptions = {};

  log(`Fetching OECD AIM incidents from ${fromDate} to ${toDate} ...`);
  const upstreamFetchedAt = new Date().toISOString();
  const { incidents, listRequests, windowSplits } = await fetchAllIncidents(
    fromDate,
    toDate,
    fetchOpts,
  );
  log(
    `  ${incidents.length} incidents (${listRequests} list requests, ${windowSplits} window splits)`,
  );

  const toProcess =
    limitN === undefined ? incidents : incidents.slice(0, limitN);

  log(`Transforming ${toProcess.length} incidents ...`);
  const items: AiIncidentSyncItem[] = [];
  if (withArticles) {
    log(`  Fetching per-incident article URLs (slow path — ~1 req/incident) ...`);
    let articleRequests = 0;
    for (const inc of toProcess) {
      let articles: OecdAimArticleRaw[] = [];
      try {
        const detail = await fetchIncidentDetail(inc.id, fetchOpts);
        articles = detail.articles ?? [];
        articleRequests++;
      } catch (e) {
        log(
          `    detail fetch failed for ${inc.id}: ${e instanceof Error ? e.message : String(e)} — proceeding without articles`,
        );
      }
      items.push(
        transformIncident(inc, articles, { upstreamFetchedAt }),
      );
    }
    log(`  Article fetch: ${articleRequests}/${toProcess.length} succeeded`);
  } else {
    for (const inc of toProcess) {
      items.push(transformIncident(inc, [], { upstreamFetchedAt }));
    }
  }
  log(`  Transformed ${items.length} incidents`);

  if (dryRun) {
    log(`(dry run — no sync)`);
    if (items.length > 0) {
      const sample = { ...items[0], raw: "<redacted>" };
      log(`  Sample item: ${JSON.stringify(sample)}`);
    }
    return { exitCode: 0, output: lines.join("\n") };
  }

  log(`Syncing ${items.length} incidents to wiki-server ...`);
  const upserted = await syncItemsInBatches(items, batchSize, log);
  log(`Done — upserted ${upserted} incidents.`);
  return { exitCode: 0, output: lines.join("\n") };
}

async function runProbe(): Promise<CommandResult> {
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  log("Probing OECD AIM list endpoint with a 1-incident request ...");
  try {
    const res = await fetchAllIncidents(todayUTC(), todayUTC(), {
      delayMs: 0,
    });
    log(`  Reachable. ${res.incidents.length} incident(s) on today's date.`);
    return { exitCode: 0, output: lines.join("\n") };
  } catch (e) {
    return {
      exitCode: 1,
      output:
        lines.join("\n") +
        "\n" +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export const commands = {
  ingest: async (
    _args: string[],
    options: Record<string, unknown>,
  ): Promise<CommandResult> => runIngest(options),
  probe: async (): Promise<CommandResult> => runProbe(),
};
