/**
 * Seoul Commitment Tracker adapter (QUA-698).
 *
 * https://www.seoul-tracker.org
 *
 * Author: The Midas Project. Tracks adherence to the Seoul Frontier AI
 * Safety Commitments — five components signed by 16 frontier developers
 * at the May 2024 AI Seoul Summit. The tracker uses these dimension slugs
 * (verified against the live tracker page chunk on 2026-04-28; see
 * QUA-752 / `seoul-scraper.ts`):
 *
 *   1. risk-evaluations     — Risk Evaluation
 *   2. risk-thresholds      — Risk Thresholds
 *   3. risk-mitigations     — Risk Mitigations
 *   4. halting-procedures   — Halting Procedures
 *   5. safety-investment    — Safety Investment
 *
 * Verdict per (org, commitment): "Fulfilled" | "Partial" | "Unfulfilled" |
 * "Not Applicable". The tracker also publishes an "overall" summary
 * verdict per org. The tracker's own categorical bands collapse the
 * underlying 1-4 numeric scale into three labels (1 → Unfulfilled,
 * 2 → Partial, 3 and 4 both → Fulfilled).
 *
 * Storage matches the FLI/SaferAI pattern — a JSON snapshot at
 * `data/scorecards/raw/seoul/<wave>/grades.json`. The scraper that
 * extracts the snapshot from the live tracker lives in
 * `seoul-scraper.ts` and is invoked via
 * `pnpm crux tb import-scorecards scrape --source=seoul_tracker`.
 *
 * Categorical scores get a numeric encoding for sorting:
 *   Fulfilled = 1.0, Partial = 0.5, Unfulfilled = 0.0,
 *   Not Applicable / unparseable = null.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import type {
  RawSnapshot,
  RawGrade,
  ScorecardSourceAdapter,
} from "../types.ts";

const SOURCE_KEY = "seoul_tracker";
const DEFAULT_RAW_DIR = resolve("data/scorecards/raw/seoul");

interface SeoulDimension {
  slug: string;
  label: string;
}

interface SeoulWaveFile {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl?: string | null;
  license?: string | null;
  notes?: string | null;
  isLatest?: boolean;
  dimensions: SeoulDimension[];
  grades: Array<{
    org: string;
    aliases?: string[];
    /** dimensionSlug → "Fulfilled" | "Partial" | "Unfulfilled" | "Not Applicable". */
    scores: Record<string, string>;
    sourceUrls?: Record<string, string>;
  }>;
}

function loadWaves(rawDir: string): Array<{ waveSlug: string; data: SeoulWaveFile }> {
  if (!existsSync(rawDir)) return [];
  const out: Array<{ waveSlug: string; data: SeoulWaveFile }> = [];
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(rawDir, entry.name, "grades.json");
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, "utf8")) as SeoulWaveFile;
    validateWave(entry.name, data);
    out.push({ waveSlug: entry.name, data });
  }
  out.sort((a, b) => a.data.publishedAt.localeCompare(b.data.publishedAt));
  return out;
}

function validateWave(waveSlug: string, data: SeoulWaveFile): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.publishedAt)) {
    throw new Error(
      `seoul/${waveSlug}/grades.json: publishedAt must be YYYY-MM-DD, got "${data.publishedAt}"`,
    );
  }
  if (!data.sourceUrl) {
    throw new Error(`seoul/${waveSlug}/grades.json: sourceUrl required`);
  }
  if (!Array.isArray(data.dimensions) || data.dimensions.length === 0) {
    throw new Error(`seoul/${waveSlug}/grades.json: dimensions[] required`);
  }
  if (!Array.isArray(data.grades) || data.grades.length === 0) {
    throw new Error(`seoul/${waveSlug}/grades.json: grades[] required`);
  }
  const dimSlugs = new Set(data.dimensions.map((d) => d.slug));
  for (const g of data.grades) {
    if (!g.org) {
      throw new Error(`seoul/${waveSlug}/grades.json: grade missing org`);
    }
    if (g.scores.overall == null) {
      throw new Error(
        `seoul/${waveSlug}/grades.json: org "${g.org}" missing overall`,
      );
    }
    for (const slug of Object.keys(g.scores)) {
      if (slug !== "overall" && !dimSlugs.has(slug)) {
        throw new Error(
          `seoul/${waveSlug}/grades.json: org "${g.org}" has score for unknown dimension "${slug}"`,
        );
      }
    }
  }
}

function snapshotId(waveSlug: string): string {
  return `${SOURCE_KEY}-${waveSlug}`;
}

/**
 * Map Seoul Tracker categorical verdicts to a 0-1 numeric encoding so
 * matrix display and aggregations have something to sort on. Returns
 * null for "Not Applicable" or unrecognized strings — scoreRaw still
 * preserves the verbatim verdict.
 */
export function verdictToNumeric(verdict: string): number | null {
  const v = verdict.trim().toLowerCase();
  if (v === "fulfilled" || v === "full") return 1.0;
  if (v === "partial" || v === "partially fulfilled") return 0.5;
  if (v === "unfulfilled" || v === "not fulfilled") return 0.0;
  return null;
}

export function createSeoulAdapter(rawDir: string = DEFAULT_RAW_DIR): ScorecardSourceAdapter {
  return {
    source: SOURCE_KEY,
    name: "Seoul Commitment Tracker",

    listSnapshots(): RawSnapshot[] {
      const waves = loadWaves(rawDir);
      if (waves.length === 0) return [];
      const latestId = snapshotId(waves[waves.length - 1].waveSlug);
      return waves.map(({ waveSlug, data }) => {
        const id = snapshotId(waveSlug);
        return {
          id,
          scorecardSource: SOURCE_KEY,
          waveLabel: data.waveLabel,
          publishedAt: data.publishedAt,
          sourceUrl: data.sourceUrl,
          methodologyUrl: data.methodologyUrl ?? null,
          license: data.license ?? null,
          notes: data.notes ?? null,
          isLatest: data.isLatest ?? id === latestId,
          sourceActive: true,
        };
      });
    },

    parseGrades(snapshot: RawSnapshot): RawGrade[] {
      const waves = loadWaves(rawDir);
      const wave = waves.find((w) => snapshotId(w.waveSlug) === snapshot.id);
      if (!wave) {
        throw new Error(
          `[seoul_tracker] cannot parse grades for snapshot "${snapshot.id}" — raw file missing`,
        );
      }
      const dimByslug = new Map(wave.data.dimensions.map((d) => [d.slug, d]));
      const out: RawGrade[] = [];
      for (const g of wave.data.grades) {
        for (const [slug, value] of Object.entries(g.scores)) {
          const isOverall = slug === "overall";
          const dim = isOverall ? null : dimByslug.get(slug);
          if (!isOverall && !dim) {
            throw new Error(
              `[seoul_tracker] org "${g.org}" has score for unknown dimension "${slug}"`,
            );
          }
          out.push({
            snapshotId: snapshot.id,
            orgName: g.org,
            orgAliases: g.aliases,
            dimensionSlug: slug,
            dimensionLabel: isOverall ? "Overall" : dim!.label,
            dimensionWeight: null,
            dimensionParentSlug: null,
            scoreNumeric: verdictToNumeric(value),
            scoreLetter: value,
            scoreRaw: value,
            notes: null,
            sourceUrl: g.sourceUrls?.[slug] ?? null,
          });
        }
      }
      return out;
    },
  };
}

export const seoulAdapter = createSeoulAdapter();
