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
 * after a hand-edit is trivial.
 *
 * Usage:
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts                  # fetch + write
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts --use-cache      # parse cached HTML
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts --wave=2025-09   # custom wave slug
 *   pnpm tsx crux/scripts/scrape-ailabwatch.ts --print          # print grades to stdout
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  parseAILabWatchHtml,
  AILW_DIMENSIONS,
  AILW_ORGS,
} from "../lib/scorecard-import/parse-ailabwatch.ts";

const SOURCE_URL = "https://ailabwatch.org/";
const DEFAULT_WAVE = "2025-09";
const PUBLISHED_AT = "2025-09-01"; // Site states "as of September 2025" as the freeze date.

interface Args {
  wave: string;
  useCache: boolean;
  print: boolean;
  rawDir: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    wave: DEFAULT_WAVE,
    useCache: false,
    print: false,
    rawDir: resolve("data/scorecards/raw/ailabwatch"),
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--use-cache") out.useCache = true;
    else if (arg === "--print") out.print = true;
    else if (arg.startsWith("--wave=")) out.wave = arg.slice("--wave=".length);
    else if (arg.startsWith("--raw-dir=")) out.rawDir = resolve(arg.slice("--raw-dir=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx crux/scripts/scrape-ailabwatch.ts [--wave=YYYY-MM] [--use-cache] [--print] [--raw-dir=PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument "${arg}"`);
  }
  return out;
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
  if (html.length < 10_000) {
    throw new Error(
      `GET ${url} returned suspiciously short body (${html.length} bytes) — site layout may have changed`,
    );
  }
  return html;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

interface GradesFile {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl: string;
  license: string | null;
  notes: string;
  isLatest: boolean;
  dimensions: Array<{ slug: string; label: string; weight: number | null }>;
  grades: Array<{
    org: string;
    aliases?: string[];
    scores: Record<string, string>;
    sourceUrls?: Record<string, string>;
  }>;
}

function buildGradesFile(parsed: ReturnType<typeof parseAILabWatchHtml>): GradesFile {
  const dims = AILW_DIMENSIONS.map((d) => ({
    slug: d.slug,
    label: d.label,
    // The site does publish per-category weights internally, but they are
    // not surfaced as numeric values in HTML — only as the "Weighted score"
    // visualization. We intentionally leave weights null rather than
    // hand-encoding them; the adapter treats null as "no weight published"
    // and the matrix display still works.
    weight: null,
  }));

  const grades: GradesFile["grades"] = [];
  for (const org of AILW_ORGS) {
    const overall = parsed.overall[org.slug];
    const perDim = parsed.perDimension[org.slug];
    const scores: Record<string, string> = { overall: `${overall}%` };
    for (const d of AILW_DIMENSIONS) {
      scores[d.slug] = `${perDim[d.slug]}%`;
    }
    grades.push({
      org: org.display,
      scores,
    });
  }

  return {
    publishedAt: PUBLISHED_AT,
    waveLabel: "September 2025 (frozen)",
    sourceUrl: SOURCE_URL,
    methodologyUrl: "https://ailabwatch.org/about",
    // The site has no explicit license declaration. Author is Zach
    // Stein-Perlman; the grades are public and originally CC-0-spirited.
    // Leave null to avoid asserting a license we can't verify.
    license: null,
    notes:
      "AI Lab Watch (ailabwatch.org) — frozen as of September 2025 per the " +
      "author. Seven dimensions × seven frontier labs; per-cell scores in " +
      "0-100 percent. Overall is the site's published weighted total.",
    isLatest: true,
    dimensions: dims,
    grades,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const waveDir = join(args.rawDir, args.wave);
  const htmlPath = join(waveDir, "index.html");
  const gradesPath = join(waveDir, "grades.json");

  ensureDir(waveDir);

  let html: string;
  if (args.useCache) {
    if (!existsSync(htmlPath)) {
      throw new Error(`--use-cache passed but ${htmlPath} does not exist`);
    }
    html = readFileSync(htmlPath, "utf8");
    console.log(`[scrape-ailabwatch] reading cached HTML from ${htmlPath} (${html.length} bytes)`);
  } else {
    console.log(`[scrape-ailabwatch] fetching ${SOURCE_URL}`);
    html = await fetchSourceHtml(SOURCE_URL);
    writeFileSync(htmlPath, html, "utf8");
    console.log(`[scrape-ailabwatch] wrote raw HTML → ${htmlPath} (${html.length} bytes)`);
  }

  const parsed = parseAILabWatchHtml(html);
  const out = buildGradesFile(parsed);

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

main().catch((err) => {
  console.error(`[scrape-ailabwatch] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
