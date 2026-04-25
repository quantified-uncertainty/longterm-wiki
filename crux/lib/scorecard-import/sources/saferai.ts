/**
 * SaferAI Ratings adapter (QUA-698).
 *
 * https://ratings.safer-ai.org
 *
 * Format: continuously-updated ratings across four risk-management pillars
 * (risk identification, analysis & evaluation, treatment, governance) plus
 * an overall percentage / letter band per developer (~12 frontier orgs).
 *
 * SaferAI's site is a JS app — wave-by-wave HTML scraping is brittle, so
 * we mirror the FLI pattern: cache an extracted JSON snapshot in
 * `data/scorecards/raw/saferai/<wave>/grades.json`. Re-snapshots are
 * captured monthly by re-running the manual `extract` step against the
 * site's current state. Each snapshot is a point-in-time mirror.
 *
 * The shape on disk is identical to FLI's wave file (see fli.ts) with
 * percentage scores instead of letter grades — `scoreRaw` is the
 * verbatim "73%" string and `scoreNumeric` the 0-100 number. A derived
 * letter band ("Strong" / "Moderate" / "Weak" / "Very Weak") is computed
 * by the adapter and surfaced as `scoreLetter` for matrix display
 * consistency with FLI.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import type {
  RawSnapshot,
  RawGrade,
  ScorecardSourceAdapter,
} from "../types.ts";

const SOURCE_KEY = "saferai";
const DEFAULT_RAW_DIR = resolve("data/scorecards/raw/saferai");

interface SaferAIDimension {
  slug: string;
  label: string;
  /** Optional weight (0-1). SaferAI publishes pillar weights. */
  weight?: number | null;
}

interface SaferAIWaveFile {
  publishedAt: string;
  waveLabel: string;
  sourceUrl: string;
  methodologyUrl?: string | null;
  license?: string | null;
  notes?: string | null;
  isLatest?: boolean;
  dimensions: SaferAIDimension[];
  grades: Array<{
    org: string;
    aliases?: string[];
    /** dimensionSlug → percent string (e.g. "73%") or "N/A". */
    scores: Record<string, string>;
    sourceUrls?: Record<string, string>;
  }>;
}

function loadWaves(rawDir: string): Array<{ waveSlug: string; data: SaferAIWaveFile }> {
  if (!existsSync(rawDir)) return [];
  const out: Array<{ waveSlug: string; data: SaferAIWaveFile }> = [];
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(rawDir, entry.name, "grades.json");
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, "utf8")) as SaferAIWaveFile;
    validateWave(entry.name, data);
    out.push({ waveSlug: entry.name, data });
  }
  out.sort((a, b) => a.data.publishedAt.localeCompare(b.data.publishedAt));
  return out;
}

function validateWave(waveSlug: string, data: SaferAIWaveFile): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.publishedAt)) {
    throw new Error(
      `saferai/${waveSlug}/grades.json: publishedAt must be YYYY-MM-DD, got "${data.publishedAt}"`,
    );
  }
  if (!data.sourceUrl) {
    throw new Error(`saferai/${waveSlug}/grades.json: sourceUrl is required`);
  }
  if (!Array.isArray(data.dimensions) || data.dimensions.length === 0) {
    throw new Error(`saferai/${waveSlug}/grades.json: dimensions[] required`);
  }
  if (!Array.isArray(data.grades) || data.grades.length === 0) {
    throw new Error(`saferai/${waveSlug}/grades.json: grades[] required`);
  }
  const dimSlugs = new Set(data.dimensions.map((d) => d.slug));
  for (const g of data.grades) {
    if (!g.org) {
      throw new Error(`saferai/${waveSlug}/grades.json: grade missing org`);
    }
    if (g.scores.overall == null) {
      throw new Error(
        `saferai/${waveSlug}/grades.json: org "${g.org}" missing overall score`,
      );
    }
    for (const slug of Object.keys(g.scores)) {
      if (slug !== "overall" && !dimSlugs.has(slug)) {
        throw new Error(
          `saferai/${waveSlug}/grades.json: org "${g.org}" has score for unknown dimension "${slug}"`,
        );
      }
    }
  }
}

function snapshotId(waveSlug: string): string {
  return `${SOURCE_KEY}-${waveSlug}`;
}

/**
 * Parse a SaferAI percent string into a 0-100 number. Handles plain
 * percentages ("73%"), decimal-prefixed ("73.5%"), and "N/A" / "—".
 * Returns null when unparseable; scoreRaw still preserves the verbatim
 * source text either way.
 */
export function parsePercent(s: string): number | null {
  const m = /^([\d.]+)\s*%?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * SaferAI does not publish discrete letter bands, but the matrix display
 * is letter-first. Map the percentage into a 4-band qualitative label
 * for display consistency with FLI. Thresholds match SaferAI's own
 * "Weak / Moderate / Strong" coloring on the site.
 */
export function percentToBand(pct: number | null): string | null {
  if (pct == null) return null;
  if (pct >= 75) return "Strong";
  if (pct >= 50) return "Moderate";
  if (pct >= 25) return "Weak";
  return "Very Weak";
}

export function createSaferaiAdapter(rawDir: string = DEFAULT_RAW_DIR): ScorecardSourceAdapter {
  return {
    source: SOURCE_KEY,
    name: "SaferAI Ratings",

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
          `[saferai] cannot parse grades for snapshot "${snapshot.id}" — raw file missing`,
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
              `[saferai] org "${g.org}" has score for unknown dimension "${slug}"`,
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

export const saferaiAdapter = createSaferaiAdapter();
