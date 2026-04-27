/**
 * AI Lab Watch adapter (QUA-698).
 *
 * https://ailabwatch.org
 *
 * Author: Zach Stein-Perlman. Weighted scorecard across seven categories
 * (risk assessment, scheming prevention, safety research, misuse prevention,
 * security, info sharing, planning) for ~7 frontier labs.
 *
 * Status: FROZEN as of September 2025 (per the QUA-688 framework
 * `SCORECARD_SOURCES.active=false` flag). Treat any imported snapshot as
 * the final wave — `sourceActive=false` on the snapshot row tells the
 * directory to render a "no longer maintained" pill.
 *
 * Numeric scores are 0-100 percentages. Letter mapping mirrors SaferAI's
 * 4-band qualitative scale for matrix display.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { percentToBand, parsePercent } from "./saferai.ts";
import type {
  RawSnapshot,
  RawGrade,
  ScorecardSourceAdapter,
} from "../types.ts";

const SOURCE_KEY = "ailabwatch";
const DEFAULT_RAW_DIR = resolve("data/scorecards/raw/ailabwatch");

interface AILabWatchDimension {
  slug: string;
  label: string;
  /** AI Lab Watch publishes per-category weights summing to 1.0. */
  weight?: number | null;
}

interface AILabWatchWaveFile {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl?: string | null;
  license?: string | null;
  notes?: string | null;
  isLatest?: boolean;
  dimensions: AILabWatchDimension[];
  grades: Array<{
    org: string;
    aliases?: string[];
    /** dimensionSlug → percent string (e.g. "42%"). */
    scores: Record<string, string>;
    sourceUrls?: Record<string, string>;
  }>;
}

function loadWaves(rawDir: string): Array<{ waveSlug: string; data: AILabWatchWaveFile }> {
  if (!existsSync(rawDir)) return [];
  const out: Array<{ waveSlug: string; data: AILabWatchWaveFile }> = [];
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(rawDir, entry.name, "grades.json");
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, "utf8")) as AILabWatchWaveFile;
    validateWave(entry.name, data);
    out.push({ waveSlug: entry.name, data });
  }
  out.sort((a, b) => a.data.publishedAt.localeCompare(b.data.publishedAt));
  return out;
}

function validateWave(waveSlug: string, data: AILabWatchWaveFile): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.publishedAt)) {
    throw new Error(
      `ailabwatch/${waveSlug}/grades.json: publishedAt must be YYYY-MM-DD, got "${data.publishedAt}"`,
    );
  }
  if (!data.sourceUrl) {
    throw new Error(`ailabwatch/${waveSlug}/grades.json: sourceUrl required`);
  }
  if (!Array.isArray(data.dimensions) || data.dimensions.length === 0) {
    throw new Error(
      `ailabwatch/${waveSlug}/grades.json: dimensions[] required`,
    );
  }
  if (!Array.isArray(data.grades) || data.grades.length === 0) {
    throw new Error(`ailabwatch/${waveSlug}/grades.json: grades[] required`);
  }
  const dimSlugs = new Set(data.dimensions.map((d) => d.slug));
  for (const g of data.grades) {
    if (!g.org) {
      throw new Error(`ailabwatch/${waveSlug}/grades.json: grade missing org`);
    }
    if (g.scores.overall == null) {
      throw new Error(
        `ailabwatch/${waveSlug}/grades.json: org "${g.org}" missing overall`,
      );
    }
    for (const slug of Object.keys(g.scores)) {
      if (slug !== "overall" && !dimSlugs.has(slug)) {
        throw new Error(
          `ailabwatch/${waveSlug}/grades.json: org "${g.org}" has score for unknown dimension "${slug}"`,
        );
      }
    }
  }
}

function snapshotId(waveSlug: string): string {
  return `${SOURCE_KEY}-${waveSlug}`;
}

export function createAiLabWatchAdapter(rawDir: string = DEFAULT_RAW_DIR): ScorecardSourceAdapter {
  return {
    source: SOURCE_KEY,
    name: "AI Lab Watch",

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
          notes:
            data.notes ??
            "AI Lab Watch was frozen by its author in September 2025. " +
              "This snapshot reflects the last published state.",
          isLatest: data.isLatest ?? id === latestId,
          // The defining quirk of this source — the snapshot row carries
          // the "no longer maintained" signal so the directory can render it.
          sourceActive: false,
        };
      });
    },

    parseGrades(snapshot: RawSnapshot): RawGrade[] {
      const waves = loadWaves(rawDir);
      const wave = waves.find((w) => snapshotId(w.waveSlug) === snapshot.id);
      if (!wave) {
        throw new Error(
          `[ailabwatch] cannot parse grades for snapshot "${snapshot.id}" — raw file missing`,
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
              `[ailabwatch] org "${g.org}" has score for unknown dimension "${slug}"`,
            );
          }
          const numeric = parsePercent(value);
          out.push({
            snapshotId: snapshot.id,
            orgName: g.org,
            orgAliases: g.aliases,
            dimensionSlug: slug,
            dimensionLabel: isOverall ? "Overall" : dim!.label,
            dimensionWeight: isOverall ? null : (dim!.weight ?? null),
            dimensionParentSlug: null,
            scoreNumeric: numeric,
            scoreLetter: percentToBand(numeric),
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

export const aiLabWatchAdapter = createAiLabWatchAdapter();
