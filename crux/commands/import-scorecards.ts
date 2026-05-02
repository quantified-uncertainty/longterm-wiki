/**
 * Import external AI-safety scorecards into wiki-server Postgres (QUA-698).
 *
 * Sources (FMTI lives in QUA-697 — separate command):
 *   - fli_index       FLI AI Safety Index (LLM-extracted from HTML/PDF)
 *   - saferai         SaferAI Ratings (snapshot of the live ratings site)
 *   - ailabwatch      AI Lab Watch (frozen Sept 2025)
 *   - seoul_tracker   The Midas Project Seoul Commitment Tracker
 *
 * Each adapter reads from `data/scorecards/raw/<source>/<wave>/grades.json`.
 * `fetch` + `extract` produce that file (per-source extractors live in
 * `crux/lib/scorecard-import/extract/`); `sync` writes it through to PG.
 * Re-runs are idempotent because IDs are deterministic
 * (`<snapshotId>|<entityId>|<dimensionSlug>`).
 *
 * Usage:
 *   pnpm crux tb import-scorecards analyze                # all sources
 *   pnpm crux tb import-scorecards analyze --source=fli_index
 *   pnpm crux tb import-scorecards sync --dry-run         # all, no writes
 *   pnpm crux tb import-scorecards sync --source=saferai
 *   pnpm crux tb import-scorecards sync --no-factbase-mirror   # skip QUA-865 yaml mirror
 *   pnpm crux tb import-scorecards fetch --source=fli_index --wave=summer-2025
 *   pnpm crux tb import-scorecards extract --source=fli_index --wave=summer-2025
 *
 * QUA-865: `sync` runs `pnpm crux fb sync-scorecard-facts` after the PG sync
 * to mirror "overall" grades into FactBase YAML. Pass `--no-factbase-mirror`
 * to skip — useful in CI where the wiki-server isn't reachable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { ALL_SOURCES, getAdapter, listSourceKeys } from "../lib/scorecard-import/sources/index.ts";
import { buildOrgResolver } from "../lib/scorecard-import/org-aliases.ts";
import { scrapeSaferaiHtml } from "../lib/scorecard-import/sources/saferai-scraper.ts";
import {
  findPageChunkUrl,
  scrapeSeoul,
} from "../lib/scorecard-import/sources/seoul-scraper.ts";
import { analyzeSource, syncSource } from "../lib/scorecard-import/sync.ts";
import type { ScorecardSourceAdapter, ScorecardSourceKey } from "../lib/scorecard-import/types.ts";
import {
  FLI_WAVES,
  fetchAndCacheRawWave as fetchFliWave,
  extractWaveFromCache as extractFliWave,
} from "../lib/scorecard-import/extract/fli.ts";

const SAFERAI_DEFAULT_URL = "https://ratings.safer-ai.org/comparison/";
const SAFERAI_RAW_DIR = resolve("data/scorecards/raw/saferai");
const SEOUL_DEFAULT_URL = "https://www.seoul-tracker.org";
const SEOUL_RAW_DIR = resolve("data/scorecards/raw/seoul");

type CommandResult = { exitCode?: number; output?: string };

function pickSources(sourceFilter?: string): ScorecardSourceAdapter[] {
  if (!sourceFilter) return [...ALL_SOURCES];
  const adapter = ALL_SOURCES.find((a) => a.source === sourceFilter);
  if (!adapter) {
    throw new Error(
      `Unknown scorecard source "${sourceFilter}". Available: ${listSourceKeys().join(", ")}`,
    );
  }
  return [adapter];
}

async function cmdAnalyze(sourceFilter?: string): Promise<CommandResult> {
  const sources = pickSources(sourceFilter);
  const ctx = buildOrgResolver();

  console.log("=== Scorecard Import Analysis ===\n");

  let allUnresolved: string[] = [];
  for (const adapter of sources) {
    const a = analyzeSource(adapter, ctx);
    const unresolvedCount = a.unresolved.length;
    const status = unresolvedCount === 0 ? "✓" : "✗";
    console.log(
      `${status} ${adapter.name} (${a.source})`,
    );
    console.log(
      `    snapshots: ${a.snapshots}  grades: ${a.grades}  orgs: ${a.uniqueOrgs}  resolved: ${a.resolved}/${a.grades}`,
    );
    if (unresolvedCount > 0) {
      console.log(`    unresolved orgs:`);
      for (const name of a.unresolved) {
        console.log(`      - ${name}`);
      }
      allUnresolved.push(...a.unresolved.map((n) => `${a.source}: ${n}`));
    }
    console.log("");
  }

  if (allUnresolved.length > 0) {
    console.log(
      `\n${allUnresolved.length} unresolved org name(s) total. Add aliases to data/scorecards/org-aliases.yaml or to the entity's aliases: block in data/entities/.`,
    );
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

async function cmdSync(
  dryRun: boolean,
  sourceFilter: string | undefined,
  verbose: boolean,
  mirrorFactbase: boolean,
): Promise<CommandResult> {
  const sources = pickSources(sourceFilter);
  const ctx = buildOrgResolver();

  console.log(`=== Scorecard Import Sync${dryRun ? " (dry run)" : ""} ===\n`);

  for (const adapter of sources) {
    try {
      const r = await syncSource(adapter, ctx, { dryRun, verbose });
      const verb = dryRun ? "would sync" : "synced";
      console.log(
        `✓ ${adapter.name}: ${verb} ${r.snapshots} snapshot(s), ${r.grades} grade(s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${adapter.name}: ${message}`);
      return { exitCode: 1 };
    }
  }

  // QUA-865: mirror "overall" grades into FactBase YAML so <FBF
  // entity="..." predicate="fli-index-grade" /> renders the live grade.
  // Idempotent: re-runs with unchanged grades produce zero file changes.
  // --no-factbase-mirror skips this step (e.g. when only fetching/scraping).
  // Best-effort: a wiki-server outage during the mirror does not fail
  // a successful PG sync — operator can re-run `pnpm crux fb
  // sync-scorecard-facts` later.
  if (mirrorFactbase) {
    const { runMirrorAfterSync } = await import(
      "../lib/scorecards/factbase-mirror.ts"
    );
    const { summary, error } = await runMirrorAfterSync(dryRun);
    if (summary) {
      const verb = dryRun ? "would mirror" : "mirrored";
      const staleNote =
        summary.staleFactsRemoved > 0
          ? `, ${summary.staleFactsRemoved} stale fact(s) ${dryRun ? "would be removed" : "removed"}`
          : "";
      console.log(
        `✓ FactBase mirror: ${verb} ${summary.written} entit${summary.written === 1 ? "y" : "ies"} (${summary.skipped} skipped${staleNote})`,
      );
    } else if (error) {
      console.warn(`⚠ FactBase mirror skipped: ${error}`);
    }
  }

  return { exitCode: 0 };
}

interface ScrapeSaferaiOptions {
  url: string;
  wave?: string;
  refetch: boolean;
  dryRun: boolean;
}

/**
 * Fetch + parse the SaferAI comparison page and write a `grades.json`
 * file under `data/scorecards/raw/saferai/<wave>/`.
 *
 * - `--url` overrides the source URL (default: comparison page).
 * - `--wave` overrides the wave slug (default: derived from the page's
 *   "Up to date as of <Month> <YYYY>" footer, formatted as YYYY-MM).
 * - Without `--refetch`, an existing `comparison.html` in the wave dir is
 *   reused. With `--refetch`, the page is re-downloaded.
 * - `--dry-run` prints the parsed wave to stdout without writing.
 */
async function cmdScrapeSaferai(opts: ScrapeSaferaiOptions): Promise<CommandResult> {
  // Determine the wave dir up-front so cached HTML can be reused if present.
  // When --wave isn't given, do a probe parse to derive it from the page itself.
  let waveSlug = opts.wave;
  let waveDir = waveSlug ? join(SAFERAI_RAW_DIR, waveSlug) : null;

  let html: string | null = null;
  if (waveDir && !opts.refetch) {
    const cached = join(waveDir, "comparison.html");
    if (existsSync(cached)) {
      html = readFileSync(cached, "utf8");
      console.log(`✓ Reusing cached HTML: ${cached}`);
    }
  }
  if (html == null) {
    console.log(`Fetching ${opts.url} ...`);
    const resp = await fetch(opts.url);
    if (!resp.ok) {
      return {
        exitCode: 1,
        output: `[saferai-scrape] fetch failed: ${resp.status} ${resp.statusText}`,
      };
    }
    html = await resp.text();
  }

  // If --wave=YYYY-MM is provided, derive publishedAt from it as a fallback
  // so layout drift on the "as of …" footer doesn't block the operator.
  const wavePublishedAt =
    waveSlug && /^\d{4}-\d{2}$/.test(waveSlug) ? `${waveSlug}-01` : undefined;
  const probe = scrapeSaferaiHtml(html, {
    sourceUrl: opts.url,
    publishedAt: wavePublishedAt,
  });

  if (!waveSlug) {
    // Default wave slug: YYYY-MM (e.g. "2025-10") derived from publishedAt.
    waveSlug = probe.publishedAt.slice(0, 7);
    waveDir = join(SAFERAI_RAW_DIR, waveSlug);
  }
  if (!waveDir) waveDir = join(SAFERAI_RAW_DIR, waveSlug);

  if (opts.dryRun) {
    console.log(JSON.stringify(probe, null, 2));
    console.log(`\n(dry run — would write to ${waveDir}/grades.json)`);
    return { exitCode: 0 };
  }

  mkdirSync(waveDir, { recursive: true });
  const htmlPath = join(waveDir, "comparison.html");
  if (!existsSync(htmlPath) || opts.refetch) {
    writeFileSync(htmlPath, html);
    console.log(`✓ Wrote raw HTML: ${htmlPath}`);
  }
  const gradesPath = join(waveDir, "grades.json");
  writeFileSync(gradesPath, JSON.stringify(probe, null, 2) + "\n");
  console.log(
    `✓ Wrote grades.json: ${gradesPath}  (publishedAt=${probe.publishedAt}, ${probe.grades.length} orgs, ${probe.dimensions.length + 1} dimensions incl. overall)`,
  );
  console.log(
    `\nNext: pnpm crux tb import-scorecards analyze --source=saferai`,
  );
  return { exitCode: 0 };
}

async function cmdList(): Promise<CommandResult> {
  console.log("=== Scorecard Sources ===\n");
  const ctx = buildOrgResolver();
  for (const adapter of ALL_SOURCES) {
    const a = analyzeSource(adapter, ctx);
    console.log(`  ${adapter.source.padEnd(16)} ${adapter.name}`);
    console.log(
      `    ${a.snapshots} snapshot(s) on disk, ${a.grades} grade(s), ${a.unresolved.length} unresolved`,
    );
  }
  console.log("");
  return { exitCode: 0 };
}

// ---- Crux command exports ----

async function analyzeCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  return cmdAnalyze((options.source as string) || undefined);
}

async function syncCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  const verbose = !!options.verbose;
  const sourceFilter = (options.source as string) || undefined;
  // QUA-865: factbase mirror is on by default; --no-factbase-mirror opts out.
  const mirrorFactbase = !(
    options.noFactbaseMirror === true ||
    options["no-factbase-mirror"] === true
  );
  return cmdSync(dryRun, sourceFilter, verbose, mirrorFactbase);
}

async function listCommand(
  _args: string[],
  _options: Record<string, unknown>,
): Promise<CommandResult> {
  return cmdList();
}

interface ScrapeSeoulOptions {
  url: string;
  wave?: string;
  refetch: boolean;
  dryRun: boolean;
}

/**
 * Fetch + parse the Seoul Commitment Tracker (a Next.js SPA) and write a
 * `grades.json` file under `data/scorecards/raw/seoul/<wave>/`.
 *
 * The tracker renders verdicts client-side, so we cache two raw files in
 * the wave directory: `index.html` (the SPA shell, used to find the page
 * chunk URL + the deadline header) and `page-chunk.js` (the chunk that
 * embeds the actual data literals).
 */
async function cmdScrapeSeoul(opts: ScrapeSeoulOptions): Promise<CommandResult> {
  let waveSlug = opts.wave;
  let waveDir = waveSlug ? join(SEOUL_RAW_DIR, waveSlug) : null;

  let indexHtml: string | null = null;
  let pageChunkJs: string | null = null;
  if (waveDir && !opts.refetch) {
    const cachedHtml = join(waveDir, "index.html");
    const cachedChunk = join(waveDir, "page-chunk.js");
    if (existsSync(cachedHtml) && existsSync(cachedChunk)) {
      indexHtml = readFileSync(cachedHtml, "utf8");
      pageChunkJs = readFileSync(cachedChunk, "utf8");
      console.log(`✓ Reusing cached HTML + chunk: ${waveDir}`);
    }
  }

  if (indexHtml == null) {
    console.log(`Fetching ${opts.url} ...`);
    const resp = await fetch(opts.url);
    if (!resp.ok) {
      return {
        exitCode: 1,
        output: `[seoul-scrape] index fetch failed: ${resp.status} ${resp.statusText}`,
      };
    }
    indexHtml = await resp.text();
  }

  if (pageChunkJs == null) {
    const chunkPath = findPageChunkUrl(indexHtml);
    if (!chunkPath) {
      return {
        exitCode: 1,
        output: `[seoul-scrape] could not find page-chunk URL in index HTML. Tracker may have changed its bundle layout.`,
      };
    }
    const chunkUrl = new URL(chunkPath, opts.url).toString();
    console.log(`Fetching ${chunkUrl} ...`);
    const chunkResp = await fetch(chunkUrl);
    if (!chunkResp.ok) {
      return {
        exitCode: 1,
        output: `[seoul-scrape] page-chunk fetch failed: ${chunkResp.status} ${chunkResp.statusText}`,
      };
    }
    pageChunkJs = await chunkResp.text();
  }

  // If --wave=YYYY-MM is provided, derive publishedAt from it as a fallback
  // so layout drift on the deadline header doesn't block the operator.
  const wavePublishedAt =
    waveSlug && /^\d{4}-\d{2}$/.test(waveSlug) ? `${waveSlug}-01` : undefined;
  const wave = scrapeSeoul(indexHtml, pageChunkJs, {
    sourceUrl: opts.url,
    publishedAt: wavePublishedAt,
  });

  if (!waveSlug) {
    waveSlug = wave.publishedAt.slice(0, 7);
    waveDir = join(SEOUL_RAW_DIR, waveSlug);
  }
  if (!waveDir) waveDir = join(SEOUL_RAW_DIR, waveSlug);

  if (opts.dryRun) {
    console.log(JSON.stringify(wave, null, 2));
    console.log(`\n(dry run — would write to ${waveDir}/grades.json)`);
    return { exitCode: 0 };
  }

  mkdirSync(waveDir, { recursive: true });
  const htmlPath = join(waveDir, "index.html");
  if (!existsSync(htmlPath) || opts.refetch) {
    writeFileSync(htmlPath, indexHtml);
    console.log(`✓ Wrote raw HTML: ${htmlPath}`);
  }
  const chunkPath = join(waveDir, "page-chunk.js");
  if (!existsSync(chunkPath) || opts.refetch) {
    writeFileSync(chunkPath, pageChunkJs);
    console.log(`✓ Wrote raw chunk: ${chunkPath}`);
  }
  const gradesPath = join(waveDir, "grades.json");
  writeFileSync(gradesPath, JSON.stringify(wave, null, 2) + "\n");
  console.log(
    `✓ Wrote grades.json: ${gradesPath}  (publishedAt=${wave.publishedAt}, ${wave.grades.length} orgs, ${wave.dimensions.length} dimensions + overall)`,
  );
  console.log(
    `\nNext: pnpm crux tb import-scorecards analyze --source=seoul_tracker`,
  );
  return { exitCode: 0 };
}

async function scrapeCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const source = (options.source as string) || "saferai";
  const wave = (options.wave as string) || undefined;
  const refetch = !!options.refetch;
  const dryRun = !!options.dryRun || !!options["dry-run"];
  if (source === "saferai") {
    const url = (options.url as string) || SAFERAI_DEFAULT_URL;
    return cmdScrapeSaferai({ url, wave, refetch, dryRun });
  }
  if (source === "seoul_tracker" || source === "seoul") {
    const url = (options.url as string) || SEOUL_DEFAULT_URL;
    return cmdScrapeSeoul({ url, wave, refetch, dryRun });
  }
  return {
    exitCode: 1,
    output: `[scrape] --source=${source} not implemented; supported: saferai, seoul_tracker. Use the manual extraction step for other sources (see crux/lib/scorecard-import/sources/${source}.ts).`,
  };
}

function assertFetchExtractSourceSupported(source: string, op: "fetch" | "extract"): void {
  if (source !== "fli_index") {
    throw new Error(
      `${op} is only implemented for source "fli_index" so far (got "${source}").`,
    );
  }
}

async function cmdFetch(source: string, wave: string, force: boolean): Promise<CommandResult> {
  assertFetchExtractSourceSupported(source, "fetch");
  console.log(`Fetching FLI wave ${wave}${force ? " (force)" : ""}...`);
  try {
    const r = await fetchFliWave(wave, undefined, { force });
    console.log(`✓ ${r.path} (${r.bytes.toLocaleString()} bytes)`);
    return { exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ fetch ${source}/${wave}: ${message}`);
    return { exitCode: 1 };
  }
}

async function cmdExtract(source: string, wave: string): Promise<CommandResult> {
  assertFetchExtractSourceSupported(source, "extract");
  console.log(`Extracting FLI wave ${wave} (LLM call — may take ~30s)...`);
  try {
    const r = await extractFliWave(wave);
    console.log(`✓ ${r.outputPath}`);
    console.log(`  ${r.orgs} orgs × ${r.dimensions} dimensions`);
    if (r.usage) {
      console.log(
        `  tokens: ${r.usage.input_tokens.toLocaleString()} in, ${r.usage.output_tokens.toLocaleString()} out`,
      );
    }
    return { exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ extract ${source}/${wave}: ${message}`);
    return { exitCode: 1 };
  }
}

async function fetchCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const source = (options.source as string) ?? "";
  const wave = (options.wave as string) ?? "";
  const force = !!options.force;
  if (!source || !wave) {
    return {
      exitCode: 1,
      output:
        "Usage: pnpm crux tb import-scorecards fetch --source=<key> --wave=<slug> [--force]\n" +
        `FLI waves available: ${FLI_WAVES.map((w) => w.waveSlug).join(", ")}`,
    };
  }
  return cmdFetch(source, wave, force);
}

async function extractCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const source = (options.source as string) ?? "";
  const wave = (options.wave as string) ?? "";
  if (!source || !wave) {
    return {
      exitCode: 1,
      output:
        "Usage: pnpm crux tb import-scorecards extract --source=<key> --wave=<slug>\n" +
        `FLI waves available: ${FLI_WAVES.map((w) => w.waveSlug).join(", ")}`,
    };
  }
  return cmdExtract(source, wave);
}

export const commands = {
  analyze: analyzeCommand,
  sync: syncCommand,
  list: listCommand,
  scrape: scrapeCommand,
  fetch: fetchCommand,
  extract: extractCommand,
  default: analyzeCommand,
};

export function getHelp(): string {
  return `
Import Scorecards — Mirror external AI-safety scorecards (QUA-698)

Commands:
  analyze              Preview snapshots, grades, and unresolved orgs
  sync                 Upsert all snapshots + grades to wiki-server
  sync --dry-run       Show what would be synced without writing
  list                 List available source adapters and on-disk state
  scrape               Fetch the source page and emit grades.json
                       (--source=saferai or --source=seoul_tracker;
                       other sources still use manual extraction)
  fetch                Download a wave's source page/PDF into the cache
  extract              Run the LLM extractor on a cached wave -> grades.json

Options:
  --source=<key>       Filter to a single source (fli_index, saferai,
                       ailabwatch, seoul_tracker)
  --wave=<slug>        Wave slug for fetch/extract (e.g. summer-2025)
  --force              For fetch: re-download even if cached
  --verbose            Print API payloads (debug)
  --dry-run            Skip the wiki-server POST (also: print the parsed
                       wave instead of writing grades.json for scrape)
  --url=<url>          (scrape) Source URL — defaults to the source's
                       canonical entry page
  --wave=<slug>        (scrape) Override the wave slug — defaults to
                       YYYY-MM derived from the page's date hint
  --refetch            (scrape) Re-download the page even if cached HTML
                       already exists in the wave directory

Sources:
  ${ALL_SOURCES.map((s) => `- ${s.source.padEnd(16)} (${s.name})`).join("\n  ")}

Raw input layout:
  data/scorecards/raw/<source>/<wave-slug>/grades.json

Reruns are idempotent — IDs are derived from snapshotId + entityId +
dimensionSlug. Add new aliases to data/scorecards/org-aliases.yaml.
`;
}

export function _internalGetAdapter(source: ScorecardSourceKey) {
  return getAdapter(source);
}
