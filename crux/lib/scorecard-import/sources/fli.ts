/**
 * FLI AI Safety Index adapter (QUA-698).
 *
 * https://futureoflife.org/ai-safety-index-summer-2025/
 *
 * Format: each wave is published as a long HTML page + downloadable PDF
 * with letter grades (A through F, including +/-) for ~7 frontier labs
 * across 6-7 weighted safety domains plus an overall grade.
 *
 * Strategy: keep raw HTML in `data/scorecards/raw/fli/<wave>/page.html` for
 * audit, and store the extracted grades in a sibling `grades.json` file.
 * Extraction is a separate offline step (LLM-assisted on the raw HTML)
 * because (a) the page layout drifts wave-to-wave and (b) the LLM call
 * has cost — this lets us re-sync after schema tweaks without re-paying.
 *
 * The shape on disk lives at `data/scorecards/raw/fli/<wave>/grades.json`:
 *
 *   {
 *     "publishedAt": "2025-07-15",
 *     "waveLabel": "Summer 2025",
 *     "sourceUrl": "https://futureoflife.org/ai-safety-index-summer-2025/",
 *     "methodologyUrl": "https://futureoflife.org/.../methodology",
 *     "license": "CC BY 4.0",
 *     "dimensions": [
 *       { "slug": "risk-assessment", "label": "Risk Assessment", "weight": null }
 *       ...
 *     ],
 *     "grades": [
 *       {
 *         "org": "Anthropic",
 *         "scores": {
 *           "overall": "C+",
 *           "risk-assessment": "C",
 *           ...
 *         }
 *       }
 *     ]
 *   }
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import type {
  RawSnapshot,
  RawGrade,
  ScorecardSourceAdapter,
} from "../types.ts";

const SOURCE_KEY = "fli_index";
const DEFAULT_RAW_DIR = resolve("data/scorecards/raw/fli");

export interface FLIDimension {
  slug: string;
  label: string;
  weight?: number | null;
}

export interface FLIWaveFile {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl?: string | null;
  license?: string | null;
  notes?: string | null;
  /** True for the most recent wave (only one per source). */
  isLatest?: boolean;
  dimensions: FLIDimension[];
  grades: Array<{
    org: string;
    aliases?: string[];
    /** dimensionSlug → "B+" / "Partial" / etc. Always include "overall". */
    scores: Record<string, string>;
    /** Per-cell URLs (rare). Same key set as `scores`. */
    sourceUrls?: Record<string, string>;
  }>;
}

function loadWaves(rawDir: string): Array<{ waveSlug: string; data: FLIWaveFile }> {
  if (!existsSync(rawDir)) return [];
  const out: Array<{ waveSlug: string; data: FLIWaveFile }> = [];
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const gradesPath = join(rawDir, entry.name, "grades.json");
    if (!existsSync(gradesPath)) continue;
    const raw = readFileSync(gradesPath, "utf8");
    const parsed = JSON.parse(raw) as FLIWaveFile;
    validateWave(entry.name, parsed);
    out.push({ waveSlug: entry.name, data: parsed });
  }
  // Sort by publishedAt ascending so latest is unambiguous in `listSnapshots`.
  out.sort((a, b) =>
    a.data.publishedAt.localeCompare(b.data.publishedAt),
  );
  return out;
}

function validateWave(waveSlug: string, data: FLIWaveFile): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.publishedAt)) {
    throw new Error(
      `fli/${waveSlug}/grades.json: publishedAt must be YYYY-MM-DD, got "${data.publishedAt}"`,
    );
  }
  if (!data.sourceUrl) {
    throw new Error(`fli/${waveSlug}/grades.json: sourceUrl is required`);
  }
  if (!Array.isArray(data.dimensions) || data.dimensions.length === 0) {
    throw new Error(`fli/${waveSlug}/grades.json: dimensions[] required`);
  }
  if (!Array.isArray(data.grades) || data.grades.length === 0) {
    throw new Error(`fli/${waveSlug}/grades.json: grades[] required`);
  }
  const dimSlugs = new Set(data.dimensions.map((d) => d.slug));
  for (const g of data.grades) {
    if (!g.org) {
      throw new Error(`fli/${waveSlug}/grades.json: grade missing org`);
    }
    if (g.scores.overall == null) {
      throw new Error(
        `fli/${waveSlug}/grades.json: org "${g.org}" missing overall score`,
      );
    }
    for (const slug of Object.keys(g.scores)) {
      if (slug !== "overall" && !dimSlugs.has(slug)) {
        throw new Error(
          `fli/${waveSlug}/grades.json: org "${g.org}" has score for unknown dimension "${slug}"`,
        );
      }
    }
  }
}

function snapshotId(waveSlug: string): string {
  return `${SOURCE_KEY}-${waveSlug}`;
}

/**
 * Letter grades A-F (with +/-) numerically from 4.3 (A+) to 0.0 (F).
 * Used to populate scoreNumeric so directory queries can sort/aggregate
 * without re-parsing the letter every time. Returns null on unparseable
 * inputs (e.g., "N/A", "Pending") — the verbatim string still lives in
 * scoreRaw.
 */
export function letterToGpa(letter: string): number | null {
  const m = /^([A-F])([+-])?$/.exec(letter.trim().toUpperCase());
  if (!m) return null;
  const base: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  let val = base[m[1]];
  if (m[2] === "+") val += 0.3;
  else if (m[2] === "-") val -= 0.3;
  // Clamp to [0, 4.3] — A+ = 4.3, F- (rare) = 0 not -0.3.
  if (val < 0) val = 0;
  if (val > 4.3) val = 4.3;
  return val;
}

/**
 * Build an adapter rooted at `rawDir` (default: `data/scorecards/raw/fli`).
 * Exposed for tests, which point at fixture directories instead.
 */
export function createFliAdapter(rawDir: string = DEFAULT_RAW_DIR): ScorecardSourceAdapter {
  return {
    source: SOURCE_KEY,
    name: "FLI AI Safety Index",

    listSnapshots(): RawSnapshot[] {
      const waves = loadWaves(rawDir);
      if (waves.length === 0) return [];
      const explicitLatest = waves.filter((w) => w.data.isLatest === true);
      if (explicitLatest.length > 1) {
        throw new Error(
          `[fli_index] multiple waves set isLatest=true: ${explicitLatest
            .map((w) => w.waveSlug)
            .join(", ")}`,
        );
      }
      const latestId =
        explicitLatest.length === 1
          ? snapshotId(explicitLatest[0].waveSlug)
          : snapshotId(waves[waves.length - 1].waveSlug);
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
          isLatest: id === latestId,
          sourceActive: true,
        };
      });
    },

    parseGrades(snapshot: RawSnapshot): RawGrade[] {
      const waves = loadWaves(rawDir);
      const wave = waves.find((w) => snapshotId(w.waveSlug) === snapshot.id);
      if (!wave) {
        throw new Error(
          `[fli_index] cannot parse grades for snapshot "${snapshot.id}" — raw file missing`,
        );
      }

      const dimByslug = new Map(wave.data.dimensions.map((d) => [d.slug, d]));
      const out: RawGrade[] = [];
      for (const g of wave.data.grades) {
        for (const [slug, letter] of Object.entries(g.scores)) {
          const isOverall = slug === "overall";
          const dim = isOverall ? null : dimByslug.get(slug);
          if (!isOverall && !dim) {
            // Should be caught by validateWave but defensive.
            throw new Error(
              `[fli_index] org "${g.org}" has score for unknown dimension "${slug}"`,
            );
          }
          out.push({
            snapshotId: snapshot.id,
            orgName: g.org,
            orgAliases: g.aliases,
            dimensionSlug: slug,
            dimensionLabel: isOverall ? "Overall" : (dim!.label),
            dimensionWeight: isOverall ? null : (dim!.weight ?? null),
            dimensionParentSlug: null,
            scoreNumeric: letterToGpa(letter),
            scoreLetter: letter,
            scoreRaw: letter,
            notes: null,
            sourceUrl: g.sourceUrls?.[slug] ?? null,
          });
        }
      }
      return out;
    },
  };
}

export const fliAdapter = createFliAdapter();
