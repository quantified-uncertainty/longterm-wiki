#!/usr/bin/env -S node --import tsx/esm
/**
 * AI Lab Watch one-shot scraper (QUA-751).
 *
 * Fetches https://ailabwatch.org/ (the homepage IS the scorecard — the
 * `/scorecard` path 404s), caches the raw HTML under
 * `data/scorecards/raw/ailabwatch/<wave>/index.html`, and emits a
 * `grades.json` matching the `RawSnapshot` / `RawGrade` shape consumed by
 * `crux/lib/scorecard-import/sources/ailabwatch.ts`.
 *
 * The site is frozen as of September 2025 ("as of September 2025, I'm
 * no longer maintaining this website" — Zach Stein-Perlman, on the home
 * page). The script is idempotent: re-running with `--use-cache` skips
 * the network and re-parses the cached HTML, so emitting `grades.json`
 * after a hand-edit is trivial. By default, it refuses to overwrite an
 * existing cached HTML — pass `--force-fetch` to re-fetch.
 *
 * Usage:
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts                  # fetch + write (refuses if cache exists)
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts --use-cache      # parse cached HTML
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts --force-fetch    # re-fetch + overwrite cache
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts --wave=2025-09   # custom wave slug (YYYY-MM)
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts --print          # print grades to stdout
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAILabWatchHtml,
  buildAILabWatchGradesFile,
} from "../lib/scorecard-import/parse-ailabwatch.ts";

const SOURCE_URL = "https://ailabwatch.org/";
const DEFAULT_WAVE = "2025-09";
const FROZEN_NOTES =
  "AI Lab Watch (ailabwatch.org) — frozen as of September 2025 per the " +
  "author. Seven dimensions × seven frontier labs; per-cell scores in " +
  "0-100 percent. Overall is the site's published weighted total.";

interface Args {
  wave: string;
  useCache: boolean;
  forceFetch: boolean;
  print: boolean;
  rawDir: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    wave: DEFAULT_WAVE,
    useCache: false,
    forceFetch: false,
    print: false,
    rawDir: resolve("data/scorecards/raw/ailabwatch"),
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--use-cache") out.useCache = true;
    else if (arg === "--force-fetch") out.forceFetch = true;
    else if (arg === "--print") out.print = true;
    else if (arg.startsWith("--wave=")) out.wave = arg.slice("--wave=".length);
    else if (arg.startsWith("--raw-dir=")) out.rawDir = resolve(arg.slice("--raw-dir=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx crux/scripts/scrape-ailabwatch.ts [--wave=YYYY-MM] [--use-cache | --force-fetch] [--print] [--raw-dir=PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument "${arg}"`);
  }
  if (out.useCache && out.forceFetch) {
    throw new Error("--use-cache and --force-fetch are mutually exclusive");
  }
  return out;
}

/**
 * Convert a wave slug (`YYYY-MM`) into a publishedAt date (`YYYY-MM-01`).
 * Hardcoding `2025-09-01` regardless of `--wave` was a latent bug —
 * passing `--wave=2025-12` would have written a snapshot dated
 * 2025-09-01 anyway. Strict-validate the format here.
 */
export function publishedAtFromWave(wave: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(wave);
  if (!m) {
    throw new Error(`--wave must be YYYY-MM (got "${wave}")`);
  }
  const month = Number(m[2]);
  if (month < 1 || month > 12) {
    throw new Error(`--wave month out of range: "${wave}"`);
  }
  return `${wave}-01`;
}

async function fetchSourceHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "user-agent":
        "longterm-wiki-scorecard-importer/1.0 (+https://www.longtermwiki.com)",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(
      `GET ${url} failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  const html = await resp.text();
  if (!html.includes("AI Companies Scorecard")) {
    // Catches CDN error pages, redirected captive portals, etc. The
    // strict parser would also fail, but this gives a clearer error
    // earlier — before we overwrite the cached HTML on disk.
    throw new Error(
      `GET ${url} returned ${html.length} bytes but no "AI Companies Scorecard" marker — site layout may have changed`,
    );
  }
  return html;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export async function runScrape(args: Args): Promise<void> {
  const waveDir = join(args.rawDir, args.wave);
  const htmlPath = join(waveDir, "index.html");
  const gradesPath = join(waveDir, "grades.json");
  const publishedAt = publishedAtFromWave(args.wave);

  ensureDir(waveDir);

  let html: string;
  if (args.useCache) {
    if (!existsSync(htmlPath)) {
      throw new Error(`--use-cache passed but ${htmlPath} does not exist`);
    }
    html = readFileSync(htmlPath, "utf8");
    console.log(`[scrape-ailabwatch] reading cached HTML from ${htmlPath} (${html.length} bytes)`);
  } else {
    if (existsSync(htmlPath) && !args.forceFetch) {
      throw new Error(
        `${htmlPath} already exists. Use --use-cache to re-parse it, or --force-fetch to re-download (overwrites the cached file).`,
      );
    }
    console.log(`[scrape-ailabwatch] fetching ${SOURCE_URL}`);
    html = await fetchSourceHtml(SOURCE_URL);
    writeFileSync(htmlPath, html, "utf8");
    console.log(`[scrape-ailabwatch] wrote raw HTML → ${htmlPath} (${html.length} bytes)`);
  }

  const parsed = parseAILabWatchHtml(html);
  const out = buildAILabWatchGradesFile(parsed, {
    publishedAt,
    waveLabel: `${monthName(publishedAt)} (frozen)`,
    sourceUrl: SOURCE_URL,
    methodologyUrl: "https://ailabwatch.org/about",
    notes: FROZEN_NOTES,
  });

  if (args.print) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  ensureDir(dirname(gradesPath));
  writeFileSync(gradesPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(
    `[scrape-ailabwatch] wrote grades.json → ${gradesPath} ` +
      `(${out.grades.length} orgs × ${out.dimensions.length + 1} cells)`,
  );
  console.log(`[scrape-ailabwatch] next: pnpm crux tb import-scorecards analyze --source=ailabwatch`);
}

function monthName(isoDate: string): string {
  const [y, m] = isoDate.split("-");
  const names = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${names[Number(m)]} ${y}`;
}

// Only execute when invoked directly. Exposing helpers + runScrape for
// import-time reuse (e.g., a test that drives the script against a
// fixture HTML) without triggering an unintended fetch.
const isEntryPoint = import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  // `parseArgs` throws synchronously on bad input — wrap in an async IIFE
  // so its errors land in the same handler as runtime errors instead of
  // bypassing the catch and dumping a raw stack trace.
  (async () => runScrape(parseArgs(process.argv)))().catch((err) => {
    console.error(`[scrape-ailabwatch] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
